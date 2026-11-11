import {
  requireCapability,
  requireNationalScope,
  ASSIGNABLE_ROLES,
} from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import {
  activeAt,
  code,
  dto,
  get,
  history,
  insert,
  instant,
  integer,
  ms,
  overlaps,
  replaceInterval,
  required,
  rule,
  update,
  uuid,
} from "./model.js";
import {
  outletOwnerUnit,
  personAt,
  subtree,
  territoryOwnerUnit,
  topology,
} from "./scope.js";
import { access } from "./readers.js";

/** @typedef {import('./model.js').Ctx} Ctx */
/** @typedef {import('./model.js').Row} Row */
/** @param {Ctx} c @param {string} id @param {number} at @param {number} [to] */
export async function activeUnit(c, id, at, to = Infinity) {
  const unit = await get(c.db, "org_units", id);
  if (
    !activeAt(unit, at) ||
    unit.status !== "active" ||
    (ms(unit.effective_to) ?? Infinity) < to
  )
    rule("Unit does not cover effective interval");
  return unit;
}
/** @param {Ctx} c @param {string} childType @param {string} parentId @param {number} at @param {number} [to] */
async function parentFor(c, childType, parentId, at, to) {
  const parent = await activeUnit(c, parentId, at, to);
  const [child] =
    await c.db`select * from org_unit_types where code=${childType} and organization_id='sunpride' and active`;
  const [type] =
    await c.db`select * from org_unit_types where code=${parent.type_code} and organization_id='sunpride' and active`;
  if (!child || !type || child.level <= type.level)
    rule("Invalid parent level");
  return parent;
}
/** @param {Ctx} c @param {'create'|'edit'|'reparent'|'deactivate'} action @param {Row} b */
export async function orgCommand(c, action, b) {
  const at = action === "deactivate" ? b.effectiveTo : b.effectiveFrom;
  if (action !== "edit") instant(at, c.now);
  const actor = await requireCapability(
    c,
    "admin.manage",
    action === "create" ? uuid(b.parentId) : uuid(b.unitId),
  );
  const reason = required(b.reason, "Reason");
  if (action === "create") {
    await parentFor(c, b.typeCode, b.parentId, at);
    const row = await insert(c.db, "org_units", {
      organization_id: "sunpride",
      code: code(b.code),
      name: required(b.name, "Name", 200),
      type_code: b.typeCode,
      parent_id: at <= c.now ? b.parentId : null,
      status: "active",
      effective_from: instant(at),
    });
    await insert(c.db, "org_unit_parent_edges", {
      unit_id: row.id,
      parent_id: b.parentId,
      effective_from: instant(at),
      actor_subject: actor.subject,
      reason,
    });
    await topology(c.db, at);
    return row.id;
  }
  const unit = await get(c.db, "org_units", b.unitId);
  if (action === "edit") {
    await update(c.db, "org_units", unit.id, {
      name: required(b.name, "Name", 200),
    });
    return null;
  }
  if (
    unit.code === "SUNPRIDE" ||
    unit.status !== "active" ||
    ms(unit.effective_from) >= at
  )
    rule("Unit cannot be changed");
  if (action === "reparent") {
    await requireCapability(c, "admin.manage", uuid(b.parentId));
    await parentFor(
      c,
      unit.type_code,
      b.parentId,
      at,
      ms(unit.effective_to) ?? undefined,
    );
    if ((await subtree(c.db, unit.id, at)).includes(b.parentId))
      rule("Organization cycle");
    const edges = await history(
      c.db,
      "org_unit_parent_edges",
      "unit_id",
      unit.id,
    );
    if (!edges.length && unit.parent_id)
      await insert(c.db, "org_unit_parent_edges", {
        unit_id: unit.id,
        parent_id: unit.parent_id,
        effective_from: unit.effective_from,
        effective_to: instant(at),
        actor_subject: "system:backfill",
        reason: "legacy projection",
      });
    await replaceInterval(
      c.db,
      "org_unit_parent_edges",
      "unit_id",
      unit.id,
      at,
      { parent_id: b.parentId, actor_subject: actor.subject, reason },
    );
    await topology(c.db, at);
  } else {
    const tree = await topology(c.db, at);
    if (tree.some((u) => u.parent_id === unit.id))
      rule("Unit has active children");
    const dependent =
      await c.db`select id from org_unit_parent_edges where parent_id=${unit.id} and deleted_at is null and (effective_to is null or effective_to>${instant(at)}) limit 1`;
    if (dependent.length) rule("Unit has dependent child intervals");
    const people =
      await c.db`select id from employee_assignments where org_unit_id=${unit.id} and deleted_at is null and (effective_to is null or effective_to>${instant(at)}) limit 1`;
    if (people.length) rule("Reassign people before retiring this unit");
    await update(c.db, "org_units", unit.id, { effective_to: instant(at) });
    await c.db`update org_unit_parent_edges set effective_to=${instant(at)} where unit_id=${unit.id} and (effective_to is null or effective_to>${instant(at)})`;
  }
  return null;
}

