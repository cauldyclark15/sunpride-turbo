import { requireCapability } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { outletOwnerUnit } from "../org/scope.js";
import { ORGANIZATION, cell, dateOnly, error } from "./format.js";

/** @param {any} ctx @param {string} planId @param {boolean} [write] */
export async function planAccess(ctx, planId, write = true) {
  if (!/^[0-9a-f-]{36}$/i.test(planId ?? ""))
    throw new ApiError("invalid_format", 400, "Choose a draft route plan.");
  const [plan] =
    await ctx.db`select * from coverage_plans where organization_id=${ORGANIZATION} and id=${planId} and deleted_at is null for update`;
  if (!plan) throw new ApiError("not_found", 404, "Route plan not found.");
  const capability = write ? "mcp.plan" : "mcp.read";
  const actor = await requireCapability(ctx, capability, plan.org_unit_id);
  if (actor.role === "sales" && actor.profileId !== plan.assignee_profile_id)
    throw new ApiError("scope_denied", 403, "Choose your own route plan.");
  const [person] =
    await ctx.db`select * from profiles where id=${plan.assignee_profile_id} and status='active' and deleted_at is null`;
  if (!person?.org_unit_id)
    throw new ApiError(
      "scope_denied",
      403,
      "The plan's salesperson needs an active organizational assignment.",
    );
  await requireCapability(ctx, capability, person.org_unit_id);
  if (
    write &&
    (plan.status !== "draft" || person.org_unit_id !== plan.org_unit_id)
  )
    throw new ApiError(
      "plan_locked",
      409,
      "Only a draft in the salesperson's current unit can change.",
    );
  // Historical draft membership must not expose an outlet after transfer.
  const members =
    await ctx.db`select outlet_id from coverage_plan_outlets where plan_id=${plan.id} union select outlet_id from coverage_plan_slots where plan_id=${plan.id} and outlet_id is not null and deleted_at is null`;
  for (const member of members) {
    const owner = await outletOwnerUnit(ctx.db, member.outlet_id, ctx.now);
    if (!owner)
      throw new ApiError(
        "scope_denied",
        403,
        "A route-plan outlet no longer has an authorized owner.",
      );
    await requireCapability(ctx, capability, owner);
  }
  return { plan, person };
}
/** @param {any} ctx @param {any} input */
export async function validateMcp(ctx, input) {
  const db = ctx.db;
  const { plan, person } = await planAccess(ctx, input.planId);
  /** @type {import('./format.js').RowError[]} */
  const errors = [];
  /** @type {any[]} */
  const resolved = [];
  const seen = new Set();
  const existing =
    await db`select outlet_id from coverage_plan_outlets where plan_id=${plan.id}`;
  const slots =
    await db`select outlet_id,service_date,sequence from coverage_plan_slots where plan_id=${plan.id} and deleted_at is null`;
  const newOutlets = new Set(
    existing.map((/** @type {any} */ x) => x.outlet_id),
  );
  for (const row of input.rows) {
    const start = errors.length;
    const fail = (
      /** @type {string} */ column,
      /** @type {string} */ message,
      code = "invalid_format",
    ) => errors.push(error(row.rowNumber, code, message, column));
    const code = (/** @type {string} */ key) => cell(row, key).toUpperCase();
    const date =
      input.format === "mcp_visits"
        ? dateOnly(cell(row, "service_date"))
        : null;
    const instant = date
      ? new Date(`${date}T00:00:00+08:00`)
      : new Date(Math.max(ctx.now, new Date(plan.effective_from).getTime()));
    if (
      input.format === "mcp_visits" &&
      (!date ||
        !date.startsWith(plan.local_month) ||
        instant < new Date(plan.effective_from) ||
        instant >= new Date(plan.effective_to))
    )
      fail("service_date", "Choose a date inside this plan's effective month.");
    if (
      code("employee_code") !== String(person.employee_code ?? "").toUpperCase()
    )
      fail(
        "employee_code",
        "The employee code must match this plan's salesperson.",
        "assignment_mismatch",
      );
    const [employee] =
      await db`select * from employee_assignments where profile_id=${person.id} and effective_from<=${instant} and (effective_to is null or effective_to>${instant}) and deleted_at is null`;
    if (!employee || employee.org_unit_id !== plan.org_unit_id)
      fail(
        "employee_code",
        "The salesperson is not assigned to this unit on that date.",
        "assignment_mismatch",
      );
    const [outlet] =
      await db`select * from outlets where organization_id=${ORGANIZATION} and code=${code("outlet_code")} and status='active' and deleted_at is null`;
    const [territory] =
      await db`select * from territories where organization_id=${ORGANIZATION} and code=${code("territory_code")} and status='active' and deleted_at is null and effective_from<=${instant} and (effective_to is null or effective_to>${instant})`;
    const [route] = code("route_code")
      ? await db`select * from routes where organization_id=${ORGANIZATION} and code=${code("route_code")} and status='active' and deleted_at is null and effective_from<=${instant} and (effective_to is null or effective_to>${instant})`
      : [];
    if (!outlet)
      fail("outlet_code", "Unknown active outlet.", "unknown_reference");
    if (!territory)
      fail("territory_code", "Unknown active territory.", "unknown_reference");
    if (code("route_code") && !route)
      fail("route_code", "Unknown active route.", "unknown_reference");
    if (outlet) {
      const currentOwner = await outletOwnerUnit(db, outlet.id, ctx.now);
      if (!currentOwner)
        throw new ApiError(
          "scope_denied",
          403,
          "This outlet has no current owner.",
        );
      await requireCapability(ctx, "mcp.plan", currentOwner);
      const [assignment] =
        await db`select * from outlet_assignments where outlet_id=${outlet.id} and effective_from<=${instant} and (effective_to is null or effective_to>${instant}) and deleted_at is null`;
      if (
        assignment?.territory_id !== territory?.id ||
        (route && assignment?.route_id !== route.id)
      )
        fail(
          "outlet_code",
          "Outlet, route and territory must match on the visit date.",
          "assignment_mismatch",
        );
      if (code("customer_code")) {
        const [link] =
          await db`select c.code from outlet_customer_links l join customers c on c.id=l.customer_id where l.outlet_id=${outlet.id} and l.effective_from<=${instant} and (l.effective_to is null or l.effective_to>${instant}) and l.deleted_at is null and c.active and c.deleted_at is null`;
        if (link?.code !== code("customer_code"))
          fail(
            "customer_code",
            "This is not the outlet's effective customer account.",
            "customer_mismatch",
          );
      }
    }
    if (territory) {
      const [owner] =
        await db`select org_unit_id from territory_ownerships where territory_id=${territory.id} and effective_from<=${instant} and (effective_to is null or effective_to>${instant}) and deleted_at is null`;
      if (owner?.org_unit_id !== plan.org_unit_id)
        fail(
          "territory_code",
          "The territory is not owned by this plan's unit on that date.",
          "scope_denied",
        );
      if (route) {
        const [association] =
          await db`select territory_id from route_territories where route_id=${route.id} and effective_from<=${instant} and (effective_to is null or effective_to>${instant}) and deleted_at is null`;
        const [seller] =
          await db`select profile_id from route_salespeople where route_id=${route.id} and is_primary and effective_from<=${instant} and (effective_to is null or effective_to>${instant}) and deleted_at is null`;
        if (
          association?.territory_id !== territory.id ||
          seller?.profile_id !== person.id
        )
          fail(
            "route_code",
            "Route must belong to this territory and salesperson on that date.",
            "assignment_mismatch",
          );
      } else {
        const sellers =
          await db`select profile_id from territory_salespeople where territory_id=${territory.id} and effective_from<=${instant} and (effective_to is null or effective_to>${instant}) and deleted_at is null`;
        if (!sellers.some((/** @type {any} */ s) => s.profile_id === person.id))
          fail(
            "territory_code",
            "Territory is not assigned to this salesperson.",
            "assignment_mismatch",
          );
      }
    }
    const sequence = Number(cell(row, "sequence")),
      duration = Number(cell(row, "duration_minutes"));
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 500)
      fail("sequence", "Use a stop number from 1 to 500.");
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > 480)
      fail("duration_minutes", "Use a visit duration from 1 to 480 minutes.");
    const frequency = cell(row, "frequency").toLowerCase();
    if (!["weekly", "biweekly", "monthly", "custom"].includes(frequency))
      fail("frequency", "Use weekly, biweekly, monthly or custom.");
    const objectives = cell(row, "objectives")
      .split(";")
      .map((x) => x.trim())
      .filter(Boolean);
    if (!objectives.length)
      fail("objectives", "Enter at least one visit objective.");
    const key = `${outlet?.id}:${date ?? "roster"}`;
    if (
      seen.has(key) ||
      (date
        ? slots.some(
            (/** @type {any} */ s) =>
              s.outlet_id === outlet?.id &&
              new Date(s.service_date).toISOString().slice(0, 10) === date,
          )
        : existing.some((/** @type {any} */ e) => e.outlet_id === outlet?.id))
    )
      fail(
        "outlet_code",
        "This outlet or visit is already in the draft.",
        "duplicate_in_file",
      );
    seen.add(key);
    if (
      date &&
      (slots.some(
        (/** @type {any} */ s) =>
          new Date(s.service_date).toISOString().slice(0, 10) === date &&
          s.sequence === sequence,
      ) ||
        resolved.some((r) => r.date === date && r.sequence === sequence))
    )
      fail(
        "sequence",
        "This stop number is already used on that date.",
        "duplicate_in_file",
      );
    if (errors.length === start) {
      newOutlets.add(outlet.id);
      resolved.push({
        rowNumber: row.rowNumber,
        outlet,
        territory,
        route,
        date,
        sequence,
        duration,
        frequency,
        objectives,
      });
    }
  }
  if (
    newOutlets.size > 500 ||
    slots.length + (input.format === "mcp_visits" ? resolved.length : 0) > 500
  )
    errors.push(
      error(
        1,
        "too_many_rows",
        "A plan supports at most 500 outlets and 500 visits.",
      ),
    );
  return { errors, resolved, plan };
}
/** Explicit IMPORTS→COVERAGE transaction exception. @param {any} db @param {any} plan @param {any[]} rows @param {string} actor */
export async function writeMcp(db, plan, rows, actor) {
  const revision = plan.content_revision + 1;
  for (const r of rows) {
    const [membership] =
      await db`select id from coverage_plan_territories where coverage_plan_id=${plan.id} and territory_id=${r.territory.id} and deleted_at is null`;
    if (!membership) {
      const [last] =
        await db`select coalesce(max(ordinal),-1)+1 as ordinal from coverage_plan_territories where coverage_plan_id=${plan.id}`;
      await db`insert into coverage_plan_territories(coverage_plan_id,ordinal,territory_id) values(${plan.id},${last.ordinal},${r.territory.id})`;
    }
    await db`insert into coverage_plan_outlets(plan_id,outlet_id,route_id,territory_id,frequency,sequence,priority,expected_duration_minutes,required_objectives,content_revision,updated_by)
      values(${plan.id},${r.outlet.id},${r.route?.id ?? null},${r.territory.id},${r.frequency},${r.sequence},0,${r.duration},${db.array(r.objectives, "TEXT")},${revision},${actor}) on conflict(plan_id,outlet_id) do nothing`;
    if (r.date)
      await db`insert into coverage_plan_slots(slot_key,plan_id,assignee_profile_id,service_date,kind,outlet_id,route_id,required_objectives,sequence,expected_duration_minutes,content_revision,updated_by)
      values(${`import:${r.outlet.id}`},${plan.id},${plan.assignee_profile_id},${r.date},'outlet_visit',${r.outlet.id},${r.route?.id ?? null},${db.array(r.objectives, "TEXT")},${r.sequence},${r.duration},${revision},${actor})`;
  }
  await db`update coverage_plans set content_revision=${revision},content_hash=null,updated_by=${actor} where id=${plan.id}`;
  await db`insert into coverage_audit_events(plan_id,assignee_profile_id,org_unit_id,local_month,actor_subject,action,affected_entity,plan_version,after) values(${plan.id},${plan.assignee_profile_id},${plan.org_unit_id},${plan.local_month},${actor},'import','coverage_plan',${plan.version},${{ rows: rows.length, revision }})`;
}
