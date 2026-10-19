import {
  requireCapability,
  requireNationalScope,
} from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import {
  activeAt,
  dto,
  get,
  history,
  instant,
  ms,
  page,
  paging,
  rule,
  uuid,
} from "./model.js";
import {
  outletOwnerUnit,
  personAt,
  rootUnitId,
  scopeFilterForActor,
  subtree,
  territoryOwnerUnit,
  topology,
} from "./scope.js";

/** @typedef {import('./model.js').Ctx} Ctx */
/** @typedef {import('./model.js').Row} Row */
/** @typedef {import('./model.js').Db} Db */

/** Gate a stored current owner even for an as-of request. @param {Ctx} c @param {string} kind @param {string} id @param {string} capability */
export async function access(c, kind, id, capability) {
  const actor = await requireCapability(c, capability);
  const table =
    kind === "org"
      ? "org_units"
      : kind === "people"
        ? "profiles"
        : kind === "teams"
          ? "teams"
          : kind === "territories"
            ? "territories"
            : kind === "routes"
              ? "routes"
              : kind === "outlets"
                ? "outlets"
                : kind === "devices"
                  ? "registered_devices"
                  : "";
  const row = await get(c.db, table, id);
  let unit = row.org_unit_id;
  if (kind === "org") unit = id;
  if (kind === "people") unit = (await personAt(c.db, row)).org_unit_id;
  if (kind === "territories") unit = await territoryOwnerUnit(c.db, id);
  if (kind === "outlets") unit = await outletOwnerUnit(c.db, id, c.now);
  if (kind === "routes") {
    const current = (
      await history(c.db, "route_territories", "route_id", id)
    ).find((r) => !r.deleted_at && activeAt(r, c.now));
    unit = current
      ? await territoryOwnerUnit(c.db, current.territory_id)
      : null;
  }
  if (!unit && actor.role !== "super_admin" && actor.role !== "analyst") {
    // An unassigned person may only be maintained by a national administrator.
    if (
      kind === "people" &&
      ["admin.manage", "people.read"].includes(capability)
    )
      await requireNationalScope(c, ["admin"]);
    else
      throw new ApiError(
        "out_of_scope",
        403,
        "Record has no accessible current owner",
      );
  } else if (unit) await requireCapability(c, capability, unit);
  if (actor.role === "sales" && capability.endsWith(".read")) {
    let assigned = true;
    if (kind === "territories")
      assigned = (
        await history(c.db, "territory_salespeople", "territory_id", id)
      ).some(
        (r) =>
          r.profile_id === actor.profileId &&
          !r.deleted_at &&
          activeAt(r, c.now),
      );
    if (kind === "routes")
      assigned = (
        await history(c.db, "route_salespeople", "route_id", id)
      ).some(
        (r) =>
          r.profile_id === actor.profileId &&
          !r.deleted_at &&
          activeAt(r, c.now),
      );
    if (kind === "outlets") {
      const a = (
        await history(c.db, "outlet_assignments", "outlet_id", id)
      ).find((r) => !r.deleted_at && activeAt(r, c.now));
      if (a)
        assigned = (
          await history(
            c.db,
            "territory_salespeople",
            "territory_id",
            a.territory_id,
          )
        ).some(
          (r) =>
            r.profile_id === actor.profileId &&
            !r.deleted_at &&
            activeAt(r, c.now),
        );
    }
    if (!assigned)
      throw new ApiError(
        "out_of_scope",
        403,
        "Not assigned to this salesperson",
      );
  }
  return row;
}

const effective = (/** @type {string} */ a) =>
  `${a}.deleted_at is null and ${a}.effective_from<=now() and (${a}.effective_to is null or ${a}.effective_to>now())`;