/** A staff phone number: digits with an optional leading +, spaces, dashes and brackets; blank clears it. @param {any} value */
export function phoneNumber(value) {
  if (value === null || (typeof value === "string" && !value.trim()))
    return null;
  const text = required(value, "Phone number", 25);
  if (!/^\+?[0-9][0-9 ()-]{5,24}$/.test(text))
    rule("Enter the phone number with digits only, for example 0917 123 4567");
  return text;
}

/** Single audited history path for assignments and invitations. @param {Ctx} c @param {Row} b */
export async function assignPerson(c, b) {
  const target = await access(c, "people", uuid(b.profileId), "admin.manage");
  const actor = /** @type {NonNullable<Ctx['actor']>} */ (c.actor);
  const role = b.role ?? target.role;
  if (target.role === "super_admin" || role === "super_admin")
    rule("Bootstrap super admin cannot be changed");
  if (!ASSIGNABLE_ROLES.includes(role)) rule("Invalid app role");
  if (
    (target.role === "admin" || role === "admin") &&
    actor.role !== "super_admin"
  )
    throw new ApiError(
      "forbidden",
      403,
      "Only the super admin can manage administrators",
    );
  const requestedFrom = b.effectiveFrom;
  if (requestedFrom !== undefined) instant(requestedFrom, c.now);
  const unitId = b.orgUnitId ?? target.org_unit_id;
  if (unitId) {
    await requireCapability(c, "admin.manage", uuid(unitId));
    await activeUnit(
      c,
      unitId,
      requestedFrom ?? c.now,
      b.effectiveTo ?? Infinity,
    );
  }
  if (b.positionId && !(await get(c.db, "positions", b.positionId)).active)
    rule("Unknown or inactive position");
  if (b.supervisorId) {
    let cursor = b.supervisorId;
    const seen = new Set([target.id]);
    for (let i = 0; cursor && i < 500; i++) {
      if (seen.has(cursor)) rule("Supervisor cycle");
      seen.add(cursor);
      const supervisor = await personAt(
        c.db,
        await get(c.db, "profiles", cursor),
      );
      if (supervisor.status !== "active" || !supervisor.org_unit_id || !unitId)
        rule("Invalid supervisor");
      await requireCapability(c, "admin.manage", supervisor.org_unit_id);
      if (!(await subtree(c.db, supervisor.org_unit_id)).includes(unitId))
        rule("Supervisor outside employee hierarchy");
      const [next] =
        await c.db`select id from profiles where auth_subject=${supervisor.supervisor_subject ?? ""}`;
      cursor = next?.id;
    }
    if (cursor) rule("Supervisor chain too long");
  }
  // IP-INT2: the office keeps a phone number for staff (blank clears it).
  const phone = b.phone === undefined ? undefined : phoneNumber(b.phone);
  const employeeCode =
    b.employeeCode === undefined ? target.employee_code : code(b.employeeCode);
  if (target.employee_code && employeeCode !== target.employee_code)
    rule("Employee code is immutable");
  const rows = await history(
    c.db,
    "employee_assignments",
    "profile_id",
    target.id,
  );
  const from =
    requestedFrom ??
    Math.max(
      c.now,
      ...rows
        .filter((r) => ms(r.effective_from) <= c.now)
        .map((r) => (ms(r.effective_from) ?? 0) + 1),
    );
  if (b.effectiveTo !== undefined) {
    instant(b.effectiveTo, c.now);
    if (b.effectiveTo <= from) rule("Invalid effective interval");
  }
  const current = rows.find((r) => activeAt(r, from));
  const supervisorId = b.supervisorId ?? current?.supervisor_id ?? null;
  await replaceInterval(
    c.db,
    "employee_assignments",
    "profile_id",
    target.id,
    from,
    {
      org_unit_id: unitId,
      role,
      position_id: b.positionId ?? target.position_id,
      supervisor_id: supervisorId,
      actor_subject: actor.subject,
      reason: required(b.reason, "Reason"),
      effective_to: b.effectiveTo === undefined ? null : instant(b.effectiveTo),
    },
  );
  const supervisor = supervisorId
    ? await get(c.db, "profiles", supervisorId)
    : null;
  /** @type {Row} */ const projection = {
    employee_code: employeeCode,
    scope_epoch: Number(target.scope_epoch) + 1,
    ...(phone === undefined ? {} : { phone }),
  };
  if (requestedFrom === undefined || from <= c.now)
    Object.assign(projection, {
      role,
      org_unit_id: unitId,
      position_id: b.positionId ?? target.position_id,
      supervisor_subject: supervisor?.auth_subject,
      effective_from: instant(from),
    });
  await update(c.db, "profiles", target.id, projection);
  return null;
}

