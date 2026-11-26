import { requireCapability } from "../../core/capabilities.js";
import { reauthorizeDevice } from "../../core/devices.js";
import { ApiError } from "../../core/errors.js";
import { isPlainObject } from "../../core/util.js";
import { currentActor } from "../van/access.js";
import { scopeFilterForActor } from "../org/scope.js";
import { integer, rule, uuid } from "../org/model.js";

/** Storage shape only: deliberately accepts blank and partly typed enrollment values. @param {any} p */
function draftProfile(p) {
  if (!isPlainObject(p) || JSON.stringify(p).length > 100000)
    rule("Send the draft details.");
  /** @type {Record<string, any>} */ const out = {};
  for (const key of ["form", "details", "customFields"]) {
    const values = p[key] ?? {};
    if (!isPlainObject(values) || Object.keys(values).length > 200)
      rule("Send the draft details.");
    for (const value of Object.values(values))
      if (typeof value !== "string" || value.length > 2000)
        rule("Send text in the draft fields.");
    out[key] = values;
  }
  for (const key of [
    "shipToParty",
    "shipToAddress",
    "shipToMobileNo",
    "shipToEmail",
  ]) {
    if (
      p[key] !== undefined &&
      (typeof p[key] !== "string" || p[key].length > 2000)
    )
      rule("Send text in the draft fields.");
    if (p[key] !== undefined) out[key] = p[key];
  }
  out.sameAsCustomer = p.sameAsCustomer !== false;
  out.photoPresent = p.photoPresent === true;
  if (
    isPlainObject(p.fix) &&
    Number.isFinite(p.fix.latitude) &&
    Number.isFinite(p.fix.longitude)
  )
    out.fix = { latitude: p.fix.latitude, longitude: p.fix.longitude };
  return out;
}

/** No customer validation here: unfinished and invalid text must remain drafts.
 * The structural/size bounds protect storage, not enrollment completeness.
 * @param {any} ctx */
export async function shareCustomerDraft(ctx) {
  const actor = await currentActor(ctx.db, ctx.actor);
  const { device } = await reauthorizeDevice(ctx.db, actor, ctx.device.id);
  if (ctx.app !== "field-android" || device.app !== ctx.app)
    throw new ApiError("forbidden", 403, "Use the Field app.");
  await requireCapability(
    { ...ctx, actor },
    "outlet.enrol.propose",
    actor.orgUnitId,
  );
  const p = ctx.payload;
  const id = uuid(p.draftId);
  const revision = integer(p.revision, 1, Number.MAX_SAFE_INTEGER);
  if (!["save", "discard"].includes(p.action)) rule("Choose a draft action.");
  const profile = p.action === "save" ? draftProfile(p.profile) : {};
  const [prior] =
    await ctx.db`select actor_profile_id from customer_enrollment_drafts where device_id=${device.id} and draft_id=${id} for update`;
  if (prior && prior.actor_profile_id !== actor.profileId)
    throw new ApiError(
      "forbidden",
      403,
      "This draft belongs to another person.",
    );
  await ctx.db`insert into customer_enrollment_drafts(device_id,draft_id,actor_profile_id,org_unit_id,revision,status,profile)
    values(${device.id},${id},${actor.profileId},${actor.orgUnitId},${revision},${p.action === "save" ? "draft" : "discarded"},${profile})
    on conflict(device_id,draft_id) do update set revision=excluded.revision,status=excluded.status,profile=excluded.profile,org_unit_id=excluded.org_unit_id,updated_at=now()
    where customer_enrollment_drafts.status<>'submitted' and customer_enrollment_drafts.revision<excluded.revision`;
  ctx.publish("masters");
  return { entityId: id, eventIds: [] };
}

/** The capture and its closed-draft marker commit together; a delayed draft save cannot reopen it.
 * @param {any} ctx @param {unknown} draftId */
export async function submittedCustomerDraft(ctx, draftId) {
  if (draftId === undefined) return;
  const id = uuid(draftId);
  const [prior] =
    await ctx.db`select actor_profile_id from customer_enrollment_drafts where device_id=${ctx.device.id} and draft_id=${id} for update`;
  if (prior && prior.actor_profile_id !== ctx.actor.profileId)
    throw new ApiError(
      "forbidden",
      403,
      "This draft belongs to another person.",
    );
  await ctx.db`insert into customer_enrollment_drafts(device_id,draft_id,actor_profile_id,org_unit_id,revision,status,profile)
    values(${ctx.device.id},${id},${ctx.actor.profileId},${ctx.actor.orgUnitId},1,'submitted','{}')
    on conflict(device_id,draft_id) do update set status='submitted',profile='{}',updated_at=now()`;
}

/** Separate read-only office list: these IDs never identify an approvable outlet.
 * @param {any} ctx */
export async function listCustomerDrafts(ctx) {
  await requireCapability(ctx, "outlet.read");
  if (!["super_admin", "admin", "manager", "approver"].includes(ctx.actor.role))
    throw new ApiError(
      "forbidden",
      403,
      "Only administrators and approvers can view customer drafts.",
    );
  const { unitIds } = await scopeFilterForActor(ctx.db, ctx.actor);
  const offset = integer(
    Number(ctx.url.searchParams.get("offset") ?? 0),
    0,
    1000000,
  );
  const rows =
    await ctx.db`select d.draft_id as id,d.profile,p.name as "addedByName",d.updated_at as "updatedAt"
    from customer_enrollment_drafts d join profiles p on p.id=d.actor_profile_id
    where d.status='draft' and (${unitIds === null} or d.org_unit_id::text=any(${ctx.db.array(unitIds ?? [], "TEXT")}))
    order by d.updated_at desc,d.draft_id,d.device_id limit 51 offset ${offset}`;
  return {
    rows: rows.slice(0, 50).map((/** @type {any} */ r) => ({
      id: r.id,
      profile: r.profile,
      addedByName: r.addedByName,
      updatedAt: new Date(r.updatedAt).getTime(),
      status: "draft",
      canApprove: false,
    })),
    hasMore: rows.length > 50,
  };
}