/** All filters precede the LIMIT. Cursor is a UUID keyset, not an offset. @param {Ctx} c @param {string} kind @param {Row} p */
export async function list(c, kind, p) {
  const actor = await requireCapability(
    c,
    kind === "people"
      ? "people.read"
      : kind === "territories"
        ? "territory.read"
        : kind === "routes"
          ? "route.read"
          : kind === "outlets"
            ? "outlet.read"
            : kind === "teams" || kind === "devices" || kind === "invitations"
              ? "admin.manage"
              : kind === "customers"
                ? "masterdata.manage"
                : "inventory.read",
  );
  if (kind === "invitations") await requireNationalScope(c, ["admin"]);
  const { unitIds } = await scopeFilterForActor(c.db, actor);
  const { size, cursor, q } = paging(p);
  const national =
    kind === "people" &&
    (actor.role === "super_admin" ||
      (actor.role === "admin" && actor.orgUnitId === (await rootUnitId(c.db))));
  /** @type {any[]} */ const params = [];
  /** @param {any} v */ const bind = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  const units = bind(JSON.stringify(unitIds));
  const unitSet = `(select value::uuid from jsonb_array_elements_text(${units}::text::jsonb))`;
  /** @param {string} expr */ const scoped = (expr) =>
    unitIds === null ? "true" : `${expr} in ${unitSet}`;
  let table = "",
    joins = "",
    where = "true",
    search = "";
  switch (kind) {
    case "people": {
      table = "profiles";
      joins = `left join lateral (select ea.* from employee_assignments ea where ea.profile_id=t.id and ${effective("ea")} order by effective_from desc limit 1) current_person on true`;
      const owner =
        "case when current_person.id is not null then current_person.org_unit_id when exists(select 1 from employee_assignments old where old.profile_id=t.id and old.deleted_at is null and old.effective_from<=now()) then null else t.org_unit_id end";
      where = `t.deleted_at is null and (${scoped(owner)}${national ? ` or (${owner}) is null` : ""})`;
      search = "t.search_vector";
      if (p.unassigned === "true") where += ` and (${owner}) is null`;
      if (p.supervisorUnits)
        where += ` and t.status='active' and (${owner}) in (select value::uuid from jsonb_array_elements_text(${bind(JSON.stringify(p.supervisorUnits))}::text::jsonb))`;
      break;
    }
    case "teams":
      table = "teams";
      where = scoped("t.org_unit_id");
      break;
    case "territories":
      table = "territories";
      where = `t.deleted_at is null and exists(select 1 from territory_ownerships own where own.territory_id=t.id and ${effective("own")} and ${scoped("own.org_unit_id")})`;
      if (actor.role === "super_admin" || actor.role === "analyst")
        where = "t.deleted_at is null";
      if (actor.role === "sales")
        where += ` and exists(select 1 from territory_salespeople sp where sp.territory_id=t.id and sp.profile_id=${bind(actor.profileId)} and ${effective("sp")})`;
      break;
    case "routes":
      table = "routes";
      where = `t.deleted_at is null and exists(select 1 from route_territories rt join territory_ownerships own on own.territory_id=rt.territory_id where rt.route_id=t.id and ${effective("rt")} and ${effective("own")} and ${scoped("own.org_unit_id")}${p.territoryId ? ` and rt.territory_id=${bind(p.territoryId)}` : ""})`;
      if (!p.territoryId && unitIds === null) where = "t.deleted_at is null";
      if (actor.role === "sales")
        where += ` and exists(select 1 from route_salespeople sp where sp.route_id=t.id and sp.profile_id=${bind(actor.profileId)} and ${effective("sp")})`;
      if (p.unassigned === "true")
        where += ` and not exists(select 1 from route_salespeople sp where sp.route_id=t.id and ${effective("sp")})`;
      break;
    case "outlets":
      table = "outlets";
      search = "t.search_vector";
      joins = `left join lateral(select oa.* from outlet_assignments oa where oa.outlet_id=t.id and ${effective("oa")} limit 1) assignment on true left join lateral(select own.org_unit_id from territory_ownerships own where own.territory_id=assignment.territory_id and ${effective("own")} limit 1) owner on true`;
      where = `t.deleted_at is null and ${scoped("case when assignment.id is null then t.custodian_org_unit_id else owner.org_unit_id end")}`;
      if (actor.role === "sales")
        where += ` and (assignment.id is null or exists(select 1 from territory_salespeople sp where sp.territory_id=assignment.territory_id and sp.profile_id=${bind(actor.profileId)} and ${effective("sp")}))`;
      if (p.unassigned === "true") where += " and assignment.route_id is null";
      if (p.unverified === "true")
        where += ` and not exists(select 1 from outlet_pins pin where pin.outlet_id=t.id and pin.status='verified' and ${effective("pin")})`;
      if (p.territoryId)
        where += ` and assignment.territory_id=${bind(p.territoryId)}`;
      if (p.routeId) where += ` and assignment.route_id=${bind(p.routeId)}`;
      break;
    case "products":
      table = "products";
      search = "t.search_vector";
      where = "t.deleted_at is null";
      if (p.category) where += ` and t.category=${bind(p.category)}`;
      if (p.missingPrice === "true")
        where += ` and not exists(select 1 from price_list_lines l join price_lists pl on pl.id=l.price_list_id where l.product_id=t.id and pl.status='active' and pl.effective_from<=now() and (pl.effective_to is null or pl.effective_to>now()) and l.effective_from<=now() and (l.effective_to is null or l.effective_to>now()))`;
      break;
    case "customers":
      table = "customers";
      search = "t.search_vector";
      where = "t.deleted_at is null";
      // Accounting customer identity is not an outlet authorization key. Require national scope
      // for unlinked accounts; scoped users only see accounts with an authorized persisted link.
      if (unitIds !== null)
        where += ` and exists(select 1 from outlet_customer_links cl join outlets o on o.id=cl.outlet_id left join lateral(select oa.* from outlet_assignments oa where oa.outlet_id=o.id and ${effective("oa")} limit 1) oa on true left join lateral(select own.org_unit_id from territory_ownerships own where own.territory_id=oa.territory_id and ${effective("own")} limit 1) own on true where cl.customer_id=t.id and ${effective("cl")} and o.deleted_at is null and ${scoped("case when oa.id is null then o.custodian_org_unit_id else own.org_unit_id end")})`;
      break;
    case "devices":
      table = "registered_devices";
      where = scoped("t.org_unit_id");
      joins = "left join profiles person on person.id=t.profile_id";
      break;
    case "invitations":
      table = "access_invitations";
      break;
    default:
      throw new ApiError("not_found", 404, "Unknown list");
  }
  where += ` and ${units}::text::jsonb is not null`;
  if (p.id) where += ` and t.id=${bind(uuid(p.id))}::uuid`;
  if (cursor) where += ` and t.id>${bind(cursor)}::uuid`;
  if (q) {
    const query = search ? bind(q) : null,
      like = bind(`%${q.replace(/[\\%_]/g, "\\$&")}%`);
    where += search
      ? ` and (${search} @@ plainto_tsquery('simple',${query}) or t.name ilike ${like}${kind === "people" ? ` or t.email ilike ${like}` : ` or t.code ilike ${like}`})`
      : ` and (t.${kind === "invitations" ? "email" : kind === "devices" ? "inventory_tag" : "name"} ilike ${like})`;
  }
  if (p.status && p.status !== "all")
    where += ` and t.status=${bind(p.status)}`;
  if (p.active !== undefined)
    where += ` and t.active=${bind(p.active === true || p.active === "true")}`;
  if (p.channel && ["outlets", "customers", "territories"].includes(kind))
    where += ` and t.channel=${bind(p.channel)}`;
  /** @type {Row[]} */ const rows = await c.db.unsafe(
    `select t.*${kind === "devices" ? ",person.name as employee_name" : ""} from ${table} t ${joins} where ${where} order by t.id limit ${bind(size + 1)}`,
    params,
  );
  const enriched = [];
  for (const row of rows) {
    if (kind === "people") enriched.push(await personAt(c.db, row));
    else if (kind === "outlets") enriched.push(await enrichOutlet(c.db, row));
    else if (kind === "products") enriched.push(await enrichProduct(c.db, row));
    else if (kind === "customers") {
      const { credit_limit, ...customer } = row;
      enriched.push({
        ...customer,
        credit_limit_centavos: Math.round(Number(credit_limit) * 100),
      });
    } else if (kind === "devices") {
      const { public_key_spki, key_id, credential_id, bound_subject, ...safe } =
        row;
      enriched.push(safe);
    } else enriched.push(row);
  }
  const result = page(enriched, size);
  if (kind === "devices")
    result.page = result.page.map((r) => ({
      ...r,
      deviceId: r.id,
      lastSeenAt: r.lastSeenAt ?? null,
      statusAt: null,
      offlineLeaseExpiresAt: null,
      employeeName: r.employeeName ?? null,
      allowedApp: r.app,
      model: r.model ?? "Not recorded",
    }));
  return result;
}