/** @param {Ctx} c @param {'invite'|'revoke'} action @param {Row} b */
export async function invitationCommand(c, action, b) {
  const actor = await requireNationalScope(c, ["admin"]);
  if (action === "revoke") {
    const invite = await get(c.db, "access_invitations", uuid(b.invitationId));
    if (
      invite.role === "super_admin" ||
      (invite.role === "admin" && actor.role !== "super_admin")
    )
      rule("Cannot revoke this invitation");
    const [person] =
      await c.db`select * from profiles where lower(email)=${String(invite.email).toLowerCase()}`;
    if (
      person?.role === "super_admin" ||
      (person?.role === "admin" && actor.role !== "super_admin")
    )
      rule("Cannot revoke this person");
    await update(c.db, "access_invitations", invite.id, { status: "revoked" });
    if (person) {
      await update(c.db, "profiles", person.id, {
        status: "disabled",
        scope_epoch: Number(person.scope_epoch) + 1,
      });
      await c.db`update sessions set revoked_at=now() where user_id=${person.user_id} and revoked_at is null`;
    }
    return null;
  }
  const email = required(b.email, "Email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) rule("Enter a valid email");
  if (
    (c.env.BOOTSTRAP_ADMIN_EMAILS ?? "")
      .split(",")
      .some((s) => s.trim().toLowerCase() === email)
  )
    rule("Bootstrap access cannot be changed");
  if (
    !ASSIGNABLE_ROLES.includes(b.role) ||
    (b.role === "admin" && actor.role !== "super_admin")
  )
    rule("Cannot grant this role");
  if (b.orgUnitId) {
    await requireCapability(c, "admin.manage", uuid(b.orgUnitId));
    await activeUnit(c, b.orgUnitId, c.now);
  }
  if (b.positionId && !(await get(c.db, "positions", b.positionId)).active)
    rule("Unknown or inactive position");
  const [person] =
    await c.db`select * from profiles where lower(email)=${email}`;
  const [existing] =
    await c.db`select * from access_invitations where lower(email)=${email} order by invited_at desc limit 1`;
  // Add person never silently rewrites someone: a waiting invitation or a person who already has
  // access is refused in words (change them with Edit). Revoked invitations and disabled people
  // may be invited again.
  if (existing?.status === "pending")
    rule(`${email} is already invited. Find them under Invited.`);
  if (person?.status === "active")
    rule(`${email} already has access. Use Edit on their row to change it.`);
  if (person) {
    await assignPerson(c, {
      ...b,
      profileId: person.id,
      reason: "invitation updated",
    });
    await update(c.db, "profiles", person.id, {
      status: "active",
      name: b.name?.trim() || person.name,
    });
  }
  const values = {
    email,
    name: b.name?.trim() || null,
    role: b.role,
    org_unit_id: b.orgUnitId,
    position_id: b.positionId,
    status: person ? "accepted" : "pending",
    invited_by: actor.subject,
    invited_at: new Date(c.now),
    profile_id: person?.id,
    accepted_at: person ? new Date(c.now) : null,
  };
  return (
    existing
      ? await update(c.db, "access_invitations", existing.id, values)
      : await insert(c.db, "access_invitations", values)
  ).id;
}

/** @param {Ctx} c @param {string} profileId @param {string} owner @param {number} from @param {number} [to] @param {string} [capability] */
async function personWindow(
  c,
  profileId,
  owner,
  from,
  to = Infinity,
  capability = "route.manage",
) {
  const person = await personAt(
    c.db,
    await get(c.db, "profiles", profileId),
    from,
  );
  if (person.status !== "active" || !person.org_unit_id)
    rule("Person has no active unit");
  await requireCapability(c, capability, person.org_unit_id);
  if (!(await subtree(c.db, owner, from)).includes(person.org_unit_id))
    rule("Person outside owner hierarchy");
  const rows = await history(
    c.db,
    "employee_assignments",
    "profile_id",
    profileId,
  );
  if (
    rows.some((r) => ms(r.effective_from) > from && ms(r.effective_from) < to)
  )
    rule("Future employee assignment needs revalidation");
  return person;
}

/** @param {Ctx} c @param {string} action @param {Row} b */
export async function teamCommand(c, action, b) {
  const from =
    action === "removeMember" || action === "deactivate"
      ? b.effectiveTo
      : b.effectiveFrom;
  if (action !== "edit") instant(from, c.now);
  const actor = await requireCapability(
    c,
    "admin.manage",
    action === "create" ? uuid(b.orgUnitId) : undefined,
  );
  const reason = required(b.reason, "Reason");
  if (action === "create") {
    await activeUnit(c, b.orgUnitId, from);
    if (b.supervisorProfileId)
      await personWindow(
        c,
        b.supervisorProfileId,
        b.orgUnitId,
        from,
        Infinity,
        "admin.manage",
      );
    return (
      await insert(c.db, "teams", {
        code: code(b.code),
        name: required(b.name, "Name", 200),
        org_unit_id: b.orgUnitId,
        status: "active",
        supervisor_profile_id: b.supervisorProfileId,
        effective_from: instant(from),
        created_by: actor.subject,
      })
    ).id;
  }
  const team = await access(c, "teams", uuid(b.teamId), "admin.manage");
  if (action === "edit") {
    if (b.supervisorProfileId)
      await personWindow(
        c,
        b.supervisorProfileId,
        team.org_unit_id,
        c.now,
        Infinity,
        "admin.manage",
      );
    await update(c.db, "teams", team.id, {
      name: required(b.name, "Name", 200),
      supervisor_profile_id:
        b.supervisorProfileId ?? team.supervisor_profile_id,
    });
    return null;
  }
  if (!activeAt(team, from) || team.status !== "active")
    rule("Team not active at effective time");
  if (action === "deactivate") {
    const members = await history(c.db, "team_memberships", "team_id", team.id);
    for (const row of members)
      if (overlaps(row, from))
        await update(c.db, "team_memberships", row.id, {
          effective_to: instant(Math.max(from, ms(row.effective_from) ?? from)),
        });
    await update(c.db, "teams", team.id, { effective_to: instant(from) });
    return null;
  }
  await personWindow(
    c,
    uuid(b.profileId),
    team.org_unit_id,
    from,
    ms(team.effective_to) ?? Infinity,
    "admin.manage",
  );
  const members = (
    await history(c.db, "team_memberships", "team_id", team.id)
  ).filter((r) => r.profile_id === b.profileId);
  if (action === "addMember") {
    if (members.some((r) => overlaps(r, from)))
      rule("Overlapping team membership", "overlap");
    return (
      await insert(c.db, "team_memberships", {
        team_id: team.id,
        profile_id: b.profileId,
        effective_from: instant(from),
        effective_to: team.effective_to,
        actor_subject: actor.subject,
        reason,
      })
    ).id;
  }
  const row = members.find((r) => activeAt(r, from));
  if (!row || ms(row.effective_from) >= from)
    rule("No open membership at effective time");
  await update(c.db, "team_memberships", row.id, {
    effective_to: instant(from),
  });
  return null;
}

/** Approved plans freeze assignment/route facts over their full interval. Read-only access to COVERAGE tables. @param {Ctx} c @param {string[]} outlets @param {string[]} routes @param {number} from */
export async function assertUnlocked(c, outlets, routes, from) {
  const locked =
    await c.db`select p.id from coverage_plans p where p.deleted_at is null and p.status in ('approved','active') and p.effective_to>${instant(from)} and exists(select 1 from coverage_plan_outlets o where o.plan_id=p.id and (o.outlet_id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(outlets)}::text::jsonb)) or o.route_id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(routes)}::text::jsonb)))) limit 1`;
  if (locked.length)
    rule("An approved coverage plan locks this interval", "plan_locked");
}

/** @param {any} raw */
function boundary(raw) {
  if (!raw) return;
  if (typeof raw !== "string" || raw.length > 100000) rule("Invalid boundary");
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    rule("Invalid GeoJSON");
  }
  if (!["Polygon", "MultiPolygon", "Feature"].includes(value?.type))
    rule("Boundary must be a polygon");
}
/** @param {Ctx} c @param {string} territoryId @param {number} from @param {number} [to] @param {string} [capability] */
async function territoryWindow(
  c,
  territoryId,
  from,
  to = Infinity,
  capability = "route.manage",
) {
  const territory = await get(c.db, "territories", territoryId);
  if (
    !activeAt(territory, from) ||
    territory.status !== "active" ||
    (ms(territory.effective_to) ?? Infinity) < to
  )
    rule("Territory does not cover interval");
  const rows = await history(
    c.db,
    "territory_ownerships",
    "territory_id",
    territoryId,
  );
  let cursor = from;
  for (const r of rows.filter((r) => !r.deleted_at && overlaps(r, from, to))) {
    if (ms(r.effective_from) > cursor) rule("Territory ownership gap");
    await requireCapability(c, capability, r.org_unit_id);
    await activeUnit(
      c,
      r.org_unit_id,
      Math.max(from, ms(r.effective_from) ?? 0),
      Math.min(to, ms(r.effective_to) ?? Infinity),
    );
    cursor = Math.max(cursor, ms(r.effective_to) ?? Infinity);
  }
  if (cursor < to) rule("Territory owner does not cover interval");
  return territory;
}

