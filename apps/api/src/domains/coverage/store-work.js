import { tx } from "@sunpride/db/client";
import {
  requireCapability,
  requireNationalScope,
} from "../../core/capabilities.js";
import { writeAudit } from "../org/audit.js";
import {
  access,
  bounded,
  fail,
  loadPlan,
  outletAt,
  required,
  uuid,
} from "./model.js";

/** No title-to-form inference: these are self-reported tasks, not money or productive-call evidence.
 * @param {any} db @param {any} selection */
export async function resolveStoreWork(db, selection) {
  if (selection == null) return { activities: [] };
  if (typeof selection !== "object" || Array.isArray(selection))
    fail("Invalid store activities");
  let routine = null;
  if (selection.routineId) {
    [routine] =
      await db`select *,array_to_json(activity_ids) as activity_ids from store_work_routines where id=${uuid(selection.routineId)} and active for share`;
    if (!routine) fail("Routine is no longer active; choose another routine");
  }
  if (
    selection.activities !== undefined &&
    !Array.isArray(selection.activities)
  )
    fail("Invalid store activities");
  const extras =
    selection.activityIds ??
    selection.activities?.map((/** @type {any} */ a) => a?.activityId) ??
    [];
  if (
    !Array.isArray(extras) ||
    extras.length > 50 ||
    new Set(extras).size !== extras.length
  )
    fail("Choose up to 50 different activities");
  extras.forEach(uuid);
  const ids = [...new Set([...(routine?.activity_ids ?? []), ...extras])];
  if (ids.length > 50) fail("Choose up to 50 different activities");
  const rows = ids.length
    ? await db`select id,name from store_activity_definitions where id in ${db(ids)} and active for share`
    : [];
  if (rows.length !== ids.length)
    fail("An activity is no longer active; update the stop or routine");
  return {
    ...(routine
      ? {
          routineId: routine.id,
          routineName: routine.name,
          routineActivityIds: routine.activity_ids,
        }
      : {}),
    activityIds: extras,
    activities: ids.map((id) => ({
      activityId: id,
      name: rows.find((/** @type {any} */ a) => a.id === id).name,
    })),
  };
}
/** @param {any} ctx */
export async function storeWorkCatalog(ctx) {
  await requireCapability(ctx, "mcp.read");
  let canManage = false;
  try {
    await requireNationalScope(ctx, ["admin", "operations"]);
    canManage = true;
  } catch {
    /* Read-only picker remains available. */
  }
  return {
    canManage,
    activities: bounded(
      await ctx.db`select id as "activityId",name,active from store_activity_definitions order by name,id limit 501`,
      "Activities",
    ),
    routines: bounded(
      await ctx.db`select id as "routineId",name,array_to_json(activity_ids) as "activityIds",active from store_work_routines order by name,id limit 501`,
      "Routines",
    ),
  };
}
/** @param {any} ctx @param {string} kind */
export async function saveStoreMaster(ctx, kind) {
  return tx(ctx.db, async (db) => {
    const c = { ...ctx, db };
    await requireNationalScope(c, ["admin", "operations"]);
    const b = ctx.body;
    if (!b || typeof b !== "object" || Array.isArray(b))
      fail("Enter activity or routine details");
    const name = required(b.name, "Name");
    if (name.length > 200 || typeof b.active !== "boolean")
      fail("Enter a name up to 200 characters and an active choice");
    const reason = required(b.reason, "Reason");
    await db`select pg_advisory_xact_lock(hashtext('store-work-masters'))`;
    const table =
      kind === "activity"
        ? "store_activity_definitions"
        : "store_work_routines";
    const id = b.id ? uuid(b.id) : crypto.randomUUID();
    const [before] = await db.unsafe(
      `select * from ${table} where id=$1 for update`,
      [id],
    );
    if (b.id && !before) fail("Activity or routine not found");
    const [duplicate] = await db.unsafe(
      `select id from ${table} where lower(name)=lower($1) and id<>$2`,
      [name, id],
    );
    if (duplicate) fail("That name is already used");
    if (!before) {
      const [{ n }] = await db.unsafe(
        `select count(*)::int as n from ${table}`,
      );
      if (n >= 500) fail("This list supports up to 500 entries");
    }
    if (kind === "activity") {
      await db`insert into store_activity_definitions(id,name,active,updated_by) values (${id},${name},${b.active},${ctx.actor.subject}) on conflict(id) do update set name=excluded.name,active=excluded.active,updated_by=excluded.updated_by,updated_at=now()`;
    } else {
      if (!Array.isArray(b.activityIds) || !b.activityIds.length)
        fail("Choose at least one activity");
      // Archived routines may retain archived members; reactivating requires active members.
      if (b.active) await resolveStoreWork(db, { activityIds: b.activityIds });
      else {
        if (
          b.activityIds.length > 50 ||
          new Set(b.activityIds).size !== b.activityIds.length
        )
          fail("Invalid routine activities");
        b.activityIds.forEach(uuid);
        const rows =
          await db`select id from store_activity_definitions where id in ${db(b.activityIds)}`;
        if (rows.length !== b.activityIds.length) fail("Activity not found");
      }
      await db`insert into store_work_routines(id,name,activity_ids,active,updated_by) values (${id},${name},${db.array(b.activityIds, "UUID")},${b.active},${ctx.actor.subject}) on conflict(id) do update set name=excluded.name,activity_ids=excluded.activity_ids,active=excluded.active,updated_by=excluded.updated_by,updated_at=now()`;
    }
    await writeAudit(db, {
      subject: ctx.actor.subject,
      action: `store_work.${kind}.saved`,
      entityType: table,
      entityId: id,
      details: {
        reason,
        before: before
          ? {
              name: before.name,
              active: before.active,
              activityIds: before.activity_ids,
            }
          : null,
        after: {
          name,
          active: b.active,
          ...(kind === "routine" ? { activityIds: b.activityIds } : {}),
        },
      },
    });
    return { id };
  });
}
/** Plan-scoped planned-versus-actual; every tick retains actor/time in visit_activities.
 * @param {any} ctx @param {string} planId */
