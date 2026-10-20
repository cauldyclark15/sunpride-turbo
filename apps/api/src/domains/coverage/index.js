import { tx } from "@sunpride/db/client";
import { requireCapability, roleHas } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { enqueue } from "../../core/jobs.js";
import { hooks } from "../../core/hooks.js";
import { enqueueRefresh } from "../analytics/refresh.js";
import { activate } from "./activation.js";
import { awayAccess } from "./approval.js";
import { awayBounds } from "./deadlines.js";
import {
  access,
  DAY,
  dto,
  employeeAt,
  fail,
  loadPlan,
  localDate,
  manilaDate,
  required,
  uuid,
} from "./model.js";
import { read } from "./reads.js";
import { digest, workflow } from "./workflow.js";
import { installPjp } from "./pjp.js";
import { readAdherence } from "./adherence.js";
import { installProductivePolicies } from "../visits/productive-policies.js";
import { installWorkforce } from "./workforce.js";

const reads = [
  "permissions",
  "profile",
  "lookup/territories",
  "lookup/routes",
  "lookup/route",
  "lookup/outlets",
  "lookup/outlet",
  "lookup/roster",
  "summary",
  "people",
  "plans/list",
  "plans/detail",
  "discovery/list",
  "discovery/attribution",
  "calendar/status",
  "calendar/approvalView",
  "activation/plannedForMonth",
  "routines/listForPosition",
  "away/list",
  "history/list",
  "views/filterOptions",
  "views/calendar",
  "views/byRoute",
  "views/workload",
  "map/forPlan",
  "exceptions/forPlan",
  "exports/schedule",
  "review",
];
const commands = [
  "plans/create",
  "plans/createRevision",
  "plans/saveOutlets",
  "plans/saveSlots",
  "plans/setAssignment",
  "plans/submit",
  "plans/returnPlan",
  "plans/approve",
  "activation/activate",
  "routines/applyToDraft",
  "away/record",
  "away/end",
];
/** @param {any} ctx @param {any} b @param {string} action */
async function away(ctx, b, action) {
  const db = ctx.db;
  if (action === "record") {
    await awayAccess(ctx, uuid(b.profileId));
    const { from, to } = awayBounds(b.fromDate, b.toDate);
    required(b.reason, "Away reason");
    if (
      from < localDate(manilaDate(ctx.now)) ||
      to <= from ||
      to - from > 92 * DAY
    )
      fail("Away period must be prospective and at most 92 days");
    await db`select pg_advisory_xact_lock(hashtextextended(${`coverage:away:${b.profileId}`},0))`;
    const [overlap] =
      await db`select id from supervisor_away_periods where profile_id=${b.profileId} and effective_from<${new Date(to)} and effective_to>${new Date(from)}`;
    if (overlap) fail("Overlaps an existing away period");
    const [r] =
      await db`insert into supervisor_away_periods(organization_id,profile_id,effective_from,effective_to,reason,recorded_by,recorded_at) values ('sunpride',${b.profileId},${new Date(from)},${new Date(to)},${b.reason.trim()},${ctx.actor.subject},${new Date(ctx.now)}) returning *`;
    await db`insert into coverage_away_events(away_id,profile_id,actor_subject,action,before,after,created_at) values (${r.id},${r.profile_id},${ctx.actor.subject},'recorded',${{}},${dto(r)},${new Date(ctx.now)})`;
    return dto(r);
  }
  const [r] =
    await db`select * from supervisor_away_periods where id=${uuid(b.awayId)} for update`;
  if (!r) fail("Away period not found");
  await awayAccess(ctx, r.profile_id);
  if (r.ended_at) fail("Away period already ended");
  const [result] =
    await db`update supervisor_away_periods set effective_to=${new Date(Math.max(+new Date(r.effective_from), ctx.now))},ended_at=${new Date(ctx.now)},ended_by=${ctx.actor.subject} where id=${r.id} returning *`;
  await db`insert into coverage_away_events(away_id,profile_id,actor_subject,action,before,after,created_at) values (${r.id},${r.profile_id},${ctx.actor.subject},'ended',${dto(r)},${dto(result)},${new Date(ctx.now)})`;
  return dto(result);
}
/** Public command entry, also used by the fixed-clock integration tests. @param {any} ctx @param {any} platform @param {string} path @param {any} body */
export async function command(ctx, platform, path, body) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ApiError(
      "invalid_request",
      400,
      "Coverage command must be an object",
    );
  const key = required(body.idempotencyKey, "Idempotency key");
  const hash = digest({ path, body });
  const result = await tx(ctx.db, async (db) => {
    if (!ctx.actor)
      throw new ApiError("unauthenticated", 401, "Sign in required");
    const [profile] =
      await db`select * from profiles where id=${ctx.actor.profileId} and user_id=${ctx.actor.userId} and status='active' and deleted_at is null for share`;
    if (!profile)
      throw new ApiError("forbidden", 403, "Your access is no longer active");
    const c = {
      ...ctx,
      db,
      actor: {
        ...ctx.actor,
        role: profile.role,
        orgUnitId: profile.org_unit_id,
      },
    };
    const cap =
      path.startsWith("away/") ||
      path.endsWith("/approve") ||
      path.endsWith("/returnPlan") ||
      path.endsWith("/activate")
        ? "mcp.approve"
        : "mcp.plan";
    const actor = await requireCapability(c, cap);
    if (body.planId) await access(c, await loadPlan(db, body.planId), cap);
    else if (body.assigneeProfileId) {
      const a = await employeeAt(db, body.assigneeProfileId, c.now);
      await requireCapability(c, cap, a.org_unit_id);
      if (actor.role === "sales" && actor.profileId !== body.assigneeProfileId)
        fail("Sales may create only own plan");
    } else if (body.profileId) await awayAccess(c, body.profileId);
    else if (body.awayId) {
      const [a] =
        await db`select profile_id from supervisor_away_periods where id=${uuid(body.awayId)}`;
      if (!a) fail("Away period not found");
      await awayAccess(c, a.profile_id);
    }
    await db`select pg_advisory_xact_lock(hashtextextended(${`coverage:command:${actor.profileId}:${key}`},0))`;
    const [existing] =
      await db`select * from coverage_commands where actor_id=${actor.profileId} and command_key=${key}`;
    if (existing) {
      if (existing.payload_hash !== hash)
        throw new ApiError(
          "idempotency_conflict",
          409,
          "This command key was already used for different content",
        );
      return existing.response;
    }
    /** @type {any[]} */ const changes = [];
    const commandPlatform = {
      ...platform,
      recordChange: async (
        /** @type {any} */ _db,
        /** @type {any} */ change,
      ) => {
        changes.push(change);
      },
    };
    let response;
    if (path === "activation/activate")
      response = await activate(
        c,
        await loadPlan(db, body.planId, true),
        commandPlatform,
      );
    else if (path.startsWith("away/"))
      response = await away(c, body, path.split("/")[1]);
    else response = await workflow(c, path.split("/")[1], body);
    await db`insert into coverage_commands(actor_id,command_key,payload_hash,response) values (${actor.profileId},${key},${hash},${response})`;
    const planId = response?._id ?? body.planId;
    if (planId && !path.startsWith("away/")) {
      const p = await loadPlan(db, planId);
      changes.push({
        entity: "coverage_plans",
        entityId: planId,
        scopeKey: p.org_unit_id,
      });
    }
    for (const change of changes) await platform.recordChange(db, change);
    return response;
  });
  await ctx.publish("coverage");
  return result;
}
/** @param {import('../../core/router.js').Router} router @param {any} platform */
export function install(router, platform) {
  installPjp(router, platform);
  installProductivePolicies(router, platform);
  installWorkforce(router, platform);
  router.get("/api/v1/coverage/adherence", (c) =>
    tx(c.db, (db) =>
      readAdherence({ ...c, db }, Object.fromEntries(c.url.searchParams)),
    ),
  );
  platform.registerTopic(
    "coverage",
    /** @param {any} a */ (a) => roleHas(a.role, "mcp.read"),
  );
  for (const action of reads)
    router.get(`/api/v1/coverage/${action}`, async (c) => {
      let b = Object.fromEntries(c.url.searchParams);
      if (c.url.searchParams.has("input")) {
        try {
          b = JSON.parse(c.url.searchParams.get("input") ?? "{}");
        } catch {
          throw new ApiError("invalid_request", 400, "Invalid coverage query");
        }
      }
      return tx(c.db, (db) => read({ ...c, db }, action, b));
    });
  for (const path of commands)
    router.post(`/api/v1/coverage/${path}`, (c) =>
      command(c, platform, path, c.body ?? {}),
    );
  platform.registerJob("coverage.activation", async (/** @type {any} */ c) => {
    if (c.payload.planId) {
      await activateOne(platform, c.payload.planId, Date.now());
      await platform.publish("coverage");
    } else await activateDue(platform);
  });
  platform.registerJob("coverage.refresh", async (/** @type {any} */ c) =>
    enqueueRefresh(
      { ...c, ...platform },
      { kind: "visit", date: c.payload.date, unitId: c.payload.unitId },
    ),
  );
  platform.scheduler.every(60000, "coverage.activation", () =>
    activateDue(platform),
  );
}
/** @param {any} platform @param {string} id @param {number} now */
async function activateOne(platform, id, now) {
  return tx(platform.db, async (db) => {
    const plan = await loadPlan(db, id, true);
    if (plan.status !== "approved") return;
    await activate({ db, actor: null, now }, plan, platform);
  });
}
/** @param {any} platform @param {number} [now] */
export async function activateDue(platform, now = Date.now()) {
  const plans =
    await platform.db`select p.id from coverage_plans p where p.status='approved' and p.effective_from<=${new Date(now)} and p.effective_to>${new Date(now)}
    and not exists(select 1 from jobs j where j.kind='coverage.activation' and j.coalesce_key=p.id::text and j.status in ('pending','running')) order by p.effective_from,p.id limit 20`;
  for (const p of plans) {
    try {
      await activateOne(platform, p.id, now);
    } catch {
      // The durable worker retains a failed plan and retries it without blocking siblings.
      await enqueue(platform.db, {
        kind: "coverage.activation",
        key: p.id,
        payload: { planId: p.id },
      });
    }
  }
  if (plans.length) await platform.publish("coverage");
}