/** @param {Db} db @param {Row} row */
export async function enrichOutlet(db, row) {
  const [details] =
    await db`select t.name as territory_name,t.code as territory_code,r.name as route_name,r.code as route_code,c.credit_limit,c.name as customer_name from outlet_assignments a left join territories t on t.id=a.territory_id left join routes r on r.id=a.route_id left join outlet_customer_links cl on cl.outlet_id=a.outlet_id and cl.deleted_at is null and cl.effective_from<=now() and (cl.effective_to is null or cl.effective_to>now()) left join customers c on c.id=cl.customer_id where a.outlet_id=${row.id} and a.deleted_at is null and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now()) limit 1`;
  const { credit_limit, ...account } = details ?? {};
  return {
    ...row,
    ...account,
    credit_limit_centavos:
      credit_limit == null ? null : Math.round(Number(credit_limit) * 100),
  };
}
/** @param {Db} db @param {Row} row */
export async function enrichProduct(db, row) {
  /** @type {Row[]} */ const conversions =
    await db`select c.*,f.code as from_code,t.code as to_code from uom_conversions c join units_of_measure f on f.id=c.from_uom_id join units_of_measure t on t.id=c.to_uom_id where c.product_id=${row.id} and c.active and c.deleted_at is null and c.effective_from<=now() and (c.effective_to is null or c.effective_to>now()) order by f.code,t.code limit 101`;
  if (conversions.length > 100)
    rule("Product conversions exceed supported size", "overflow");
  const [price] =
    await db`select l.id from price_list_lines l join price_lists p on p.id=l.price_list_id where l.product_id=${row.id} and p.status='active' and p.effective_from<=now() and (p.effective_to is null or p.effective_to>now()) and l.effective_from<=now() and (l.effective_to is null or l.effective_to>now()) limit 1`;
  const { unit_price, ...master } = row;
  return {
    ...master,
    conversions: conversions.map(dto),
    uom_display: conversions.length
      ? conversions
          .map(
            (r) =>
              `1 ${r.from_code.toLowerCase()} = ${Number(r.numerator) / Number(r.denominator)} ${r.to_code.toLowerCase()}`,
          )
          .join(" · ")
      : row.uom,
    price_status: price ? "Price list available" : "Governed price required",
  };
}

