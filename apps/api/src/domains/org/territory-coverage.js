import {
  requireCapability,
  requireNationalScope,
} from "../../core/capabilities.js";
import { access } from "./readers.js";
import { code, dto, paging, page, required, rule, uuid } from "./model.js";
import { assertUnlocked } from "./commands.js";

/** @typedef {import('./model.js').Ctx} Ctx */
/** @typedef {import('./model.js').Row} Row */

/** @param {Ctx} c @param {string} id */
export async function coverageRows(c, id) {
  const rows = await c.db`select c.*,coalesce(m.name,b.name,g.name) name,
    bm.name municipality_name,coalesce(mp.name,bp.name) province_name
    from territory_coverage c
    left join ph_municipalities m on m.code=c.municipality_code
    left join ph_provinces mp on mp.code=m.province_code
    left join ph_barangays b on b.code=c.barangay_code
    left join ph_municipalities bm on bm.code=b.municipality_code
    left join ph_provinces bp on bp.code=bm.province_code
    left join customer_groups g on g.id=c.customer_group_id
    where c.territory_id=${id} order by name,c.id`;
  return rows.map(dto);
}

/** Bound search, never a first-page-only national place picker. @param {Ctx} c @param {Row} p */
export async function coveragePlaces(c, p) {
  await requireCapability(c, "territory.read");
  const q = required(p.q, "Search", 100);
  const kind = p.kind ?? "municipality";
  if (!["municipality", "barangay"].includes(kind))
    rule("Choose a place type.");
  const offset = Number(p.offset ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 50000)
    rule("Invalid page.");
  const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const rows =
    kind === "municipality"
      ? await c.db`select m.code,m.name,p.name province_name from ph_municipalities m join ph_provinces p on p.code=m.province_code where m.name ilike ${like} order by m.name,m.code limit 51 offset ${offset}`
      : await c.db`select b.code,b.name,m.name municipality_name,p.name province_name from ph_barangays b join ph_municipalities m on m.code=b.municipality_code join ph_provinces p on p.code=m.province_code where (b.name ilike ${like} or m.name ilike ${like}) order by b.name,b.code limit 51 offset ${offset}`;
  return { options: rows.slice(0, 50).map(dto), hasMore: rows.length > 50 };
}

/** @param {any} value @param {string} label */
function selections(value, label) {
  if (
    !Array.isArray(value) ||
    value.length > 500 ||
    value.some((v) => typeof v !== "string") ||
    new Set(value).size !== value.length
  )
    rule(`Choose up to 500 different ${label}.`);
  return /** @type {string[]} */ (value);
}

/** Called inside the serialized, audited territory command, after the owner checks.
 * Gate both source and resulting store owners; regional admins cannot capture foreign stores.
 * @param {Ctx} c @param {string} id @param {Row} b */
