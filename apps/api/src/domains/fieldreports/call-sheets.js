import { outletOwnerUnit } from "../org/scope.js";
import {
  date,
  day,
  dto,
  fail,
  gate,
  ms,
  outlet,
  requireCapability,
  roleHas,
  text,
  uuid,
} from "./common.js";
export const HEADER_FIELDS = [
  "accountName",
  "address",
  "buyerName",
  "contactNumber",
  "accountInCharge",
  "receivingInCharge",
  "distributorName",
  "distributorSchedule",
  "foc",
  "pricing",
];
/** @param {any} a @param {any} o */
function header(a, o) {
  const h = /** @type {Record<string,any>} */ ({});
  for (const k of HEADER_FIELDS)
    h[k] =
      a?.["header_" + k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase())] ??
      null;
  h.accountName ??= o.name;
  h.address ??= o.address;
  return h;
}
/** @param {any} c @param {any} a */
export async function detail(c, a) {
  const o = await outlet(c, a.outletId);
  const [account] =
    await c.db`select * from call_sheet_accounts where outlet_id=${o.id} and deleted_at is null`;
  const lines = account
    ? await c.db`select l.product_id,p.code,p.name,p.uom,p.active,l.pricing from call_sheet_account_lines l join products p on p.id=l.product_id where l.call_sheet_account_id=${account.id} and l.deleted_at is null order by ordinal`
    : [];
  return {
    outlet: {
      id: o.id,
      code: o.code,
      name: o.name,
      address: o.address,
      status: o.status,
    },
    canEdit: roleHas(c.actor.role, "outlet.manage"),
    account: account
      ? {
          revision: account.revision,
          updatedAt: ms(account.updated_at),
          header: header(account, o),
          lines: lines.map((/** @type {any} */ l) => ({
            productId: l.product_id,
            code: l.code,
            name: l.name,
            uom: l.uom,
            active: l.active,
            pricing: l.pricing,
          })),
        }
      : null,
  };
}
/** @param {any} c @param {any} a @param {any} platform */
export async function save(c, a, platform) {
  const o = await outlet(c, a.outletId, "outlet.manage");
  if (o.status !== "active") fail("Choose an active account");
  await c.db`select pg_advisory_xact_lock(hashtextextended(${o.id},0))`;
  const [old] =
    await c.db`select * from call_sheet_accounts where outlet_id=${o.id} for update`;
  if ((old?.revision ?? null) !== a.expectedRevision)
    fail(
      "The call sheet changed. Refresh before saving.",
      409,
      "revision_conflict",
    );
  if (!Array.isArray(a.lines) || a.lines.length > 100)
    fail("Use at most 100 products");
  if (
    new Set(a.lines.map((/** @type {any} */ l) => l.productId)).size !==
    a.lines.length
  )
    fail("A product may appear only once");
  const h = a.header;
  if (!h || !text(h.accountName, 200)) fail("Name the account");
  for (const k of HEADER_FIELDS) if (h[k] !== undefined) text(h[k], 500);
  for (const l of a.lines) {
    uuid(l.productId);
    const [p] =
      await c.db`select active from products where id=${l.productId} and deleted_at is null`;
    if (!p?.active) fail("Choose active products");
    if (l.pricing !== undefined) text(l.pricing, 500);
  }
  if (old) {
    const [rev] =
      await c.db`insert into call_sheet_account_revisions(organization_id,outlet_id,revision,effective_from,superseded_at) values(${old.organization_id},${o.id},${old.revision},${old.updated_at},${new Date(c.now)}) returning id`;
    const oldLines =
      await c.db`select * from call_sheet_account_lines where call_sheet_account_id=${old.id} and deleted_at is null order by ordinal`;
    for (const [i, l] of oldLines.entries())
      await c.db`insert into call_sheet_account_revision_products(call_sheet_account_revision_id,ordinal,product_id) values(${rev.id},${i},${l.product_id})`;
  }
  const revision = (old?.revision ?? 0) + 1;
  const [r] =
    await c.db`insert into call_sheet_accounts(organization_id,outlet_id,revision,header_account_name,header_address,header_buyer_name,header_contact_number,header_account_in_charge,header_receiving_in_charge,header_distributor_name,header_distributor_schedule,header_foc,header_pricing,updated_by) values(${o.organization_id},${o.id},${revision},${h.accountName},${h.address ?? null},${h.buyerName ?? null},${h.contactNumber ?? null},${h.accountInCharge ?? null},${h.receivingInCharge ?? null},${h.distributorName ?? null},${h.distributorSchedule ?? null},${h.foc ?? null},${h.pricing ?? null},${c.actor.userId}) on conflict (outlet_id) do update set revision=excluded.revision,header_account_name=excluded.header_account_name,header_address=excluded.header_address,header_buyer_name=excluded.header_buyer_name,header_contact_number=excluded.header_contact_number,header_account_in_charge=excluded.header_account_in_charge,header_receiving_in_charge=excluded.header_receiving_in_charge,header_distributor_name=excluded.header_distributor_name,header_distributor_schedule=excluded.header_distributor_schedule,header_foc=excluded.header_foc,header_pricing=excluded.header_pricing,updated_by=excluded.updated_by returning *`;
  await c.db`update call_sheet_account_lines set deleted_at=${new Date(c.now)} where call_sheet_account_id=${r.id} and deleted_at is null`;
  for (const [i, l] of a.lines.entries())
    await c.db`insert into call_sheet_account_lines(call_sheet_account_id,ordinal,product_id,pricing) values(${r.id},${(old?.revision ?? 0) * 1000 + i},${l.productId},${l.pricing ?? null})`;
  await platform.recordChange(c.db, {
    entity: "call_sheet_accounts",
    entityId: r.id,
    scopeKey: await outletOwnerUnit(c.db, o.id, c.now),
    op: "upsert",
  });
  return { revision };
}
/** @param {any} c @param {any} a */
export async function list(c, a) {
  await requireCapability(c, "outlet.read");
  const size = a.paginationOpts?.numItems ?? 30;
  if (!Number.isInteger(size) || size < 1 || size > 50)
    fail("Page size must be 1–50", 400);
  const offset = Number(a.paginationOpts?.cursor ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
    fail("Invalid page cursor", 400);
  const rows =
    await c.db`select a.*,o.code,o.name,(select count(*) from call_sheet_account_lines l where l.call_sheet_account_id=a.id and l.deleted_at is null) line_count from call_sheet_accounts a join outlets o on o.id=a.outlet_id where a.deleted_at is null order by a.updated_at desc,a.id offset ${offset} limit ${size + 1}`;
  const page = [];
  for (const r of rows.slice(0, size)) {
    try {
      await outlet(c, r.outlet_id);
    } catch (e) {
      if (e instanceof Error && "status" in e && e.status === 403) continue;
      throw e;
    }
    page.push({
      outletId: r.outlet_id,
      outletCode: r.code,
      outletName: r.name,
      accountName: r.header_account_name,
      lineCount: Number(r.line_count),
      revision: r.revision,
      updatedAt: ms(r.updated_at),
    });
  }
  return {
    page,
    isDone: rows.length <= size,
    continueCursor: rows.length > size ? String(offset + size) : "",
  };
}
/** @param {any} c @param {any} a */
export async function month(c, a) {
  if (
    typeof a.localMonth !== "string" ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(a.localMonth)
  )
    fail("Use a valid month", 400);
  const info = await detail(c, a);
  const rows =
    await c.db`select e.*,p.code,p.name,p.uom from call_sheet_entries e join products p on p.id=e.product_id where e.outlet_id=${a.outletId} and e.local_month=${a.localMonth} and e.deleted_at is null order by e.service_date,e.server_time,e.id`;
  if (rows.length > 20000)
    fail("Too many call-sheet entries", 422, "report_limit");
  for (const r of rows) await gate(c, "outlet.read", r.org_unit_id);
  const products = new Map();
  for (const l of info.account?.lines ?? [])
    products.set(l.productId, { ...l, onSheet: true });
  for (const r of rows)
    if (!products.has(r.product_id))
      products.set(r.product_id, {
        productId: r.product_id,
        code: r.code,
        name: r.name,
        uom: r.uom,
        pricing: null,
        onSheet: false,
      });
  const result = [];
  for (const p of products.values()) {
    const [barcode] =
      await c.db`select barcode from product_barcodes where product_id=${p.productId} and active and deleted_at is null order by created_at desc,id limit 1`;
    const weeks = [1, 2, 3, 4].map((week) => {
      const own = rows.filter(
        (/** @type {any} */ r) =>
          r.product_id === p.productId && r.week === week,
      );
      const sum = (/** @type {string} */ k) =>
        own.some((/** @type {any} */ r) => r[k] !== null)
          ? own.reduce(
              (/** @type {number} */ s, /** @type {any} */ r) =>
                s + (r[k] ?? 0),
              0,
            )
          : null;
      return {
        week,
        order: sum("order_qty"),
        beginningInventory:
          own.find((/** @type {any} */ r) => r.beginning_inventory !== null)
            ?.beginning_inventory ?? null,
        take: sum("take"),
        delivered: sum("delivered"),
        offtake: sum("offtake"),
        endInventory:
          own.findLast((/** @type {any} */ row) => row.end_inventory !== null)
            ?.end_inventory ?? null,
      };
    });
    result.push({ ...p, barcode: barcode?.barcode ?? null, weeks });
  }
  return {
    outlet: info.outlet,
    localMonth: a.localMonth,
    configured: !!info.account,
    revision: info.account?.revision ?? null,
    header: info.account?.header ?? header(null, info.outlet),
    rows: result,
    capturedVisits: new Set(rows.map((/** @type {any} */ r) => r.visit_id))
      .size,
    lastCapturedAt: ms(rows.at(-1)?.server_time),
  };
}
/** Write entries from an already persisted visit activity, never a second visit writer.
 * @param {any} c @param {any} a @param {any} platform */
export async function recordEntries(c, a, platform) {
  uuid(a.activityId);
  const [v] =
    await c.db`select v.*,a.id activity_id,a.activity,a.activity_kind from visit_activities a join visit_executions v on v.id=a.visit_id where a.id=${a.activityId} and a.deleted_at is null and v.deleted_at is null`;
  if (!v || v.activity_kind !== "call_sheet")
    fail("A recorded call-sheet activity is required");
  await gate(c, "visit.record", v.org_unit_id);
  if (v.assignee_profile_id !== c.actor.profileId)
    fail("Only the visit author may capture its call sheet", 403);
  const entries = v.activity.lines;
  if (
    !Array.isArray(entries) ||
    entries.length < 1 ||
    entries.length > 100 ||
    new Set(entries.map((e) => e.productId)).size !== entries.length
  )
    fail("Invalid call-sheet activity");
  const [account] =
    await c.db`select * from call_sheet_accounts where outlet_id=${v.outlet_id} and deleted_at is null`;
  if (!account) fail("An office-maintained call sheet is required");
  // v1/v2 call_sheet activity has no template revision. Office edits must not strand
  // an offline capture: stamp the server's revision, allow active products off-sheet.
  const revision = account.revision;
  for (const e of entries) {
    uuid(e.productId);
    const [product] =
      await c.db`select active from products where id=${e.productId} and deleted_at is null`;
    if (!product?.active) fail("Choose active products");
    const measures = [
      "order",
      "beginningInventory",
      "take",
      "delivered",
      "offtake",
      "endInventory",
    ];
    if (!measures.some((k) => e[k] != null))
      fail("Capture at least one quantity per product");
    for (const k of measures)
      if (
        e[k] != null &&
        (!Number.isSafeInteger(e[k]) || e[k] < 0 || e[k] > 1_000_000)
      )
        fail(
          "Call-sheet quantities must be whole base units from zero to one million",
        );
    const [saved] =
      await c.db`insert into call_sheet_entries(organization_id,org_unit_id,outlet_id,visit_id,activity_id,assignee_profile_id,service_date,local_month,week,product_id,template_revision,order_qty,beginning_inventory,take,delivered,offtake,end_inventory,server_time) values(${v.organization_id},${v.org_unit_id},${v.outlet_id},${v.id},${a.activityId},${v.assignee_profile_id},${day(v.service_date)},${day(v.service_date).slice(0, 7)},${Math.min(4, Math.ceil(Number(day(v.service_date).slice(8)) / 7))},${e.productId},${revision},${e.order ?? null},${e.beginningInventory ?? null},${e.take ?? null},${e.delivered ?? null},${e.offtake ?? null},${e.endInventory ?? null},${new Date(c.now)}) on conflict (activity_id,product_id) where deleted_at is null do nothing returning id`;
    if (saved)
      await platform.recordChange(c.db, {
        entity: "call_sheet_entries",
        entityId: saved.id,
        scopeKey: v.org_unit_id,
        op: "upsert",
      });
  }
  return { recorded: entries.length };
}
