import { requireCapability, roleHas } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { access, employeeAt, fail, manilaDate } from "./model.js";
import { mcpDeadlines, deadlineState } from "./deadlines.js";
/** @param {any} ctx @param {any} p */
export async function approvalRoute(ctx, p) {
  const db = ctx.db,
    at = new Date(ctx.now);
  const a = await employeeAt(db, p.assignee_profile_id, ctx.now);
  const [s] = a.supervisor_id
    ? await db`select * from profiles where id=${a.supervisor_id}`
    : [];
  const [sa] = s
    ? await db`select * from employee_assignments where profile_id=${s.id} and deleted_at is null and effective_from<=${at} and (effective_to is null or effective_to>${at})`
    : [];
  const [away] = s
    ? await db`select * from supervisor_away_periods where profile_id=${s.id} and effective_from<=${at} and effective_to>${at}`
    : [];
  const [backup] = sa?.supervisor_id
    ? await db`select * from profiles where id=${sa.supervisor_id}`
    : [];
  return {
    supervisor: s,
    backup,
    away,
    supervisorUnitId: sa?.org_unit_id ?? s?.org_unit_id,
    supervisorAvailable: s?.status === "active" && !away,
  };
}
/** @param {any} ctx @param {any} p */
export async function approvalCapacity(ctx, p) {
  const actor = await access(ctx, p, "mcp.approve");
  if (
    actor.profileId === p.assignee_profile_id ||
    actor.subject === p.prepared_by ||
    actor.subject === p.submitted_by
  )
    fail("Independent approver required");
  const r = await approvalRoute(ctx, p);
  if (!r.supervisor) return { capacity: "scope_approver", onBehalfOf: null };
  if (r.supervisor.id === actor.profileId)
    return { capacity: "supervisor", onBehalfOf: null };
  if (r.supervisorAvailable)
    fail(
      "The direct supervisor approves this MCP; backup approval applies only while the supervisor is away",
    );
  if (r.backup) {
    if (r.backup.status !== "active" || r.backup.id !== actor.profileId)
      fail(
        "While the supervisor is away, only the supervisor's manager approves this MCP",
      );
  } else {
    if (!r.supervisorUnitId) fail("Supervisor scope is not configured");
    await requireCapability(ctx, "mcp.approve", r.supervisorUnitId);
    if (actor.orgUnitId === r.supervisorUnitId)
      fail("Backup approval needs an approver above the supervisor's unit");
  }
  return { capacity: "backup", onBehalfOf: r.supervisor.id };
}
/** @param {any} ctx @param {any} p */
export async function approvalView(ctx, p) {
  await access(ctx, p);
  const r = await approvalRoute(ctx, p);
  let viewerCapacity, viewerBlockedReason;
  try {
    viewerCapacity = (await approvalCapacity(ctx, p)).capacity;
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    viewerBlockedReason = e.message;
  }
  const name = async (/** @type {string} */ id) =>
    id
      ? ((await ctx.db`select name from profiles where id=${id}`)[0]?.name ??
        "Former user")
      : undefined;
  const timing = deadlineState(mcpDeadlines(p.local_month), p, ctx.now);
  return {
    supervisorName: r.supervisor?.name,
    supervisorAway: !!r.supervisor && !r.supervisorAvailable,
    awayUntilDate: r.away
      ? manilaDate(+new Date(r.away.effective_to) - 86400000)
      : undefined,
    backupName: r.backup?.name,
    backupRule: r.backup
      ? "recorded_manager"
      : r.supervisor
        ? "scope_above"
        : "none",
    viewerCapacity,
    viewerBlockedReason,
    viewerIsBackupManager: r.backup?.id === ctx.actor.profileId,
    supervisorProfileId: r.supervisor?.id,
    approvedCapacity: p.approval_capacity,
    approverName: await name(p.approver_profile_id),
    onBehalfOfName: await name(p.approved_on_behalf_of_profile_id),
    deadlines: mcpDeadlines(p.local_month),
    deadlineState: p.based_on_plan_id ? undefined : timing.state,
    submittedLate: !p.based_on_plan_id && timing.submittedLate,
    approvedLate: !p.based_on_plan_id && timing.approvedLate,
  };
}
/** @param {any} ctx @param {string} profileId */
export async function awayAccess(ctx, profileId) {
  const actor = await requireCapability(ctx, "mcp.approve");
  const a = await employeeAt(ctx.db, profileId, ctx.now);
  await requireCapability(ctx, "mcp.approve", a.org_unit_id);
  const [p] =
    await ctx.db`select role,status from profiles where id=${profileId}`;
  if (p?.status !== "active" || !roleHas(p.role, "mcp.approve"))
    fail("Active MCP approver required");
  if (
    actor.profileId !== profileId &&
    actor.profileId !== a.supervisor_id &&
    actor.role !== "super_admin"
  )
    fail("Only the supervisor or their manager can do this");
}