/** @param {Ctx} c @param {string} kind @param {string} action @param {Row} b */
export async function geographyCommand(c, kind, action, b) {
  if (
    b.effectiveFrom !== undefined &&
    b.effectiveTo !== undefined &&
    b.effectiveTo <= b.effectiveFrom
  )
    rule("Invalid effective interval");
  const isRoute = kind === "routes",
    table = isRoute ? "routes" : "territories",
    cap = isRoute ? "route.manage" : "territory.manage";
  const from =
    action === "deactivate" || action === "endSalespersonAssignment"
      ? b.effectiveTo
      : b.effectiveFrom;
  const actor = await requireCapability(c, cap);
  const reason = required(b.reason, "Reason");
  if (!["edit"].includes(action)) instant(from, c.now);
  const territoryId = isRoute ? b.territoryId : null;
  if (action === "create" || action === "duplicateTemplate") {
    if (isRoute) {
      await access(c, "territories", uuid(territoryId), cap);
      await territoryWindow(
        c,
        territoryId,
        from,
        b.effectiveTo ?? Infinity,
        cap,
      );
    } else {
      await requireCapability(c, cap, uuid(b.orgUnitId));
      await activeUnit(c, b.orgUnitId, from, b.effectiveTo ?? Infinity);
      boundary(b.boundaryGeoJson);
    }
    let template = b;
    if (action === "duplicateTemplate") {
      const original = await access(c, "routes", uuid(b.routeId), cap);
      template = {
        ...b,
        weekdayTemplate: original.weekday_template,
        cycleDays: original.cycle_days,
      };
    }
    const weekdays = template.weekdayTemplate ?? [];
    if (
      weekdays.length > 7 ||
      new Set(weekdays).size !== weekdays.length ||
      weekdays.some(
        (/** @type {number} */ d) => !Number.isInteger(d) || d < 1 || d > 7,
      )
    )
      rule("Invalid weekday template");
    if (template.cycleDays != null) integer(template.cycleDays, 1, 366);
    const row = await insert(c.db, table, {
      organization_id: "sunpride",
      code: code(b.code),
      name: required(b.name, "Name", 200),
      status: "active",
      effective_from: instant(from),
      effective_to: b.effectiveTo == null ? null : instant(b.effectiveTo),
      created_by: actor.subject,
      ...(isRoute
        ? { weekday_template: weekdays, cycle_days: template.cycleDays }
        : { channel: b.channel, boundary_geo_json: b.boundaryGeoJson }),
    });
    await insert(c.db, isRoute ? "route_territories" : "territory_ownerships", {
      [isRoute ? "route_id" : "territory_id"]: row.id,
      [isRoute ? "territory_id" : "org_unit_id"]: isRoute
        ? territoryId
        : b.orgUnitId,
      effective_from: instant(from),
      effective_to: b.effectiveTo == null ? null : instant(b.effectiveTo),
      actor_subject: actor.subject,
      reason,
    });
    return row.id;
  }
  const id = uuid(isRoute ? b.routeId : b.territoryId);
  const row = await access(c, kind, id, cap);
  if (action === "deactivate" && from <= ms(row.effective_from))
    rule("Invalid effective interval");
  if (action === "edit") {
    boundary(b.boundaryGeoJson);
    const values = { name: required(b.name, "Name", 200) };
    if (isRoute) {
      if (b.weekdayTemplate) {
        if (
          b.weekdayTemplate.length > 7 ||
          new Set(b.weekdayTemplate).size !== b.weekdayTemplate.length ||
          b.weekdayTemplate.some(
            (/** @type {number} */ d) => !Number.isInteger(d) || d < 1 || d > 7,
          )
        )
          rule("Invalid weekdays");
        Object.assign(values, { weekday_template: b.weekdayTemplate });
      }
      if (b.cycleDays != null)
        Object.assign(values, { cycle_days: integer(b.cycleDays, 1, 366) });
    } else
      Object.assign(values, {
        channel: b.channel ?? row.channel,
        boundary_geo_json: b.boundaryGeoJson ?? row.boundary_geo_json,
      });
    await update(c.db, table, id, values);
    return null;
  }
  if (!activeAt(row, from) || row.status !== "active")
    rule("Not active at effective time");
  if (isRoute) await assertUnlocked(c, [], [id], from);
  if (action === "move" || action === "transferOwner") {
    const dest = isRoute ? uuid(b.territoryId) : uuid(b.orgUnitId);
    const end = ms(row.effective_to) ?? Infinity;
    if (isRoute) {
      await access(c, "territories", dest, cap);
      await territoryWindow(c, dest, from, end, cap);
      const stops =
        await c.db`select id from outlet_assignments where route_id=${id} and deleted_at is null and (effective_to is null or effective_to>${instant(from)}) limit 1`;
      if (stops.length) rule("Reassign route stops before moving route");
    } else {
      await requireCapability(c, cap, dest);
      await activeUnit(c, dest, from, end);
    }
    await replaceInterval(
      c.db,
      isRoute ? "route_territories" : "territory_ownerships",
      isRoute ? "route_id" : "territory_id",
      id,
      from,
      {
        [isRoute ? "territory_id" : "org_unit_id"]: dest,
        effective_to: row.effective_to,
        actor_subject: actor.subject,
        reason,
      },
    );
    return null;
  }
  if (action === "deactivate") {
    const children = isRoute
      ? await c.db`select id from outlet_assignments where route_id=${id} and deleted_at is null and (effective_to is null or effective_to>${instant(from)}) limit 1`
      : await c.db`select id from route_territories where territory_id=${id} and deleted_at is null and (effective_to is null or effective_to>${instant(from)}) union all select id from outlet_assignments where territory_id=${id} and deleted_at is null and (effective_to is null or effective_to>${instant(from)}) limit 1`;
    if (children.length)
      rule("Active or future dependents prevent deactivation");
    await update(c.db, table, id, { effective_to: instant(from) });
    return null;
  }
  const assignmentTable = isRoute
      ? "route_salespeople"
      : "territory_salespeople",
    field = isRoute ? "route_id" : "territory_id";
  const profileId = uuid(b.profileId);
  const rows = await history(c.db, assignmentTable, field, id);
  if (action === "endSalespersonAssignment") {
    const assignment = rows.find(
      (r) => r.profile_id === profileId && activeAt(r, from),
    );
    if (!assignment || ms(assignment.effective_from) >= from)
      rule("No open salesperson assignment");
    await personWindow(
      c,
      profileId,
      (await personAt(c.db, await get(c.db, "profiles", profileId)))
        .org_unit_id,
      from,
      from + 1,
      cap,
    );
    await update(c.db, assignmentTable, assignment.id, {
      effective_to: instant(from),
    });
    return null;
  }
  let owner;
  if (isRoute) {
    const association = (
      await history(c.db, "route_territories", "route_id", id)
    ).find((r) => activeAt(r, from));
    if (!association) rule("Route has no territory");
    await territoryWindow(
      c,
      association.territory_id,
      from,
      b.effectiveTo ?? Infinity,
      cap,
    );
    owner = await territoryOwnerUnit(c.db, association.territory_id, from);
  } else owner = await territoryOwnerUnit(c.db, id, from);
  if (!owner) rule("Territory has no owner");
  await personWindow(c, profileId, owner, from, b.effectiveTo ?? Infinity, cap);
  if (
    rows.some(
      (r) =>
        overlaps(r, from, b.effectiveTo ?? Infinity) &&
        (r.profile_id === profileId ||
          (isRoute
            ? b.primary !== false && r.is_primary
            : b.kind !== "secondary" && r.kind !== "secondary")),
    )
  )
    rule("Overlapping salesperson assignment", "overlap");
  return (
    await insert(c.db, assignmentTable, {
      [field]: id,
      profile_id: profileId,
      ...(isRoute
        ? { is_primary: b.primary !== false }
        : { kind: b.kind ?? "primary" }),
      effective_from: instant(from),
      effective_to: b.effectiveTo == null ? null : instant(b.effectiveTo),
      actor_subject: actor.subject,
      reason,
    })
  ).id;
}