/** @param {Ctx} c @param {Row} p */
export async function orgTree(c, p) {
  const actor = await requireCapability(c, "org.read");
  const { unitIds } = await scopeFilterForActor(c.db, actor);
  const tree = await topology(c.db, p.asOf ?? c.now);
  return tree
    .filter((u) => unitIds === null || unitIds.includes(u.id))
    .map((u) =>
      dto({
        ...u,
        parent_id:
          unitIds === null || unitIds.includes(u.parent_id)
            ? u.parent_id
            : null,
      }),
    );
}

/** @param {Ctx} c @param {string} kind @param {Row} p */
export async function detail(c, kind, p) {
  const id =
    p.unitId ??
    p.profileId ??
    p.teamId ??
    p.territoryId ??
    p.routeId ??
    p.outletId;
  const row = await access(
    c,
    kind,
    id,
    kind === "people"
      ? "people.read"
      : kind === "teams"
        ? "admin.manage"
        : kind === "org"
          ? "org.read"
          : kind === "territories"
            ? "territory.read"
            : kind === "routes"
              ? "route.read"
              : "outlet.read",
  );
  const at = p.asOf ?? c.now;
  instant(at);
  if (kind === "territories")
    return {
      territory: dto(row),
      owner: dto(
        (await history(c.db, "territory_ownerships", "territory_id", id)).find(
          (r) => activeAt(r, at),
        ) ?? null,
      ),
    };
  if (kind === "routes")
    return {
      route: dto(row),
      territory: dto(
        (await history(c.db, "route_territories", "route_id", id)).find((r) =>
          activeAt(r, at),
        ) ?? null,
      ),
      salespeople: (await history(c.db, "route_salespeople", "route_id", id))
        .filter((r) => activeAt(r, at))
        .map((r) => ({ ...dto(r), primary: r.is_primary })),
    };
  if (kind === "teams") {
    const memberships = (
      await history(c.db, "team_memberships", "team_id", id)
    ).filter((r) => activeAt(r, at));
    const members = [];
    for (const m of memberships) {
      const person = await personAt(
        c.db,
        await get(c.db, "profiles", m.profile_id),
      );
      const { unitIds } = await scopeFilterForActor(
        c.db,
        /** @type {any} */ (c.actor),
      );
      if (unitIds === null || unitIds.includes(person.org_unit_id))
        members.push({
          membership: dto(m),
          profile: dto(person),
          name: person.name,
        });
    }
    return { team: dto(row), members };
  }
  if (kind === "outlets") {
    const [contacts] = [
      await c.db`select * from outlet_contacts where outlet_id=${id} and deleted_at is null order by ordinal`,
    ];
    const assignment = (
      await history(c.db, "outlet_assignments", "outlet_id", id)
    ).find((r) => activeAt(r, at));
    const pin = (await history(c.db, "outlet_pins", "outlet_id", id)).find(
      (r) => r.status === "verified" && activeAt(r, at),
    );
    const link = (
      await history(c.db, "outlet_customer_links", "outlet_id", id)
    ).find((r) => activeAt(r, at));
    return {
      outlet: {
        ...dto(await enrichOutlet(c.db, row)),
        contacts: contacts.map(dto),
      },
      assignment: dto(assignment ?? null),
      pin: dto(pin ?? null),
      customerLink: dto(link ?? null),
    };
  }
  return dto(kind === "people" ? await personAt(c.db, row, at) : row);
}