export async function saveCoverage(c, id, b) {
  if (
    b.territoryType === undefined &&
    b.municipalityCodes === undefined &&
    b.barangayCodes === undefined &&
    b.customerGroupIds === undefined
  )
    return;
  const [territory] = await c.db`select * from territories where id=${id}`;
  const type = b.territoryType ?? territory.territory_type;
  if (!["location", "customer_group"].includes(type))
    rule("Choose Location or Customer group.");
  const municipalities = selections(
    b.municipalityCodes ?? [],
    "cities or municipalities",
  );
  const barangays = selections(b.barangayCodes ?? [], "barangays");
  const groups = selections(b.customerGroupIds ?? [], "customer groups");
  if (
    (type === "location" && groups.length) ||
    (type === "customer_group" && (municipalities.length || barangays.length))
  )
    rule("Choose places for Location, or groups for Customer group, not both.");
  /** @type {Row[]} */ const desired = [];
  /** @type {[string,string,string[]][]} */
  const lists = [
    ["municipality_code", "ph_municipalities", municipalities],
    ["barangay_code", "ph_barangays", barangays],
    ["customer_group_id", "customer_groups", groups],
  ];
  for (const [column, table, values] of lists) {
    for (const value of /** @type {string[]} */ (values)) {
      if (column === "customer_group_id") uuid(value);
      else if (!/^\d{10}$/.test(value))
        rule("Choose a place from the Philippine list.");
      const [place] = await c.db.unsafe(
        `select name from ${table} where ${column === "customer_group_id" ? "id" : "code"}=$1${column === "customer_group_id" ? " and deleted_at is null" : ""}`,
        [value],
      );
      if (!place) rule("This place or customer group is no longer available.");
      const [taken] = await c.db.unsafe(
        `select t.name from territory_coverage c join territories t on t.id=c.territory_id where c.${column}=$1 and t.id<>$2 and t.deleted_at is null and t.status='active' and tstzrange(t.effective_from,t.effective_to,'[)') && tstzrange($3::timestamptz,$4::timestamptz,'[)') limit 1`,
        [value, id, territory.effective_from, territory.effective_to],
      );
      if (taken)
        rule(
          `${place.name} already belongs to ${taken.name}. Remove it there first or choose another place or group.`,
        );
      desired.push({ [column]: value });
    }
  }
  const old =
    await c.db`select municipality_code,barangay_code,customer_group_id from territory_coverage where territory_id=${id}`;
  const keys = (/** @type {any[]} */ rows) =>
    rows
      .map((r) =>
        JSON.stringify([
          r.municipality_code ?? null,
          r.barangay_code ?? null,
          r.customer_group_id ?? null,
        ]),
      )
      .sort()
      .join("|");
  if (keys(old) === keys(desired) && type === territory.territory_type) return;
  // Check every old/new matching store, not an unrelated territory’s roster.
  const choices = JSON.stringify([...old, ...desired]);
  const affected =
    await c.db`select o.id from outlets o left join customer_profiles p on p.outlet_id=o.id and p.deleted_at is null where o.deleted_at is null and o.status<>'inactive' and (
    exists(select 1 from jsonb_array_elements(${choices}::text::jsonb) x where x->>'municipality_code'=p.municipality_code or x->>'barangay_code'=p.barangay_code or x->>'customer_group_id'=o.customer_group_id::text)
    or exists(select 1 from outlet_assignments a where a.outlet_id=o.id and a.territory_id=${id} and a.assignment_source='automatic' and a.deleted_at is null and (a.effective_to is null or a.effective_to>now())))`;
  for (const row of affected) {
    await access(c, "outlets", row.id, "territory.manage");
    await assertUnlocked(c, [row.id], [], c.now);
  }
  await c.db`delete from territory_coverage where territory_id=${id}`;
  for (const r of desired)
    await c.db`insert into territory_coverage(territory_id,municipality_code,barangay_code,customer_group_id) values(${id},${r.municipality_code ?? null},${r.barangay_code ?? null},${r.customer_group_id ?? null})`;
  await c.db`update territories set territory_type=${type} where id=${id}`;
  await c.db`select refresh_all_territory_coverage()`;
  for (const row of affected)
    await access(c, "outlets", row.id, "territory.manage");
}

/** @param {Ctx} c @param {Row} p */
export async function listCustomerGroups(c, p) {
  await requireCapability(c, "territory.read");
  const { size, cursor, q } = paging(p);
  const rows =
    await c.db`select g.* from customer_groups g where g.deleted_at is null and (${cursor}::uuid is null or g.id>${cursor}) and (g.name ilike ${`%${q}%`} or g.code ilike ${`%${q}%`}) order by g.id limit ${size + 1}`;
  return page(rows, size);
}

/** @param {Ctx} c @param {Row} b */
export async function saveCustomerGroup(c, b) {
  await requireNationalScope(c, ["admin"]);
  const name = required(b.name, "Name", 200);
  required(b.reason, "Reason");
  if (b.customerGroupId) {
    const [group] =
      await c.db`update customer_groups set name=${name},updated_at=now() where id=${uuid(b.customerGroupId)} and deleted_at is null returning id`;
    if (!group) rule("Customer group not found.");
    return group.id;
  }
  const [group] =
    await c.db`insert into customer_groups(code,name) values(${code(b.code)},${name}) returning id`;
  return group.id;
}

/** @param {Ctx} c @param {Row} b */
export async function linkCustomerGroup(c, b) {
  await requireNationalScope(c, ["admin"]);
  const ids = selections(b.outletIds, "stores");
  if (!ids.length || ids.length > 100) rule("Choose 1–100 stores.");
  const groupId = b.customerGroupId ? uuid(b.customerGroupId) : null;
  if (groupId) {
    const [group] =
      await c.db`select id from customer_groups where id=${groupId} and deleted_at is null`;
    if (!group) rule("Customer group not found.");
  }
  required(b.reason, "Reason");
  for (const id of ids) {
    await access(c, "outlets", uuid(id), "territory.manage");
    await assertUnlocked(c, [id], [], c.now);
    await c.db`update outlets set customer_group_id=${groupId} where id=${id}`;
  }
  return ids.length;
}