export async function storeWorkResults(ctx, planId) {
  const p = await loadPlan(ctx.db, planId);
  await access(ctx, p);
  const rows = bounded(
    await ctx.db`select distinct on (v.slot_id,a.activity->>'activityId') a.activity,v.slot_id,v.outlet_id,a.visit_id,a.server_time from visit_activities a join visit_executions v on v.id=a.visit_id where v.plan_id=${p.id} and v.deleted_at is null and a.deleted_at is null and a.activity_kind='planned_activity' order by v.slot_id,a.activity->>'activityId',a.server_time desc,a.change_seq desc,a.id desc limit 10001`,
    "Recorded store activities",
    10000,
  );
  for (const id of new Set(rows.map((/** @type {any} */ r) => r.outlet_id)))
    await outletAt(ctx, id, ctx.now);
  return rows.map((/** @type {any} */ r) => ({
    slotId: r.slot_id,
    visitId: r.visit_id,
    activityId: r.activity.activityId,
    done: r.activity.done,
    recordedAt: +new Date(r.server_time),
  }));
}
/** @param {any} router @param {any} platform */
export function installStoreWork(router, platform) {
  router.get("/api/v1/store-work/catalog", (/** @type {any} */ c) =>
    tx(c.db, (db) => storeWorkCatalog({ ...c, db })),
  );
  router.get("/api/v1/store-work/results", (/** @type {any} */ c) =>
    tx(c.db, (db) =>
      storeWorkResults({ ...c, db }, c.url.searchParams.get("planId")),
    ),
  );
  for (const kind of ["activity", "routine"])
    router.post(`/api/v1/store-work/${kind}`, async (/** @type {any} */ c) => {
      const result = await saveStoreMaster(c, kind);
      await platform.publish("coverage");
      return result;
    });
}
