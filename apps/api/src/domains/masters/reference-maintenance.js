import { requireNationalScope } from "../../core/capabilities.js";
import { required, rule, uuid } from "../org/model.js";
import { assertUnlocked } from "../org/commands.js";
import { resolveGeography } from "./customers.js";
import { logReferenceChange } from "./reference-log.js";

/** @type {Record<string,{table:string,parent?:string,parentTable?:string}>} */
const PLACES = {
  region: { table: "ph_regions" },
  province: {
    table: "ph_provinces",
    parent: "region_code",
    parentTable: "ph_regions",
  },
  municipality: {
    table: "ph_municipalities",
    parent: "province_code",
    parentTable: "ph_provinces",
  },
  barangay: {
    table: "ph_barangays",
    parent: "municipality_code",
    parentTable: "ph_municipalities",
  },
};
/** @param {any} kind */
function placeKind(kind) {
  if (typeof kind !== "string" || !Object.hasOwn(PLACES, kind))
    rule("Choose a place type.");
  return PLACES[kind];
}
/** @param {any} v */
function placeCode(v) {
  if (typeof v !== "string" || !/^\d{10}$/.test(v))
    rule("Enter the ten-digit PSGC code.");
  return v;
}
/** @param {any} c */
export async function channelSetup(c) {
  await requireNationalScope(c, ["admin"]);
  return {
    rows: await c.db`select id,code,name,sales_org_code as "salesOrgCode",to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt" from customer_reference_values where list='distribution_channel' and active order by sales_org_code,sort_order,code`,
    salesOrgs:
      await c.db`select code,name from customer_reference_values where list='sales_organization' and active order by sort_order`,
  };
}
/** Distribution channels are the customer's SAP-shaped list, not the older selling taxonomy.
 * Stable keys and pricing/call-flow keys are never silently re-keyed. @param {any} c @param {any} b */
export async function saveChannel(c, b) {
  await requireNationalScope(c, ["admin"]);
  const reason = required(b.reason, "Reason for this change", 500);
  const name = required(b.name, "Channel name", 200);
  let before = null,
    row;
  if (b.id) {
    [before] =
      await c.db`select id,code,name,sales_org_code as "salesOrgCode",to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt" from customer_reference_values where id=${uuid(b.id)} and list='distribution_channel' and active`;
    if (!before) rule("Channel not found.");
    if (before.updatedAt !== b.baseUpdatedAt)
      rule("This channel changed. Reload before saving.");
    if (before.name === name) return { id: before.id };
    [row] =
      await c.db`update customer_reference_values set name=${name},updated_by=${c.actor.userId},updated_at=now() where id=${before.id} returning id,code,name,sales_org_code as "salesOrgCode"`;
    await c.db`update customer_profiles set distribution_channel_name=${name},updated_by=${c.actor.userId},updated_at=now() where sales_org_code=${row.salesOrgCode} and distribution_channel_code=${row.code} and deleted_at is null`;
  } else {
    const code = required(b.code, "Channel code", 40);
    const org = required(b.salesOrgCode, "Sales organization", 40);
    const [parent] =
      await c.db`select id from customer_reference_values where list='sales_organization' and code=${org} and active`;
    if (!parent) rule("Choose an existing sales organization.");
    const [duplicate] =
      await c.db`select id from customer_reference_values where list='distribution_channel' and sales_org_code=${org} and code=${code}`;
    if (duplicate)
      rule("That channel code already exists in this sales organization.");
    [row] =
      await c.db`insert into customer_reference_values(list,sales_org_code,code,name,sort_order,source,updated_by)
      values('distribution_channel',${org},${code},${name},coalesce((select max(sort_order)+1 from customer_reference_values where list='distribution_channel' and sales_org_code=${org}),1),'admin-setup',${c.actor.userId}) returning id,code,name,sales_org_code as "salesOrgCode"`;
  }
  await logReferenceChange(
    c,
    "channel",
    row.id,
    `${row.salesOrgCode} / ${row.code} · ${name}`,
    before && {
      code: before.code,
      name: before.name,
      salesOrgCode: before.salesOrgCode,
    },
    { code: row.code, name: row.name, salesOrgCode: row.salesOrgCode },
    reason,
  );
  return { id: row.id };
}