/** Bound histories are filtered by CURRENT scope, never the requested historical owner. @param {Ctx} c @param {string} kind @param {string} table @param {string} field @param {Row} p */
export async function readHistory(c, kind, table, field, p) {
  if (p.asOf !== undefined) instant(p.asOf);
  const id = p[field.replace(/_([a-z])/g, (_, v) => v.toUpperCase())];
  await access(
    c,
    kind,
    id,
    kind === "org"
      ? "org.read"
      : kind === "people"
        ? "people.read"
        : kind === "teams"
          ? "admin.manage"
          : kind === "territories"
            ? "territory.read"
            : kind === "routes"
              ? "route.read"
              : "outlet.read",
  );
  const rows = await history(c.db, table, field, id);
  const result = [];
  for (const row of rows) {
    if (row.deleted_at || (p.asOf !== undefined && !activeAt(row, p.asOf)))
      continue;
    const enriched = { ...row };
    if (row.org_unit_id)
      enriched.org_unit_name = (
        await get(c.db, "org_units", row.org_unit_id)
      ).name;
    if (row.profile_id)
      enriched.person_name = (await get(c.db, "profiles", row.profile_id)).name;
    if (row.territory_id)
      enriched.territory_name = (
        await get(c.db, "territories", row.territory_id)
      ).name;
    if (row.route_id)
      enriched.route_name = (await get(c.db, "routes", row.route_id)).name;
    if (row.outlet_id)
      enriched.outlet_name = (await get(c.db, "outlets", row.outlet_id)).name;
    if (row.customer_id)
      enriched.customer_name = (
        await get(c.db, "customers", row.customer_id)
      ).name;
    for (const [field, label] of [
      ["actor_subject", "actor_name"],
      ["proposed_by", "proposer_name"],
      ["verified_by", "verifier_name"],
    ])
      if (row[field]) {
        const [person] =
          await c.db`select name from profiles where auth_subject=${row[field]}`;
        enriched[label] = person?.name ?? "Former user";
      }
    if (
      table !== "team_memberships" ||
      !p.profileId ||
      row.profile_id === p.profileId
    )
      result.push(dto(enriched));
  }
  return result;
}

