import { requireNationalScope } from "../../core/capabilities.js";
import { required, rule, uuid } from "../org/model.js";
import { logReferenceChange } from "./reference-log.js";

const VERSION = `to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** SP-0227 truck stock reasons. Readable by anyone who can see truck stock; edited by national admins.
 * @param {any} c */
export async function stockReasonSetup(c) {
  await requireNationalScope(c, ["admin"]);
  return {
    rows: await c.db.unsafe(
      `select id,code,name,active,sort_order as "sortOrder",${VERSION} as "updatedAt" from truck_stock_reasons order by active desc,sort_order,name`,
    ),
  };
}

/** Add, rename or (de)activate one reason. A used reason keeps its row; saved counts keep
 * the name they were recorded with. @param {any} c @param {any} b */
export async function saveStockReason(c, b) {
  await requireNationalScope(c, ["admin"]);
  const reason = required(b.reason, "Reason for this change", 500);
  const name = required(b.name, "Stock reason name", 120);
  const active = b.active === undefined ? true : b.active;
  if (typeof active !== "boolean") rule("Choose active or inactive.");
  let before = null,
    row;
  if (b.id) {
    [before] = await c.db.unsafe(
      `select id,code,name,active,${VERSION} as "updatedAt" from truck_stock_reasons where id=$1 for update`,
      [uuid(b.id)],
    );
    if (!before) rule("Stock reason not found.");
    if (before.updatedAt !== b.baseUpdatedAt)
      rule("This stock reason changed. Reload before saving.");
    if (before.name === name && before.active === active)
      return { id: before.id };
  }
  if (active) {
    const [clash] =
      await c.db`select id from truck_stock_reasons where active and lower(name)=lower(${name}) and id<>${before?.id ?? "00000000-0000-0000-0000-000000000000"}`;
    if (clash) rule("An active stock reason already has that name.");
  }
  if (before) {
    if (!active) {
      const [{ n }] =
        await c.db`select count(*)::int as n from truck_stock_reasons where active and id<>${before.id}`;
      if (n === 0) rule("Keep at least one active stock reason.");
    }
    [row] =
      await c.db`update truck_stock_reasons set name=${name},active=${active},updated_by=${c.actor.userId},updated_at=now() where id=${before.id} returning id,code,name,active`;
  } else {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 30) || "reason";
    const [{ n }] =
      await c.db`select count(*)::int as n from truck_stock_reasons where code=${base} or code like ${base + "\\_%"}`;
    const code = n ? `${base}_${n + 1}` : base;
    [row] =
      await c.db`insert into truck_stock_reasons(code,name,active,sort_order,updated_by)
      values(${code},${name},${active},coalesce((select max(sort_order)+1 from truck_stock_reasons),1),${c.actor.userId}) returning id,code,name,active`;
  }
  await logReferenceChange(
    c,
    "stock_reason",
    row.id,
    row.name,
    before && { name: before.name, active: before.active },
    { name: row.name, active: row.active },
    reason,
  );
  return { id: row.id };
}