/** Search every geography tier with bounded, explicit paging. @param {any} c */
export async function placeSetup(c) {
  await requireNationalScope(c, ["admin"]);
  const q = c.url.searchParams;
  const { table, parent, parentTable } = placeKind(
    q.get("kind") ?? "municipality",
  );
  const offset = Number(q.get("offset") ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
    rule("Invalid place page.");
  const search = (q.get("q") ?? "").trim();
  if (search.length > 100) rule("Search must be at most 100 characters.");
  const like = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
  const rows = await c.db.unsafe(
    `select a.code,a.name,to_char(a.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt"${parent ? `,a.${parent} as "parentCode",p.name as "parentName"` : ""} from ${table} a ${parent ? `join ${parentTable} p on p.code=a.${parent}` : ""} where (a.name ilike $1 or a.code ilike $1) order by a.name,a.code limit 26 offset $2`,
    [like, offset],
  );
  return { rows: rows.slice(0, 25), hasMore: rows.length > 25 };
}

/** Rename/move the actual PSGC record, updating dependent parents and current customer
 * display fields atomically. Existing signed plan snapshots stay frozen; protected stores
 * refuse realignment. Territory membership uses the existing automatic assignment writer.
 * @param {any} c @param {any} b */
export async function savePlace(c, b) {
  await requireNationalScope(c, ["admin"]);
  const reason = required(b.reason, "Reason for this change", 500);
  const spec = placeKind(b.kind),
    code = placeCode(b.code),
    name = required(b.name, "Place name", 200);
  const [before] = await c.db.unsafe(
    `select *,to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "version" from ${spec.table} where code=$1`,
    [code],
  );
  if (b.create === true ? !!before : !before)
    rule(b.create ? "That PSGC code already exists." : "Place not found.");
  if (before && before.version !== b.baseUpdatedAt)
    rule("This place changed. Reload before saving.");
  let parent = null;
  if (spec.parent) {
    [parent] = await c.db.unsafe(
      `select * from ${spec.parentTable} where code=$1`,
      [placeCode(b.parentCode)],
    );
    if (!parent) rule("Choose an existing parent place.");
  }
  const snapshot = (/** @type {any} */ r) =>
    r
      ? {
          code: r.code,
          name: r.name,
          ...(spec.parent ? { parentCode: r[spec.parent] } : {}),
        }
      : null;
  const after = {
    code,
    name,
    ...(spec.parent ? { [spec.parent]: parent.code } : {}),
  };
  if (
    before &&
    before.name === name &&
    (!spec.parent || before[spec.parent] === parent.code)
  )
    return { id: c.actor.profileId };
  const affected = before
    ? await c.db.unsafe(
        `select p.* from customer_profiles p
    left join ph_barangays b on b.code=p.barangay_code
    left join ph_municipalities m on m.code=coalesce(b.municipality_code,p.municipality_code)
    left join ph_provinces v on v.code=coalesce(m.province_code,p.province_code)
    where p.deleted_at is null and ${b.kind === "barangay" ? "p.barangay_code" : b.kind === "municipality" ? "coalesce(b.municipality_code,p.municipality_code)" : b.kind === "province" ? "coalesce(m.province_code,p.province_code)" : "coalesce(v.region_code,p.region_code)"}=$1 order by p.outlet_id`,
        [code],
      )
    : [];
  // Label corrections leave assignment facts and signed plan snapshots unchanged.
  if (before && spec.parent && before[spec.parent] !== parent.code)
    for (const p of affected) await assertUnlocked(c, [p.outlet_id], [], c.now);
  if (before) {
    await c.db.unsafe(
      `update ${spec.table} set name=$1,updated_at=now()${spec.parent ? `,${spec.parent}=$3` : ""}${b.kind === "municipality" ? ",region_code=$4" : ""} where code=$2`,
      [
        name,
        code,
        ...(spec.parent ? [parent.code] : []),
        ...(b.kind === "municipality" ? [parent.region_code] : []),
      ],
    );
  } else {
    await c.db.unsafe(
      `insert into ${spec.table}(code,name${spec.parent ? `,${spec.parent}` : ""}${["province", "municipality"].includes(b.kind) ? ",kind" : ""}${b.kind === "municipality" ? ",region_code" : ""}) values($1,$2${spec.parent ? ",$3" : ""}${["province", "municipality"].includes(b.kind) ? `,'${b.kind === "province" ? "province" : "municipality"}'` : ""}${b.kind === "municipality" ? ",$4" : ""})`,
      [
        code,
        name,
        ...(spec.parent ? [parent.code] : []),
        ...(b.kind === "municipality" ? [parent.region_code] : []),
      ],
    );
  }
  if (b.kind === "province")
    await c.db`update ph_municipalities set region_code=${parent.code},updated_at=now() where province_code=${code} and region_code<>${parent.code}`;
  for (const p of affected) {
    const geo = await resolveGeography(c.db, {
      regionCode: p.region_code,
      provinceCode: p.province_code,
      municipalityCode: p.municipality_code,
      barangayCode: p.barangay_code,
    });
    const municipalityCode =
      geo.barangay?.municipalityCode ?? p.municipality_code;
    const resolved = await resolveGeography(c.db, { municipalityCode });
    const provinceCode = resolved.municipality?.provinceCode ?? p.province_code;
    const upper = await resolveGeography(c.db, { provinceCode });
    const regionCode = upper.province?.regionCode ?? p.region_code;
    const region = await resolveGeography(c.db, { regionCode });
    await c.db`update customer_profiles set region_code=${regionCode},region_name=${region.region?.name ?? null},province_code=${provinceCode},province_name=${upper.province?.name ?? null},municipality_code=${municipalityCode},municipality_name=${resolved.municipality?.name ?? null},barangay_name=${geo.barangay?.name ?? null},updated_by=${c.actor.userId},updated_at=now() where outlet_id=${p.outlet_id}`;
    await c.db`update outlets o set address=customer_address_line(p.room_stall_no,p.floor,p.house_no,p.street1,p.street2,p.barangay_name,p.municipality_name,p.province_name,p.postal_code) from customer_profiles p where o.id=${p.outlet_id} and p.outlet_id=o.id and not p.address_custom`;
    await c.db`update customer_ship_tos s set ship_to_address=o.address,updated_by=${c.actor.userId},updated_at=now() from outlets o where s.outlet_id=${p.outlet_id} and o.id=s.outlet_id and s.same_as_customer and s.deleted_at is null`;
  }
  await c.db`insert into ph_geography_releases(release,source,counts,loaded_by) values(${`admin-${crypto.randomUUID()}`},${{ type: "admin-setup", reason }},${{ changedPlace: code }},${c.actor.userId})`;
  await logReferenceChange(
    c,
    "place",
    `${b.kind}:${code}`,
    `${name} · ${code}`,
    snapshot(before),
    snapshot(after),
    reason,
  );
  return { id: c.actor.profileId };
}