/** Queue paginates AFTER scope in SQL. @param {Ctx} c @param {'pins'|'enrolments'} kind @param {Row} p */
export async function queue(c, kind, p) {
  const actor = await requireCapability(
    c,
    kind === "pins"
      ? "outlet.verify"
      : p.mine
        ? "outlet.enrol.propose"
        : "outlet.enrol.approve",
  );
  const { unitIds } = await scopeFilterForActor(c.db, actor);
  const { size, cursor, q } = paging(p);
  const table = kind === "pins" ? "outlet_pins" : "outlet_enrolments";
  // Empty array for all-scope callers: never ask jsonb_array_elements to expand JSON null.
  const scopeCondition =
    unitIds === null
      ? "true"
      : `(case when a.territory_id is null then o.custodian_org_unit_id else own.org_unit_id end) in (select value::uuid from jsonb_array_elements_text($2::text::jsonb))`;
  /** @type {Row[]} */ const rows = await c.db.unsafe(
    `select t.* from ${table} t join outlets o on o.id=t.outlet_id left join lateral(select a.territory_id from outlet_assignments a where a.outlet_id=o.id and ${effective("a")} limit 1) a on true left join lateral(select own.org_unit_id from territory_ownerships own where own.territory_id=a.territory_id and ${effective("own")} limit 1) own on true where t.deleted_at is null and ($1::uuid is null or t.id>$1::uuid) and ($2::text::jsonb is not null) and (${scopeCondition}) and (o.name ilike $3 or o.code ilike $3) ${p.mine ? "and t.proposed_by_profile_id=$5::uuid" : "and t.status='pending'"} order by t.id limit $4`,
    [
      cursor,
      JSON.stringify(unitIds ?? []),
      `%${q}%`,
      size + 1,
      ...(p.mine ? [actor.profileId] : []),
    ],
  );
  const result = page(rows, size);
  if (kind === "enrolments") {
    const expanded = [];
    for (const row of result.page) {
      const outlet = await get(c.db, "outlets", row.outletId);
      /** @type {Row[]} */ const contacts =
        await c.db`select name,phone from outlet_contacts where outlet_id=${outlet.id} and deleted_at is null order by ordinal`;
      /** @type {Row[]} */ const photos =
        await c.db`select file_id from outlet_enrolment_photos where outlet_enrolment_id=${row.id} and deleted_at is null order by ordinal`;
      const url = (/** @type {string} */ id) =>
        `/api/v1/outlets/evidence?outletId=${outlet.id}&fileId=${id}`;
      expanded.push({
        enrolment: row,
        outlet: { ...dto(outlet), contacts: contacts.map(dto) },
        pin: dto(await get(c.db, "outlet_pins", row.pinId)),
        proposerName: (await get(c.db, "profiles", row.proposedByProfileId))
          .name,
        photoUrls: photos.map((p) => url(p.file_id)),
        cisUrl: row.cisStorageId ? url(row.cisStorageId) : null,
      });
    }
    return { ...result, page: expanded };
  }
  const expanded = [];
  for (const row of result.page)
    expanded.push({
      ...row,
      outlet: dto(await get(c.db, "outlets", row.outletId)),
    });
  return { ...result, page: expanded };
}

/** Field reference readers. Caller must provide an authenticated current actor; paged and person-assignment limited. Products require explicit selling authorization (no global product dump). @param {Ctx} c @param {Row} p */
export async function fieldOutlets(c, p = {}) {
  return list(c, "outlets", p);
}
/** @param {Ctx} c @param {Row} p */
export async function fieldRoutes(c, p = {}) {
  return list(c, "routes", p);
}
/** No governed selling catalog is owned by ORG. FIELDSYNC joins its authorized products; fail closed here. @param {Ctx} c */
export async function fieldProducts(c) {
  await requireCapability(c, "mcp.read");
  return {
    page: [],
    next: null,
    isDone: true,
    reason: "authorized_selling_catalog_required",
  };
}
