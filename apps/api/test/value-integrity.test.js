import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { tx } from "@sunpride/db/client";
import { setup } from "./value-fixture.js";

mock.module("../src/domains/org/audit.js", () => ({
  writeAudit: async (/** @type {any} */ t, /** @type {any} */ e) => {
    await t`insert into audit_logs (subject,action,entity_type,entity_id,details) values (${e.subject},${e.action},${e.entityType},${e.entityId},${e.details ?? null})`;
  },
}));
mock.module("../src/domains/orders/pricing.js", () => ({
  resolvePrice: async () => ({ unitPriceCentavos: 2000, priceListId: null, source: "test" }),
  creditCheck: async () => ({ status: "unknown", limit: null, exposure: null }),
}));
mock.module("../src/domains/analytics/refresh.js", () => ({ enqueueRefresh: async () => {} }));
const { install } = await import("../src/domains/inventory/index.js");
const { postMovement } = await import("../src/domains/inventory/posting.js");
const { runIntegrityCheck } = await import("../src/domains/inventory/jobs.js");

/** @type {Awaited<ReturnType<typeof setup>>} */ let f;
/** @type {any} */ let admin;
/** @type {any} */ let viewer;
let depot = "",
  truck = "";
beforeAll(async () => {
  f = await setup({ installers: [install] });
  admin = await f.person("admin");
  viewer = await f.person("viewer");
  depot = await f.location("Int depot", "warehouse");
  truck = await f.location("Int truck", "truck");
  // The sale documents hang off a lot of other tables; this test only needs the rows, so drop THIS test
  // database's foreign keys on them (the DB is disposable, never the migrations).
  for (const table of ["store_sales", "store_reversals", "van_sales", "van_sale_lines"]) {
    const fks = await f.h.db`select conname from pg_constraint where conrelid=${table}::regclass and contype='f'`;
    for (const { conname } of fks)
      await f.h.db.unsafe(`alter table ${table} drop constraint "${conname}"`);
  }
}, 30000);
afterAll(async () => {
  await f?.h.close();
});
/** @param {any} data */
const post = (data) => tx(f.h.db, (t) => postMovement(t, { sourceType: "test", sourceId: "i", idempotencyKey: crypto.randomUUID(), occurredAt: Date.now(), actor: admin, organizationId: "sunpride", ...data }));
/** @param {string} productId @param {string|null} from @param {string|null} to @param {number} qty @param {any} [extra] @param {string} [kind] */
const move = (productId, from, to, qty, extra = {}, kind = from ? "transfer_ship" : "goods_receipt") =>
  post({ kind, lines: [{ productId, fromLocationId: from, toLocationId: to, quantityBase: qty, uom: "PC", ...extra }] });
const kinds = (/** @type {any} */ r) => r.alerts.map((/** @type {any} */ a) => a.kind).sort();
/** @param {string} path */
const api = async (path, who = admin, method = "GET") => {
  const res = await f.h.fetch(`/api/v1/inventory/${path}`, { method, headers: { cookie: who.cookie, "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
};

describe("nightly integrity check", () => {
  it("is clean when ledger = balances = batch balances", async () => {
    const plain = await f.product(),
      tracked = await f.product({ tracked: true });
    await move(plain.id, null, depot, 100, { unitCostMinor: 300 });
    await move(plain.id, depot, truck, 30);
    const lot = await f.lot(tracked.id, "CLEAN-1", 90);
    await move(tracked.id, null, depot, 50, { lotId: lot, unitCostMinor: 200 });
    await move(tracked.id, depot, null, 5, { lotId: lot }, "pos_sale");
    const r = await runIntegrityCheck(f.h.db);
    expect(r.differences).toBe(0);
    expect(r.alerts).toEqual([]);
    expect(r.compared).toBeGreaterThan(0);
    const [run] = await f.h.db`select * from inventory_reconciliation_runs where id=${r.runId}`;
    expect(run.status).toBe("completed");
    expect(run.scope).toBe("integrity");
  });

  it("detects drift between the ledger and the balance, raises one alert, and resolves it when fixed", async () => {
    const p = await f.product();
    await move(p.id, null, depot, 40, { unitCostMinor: 100 });
    await f.h.db`update inventory_balances set available_stock_base=available_stock_base+3,physical_base=physical_base+3 where product_id=${p.id} and location_id=${depot}`;
    const r = await runIntegrityCheck(f.h.db);
    expect(kinds(r)).toContain("ledger_vs_balance");
    const diff = (await f.h.db`select * from inventory_reconciliation_differences where run_id=${r.runId} and check_kind='ledger_vs_balance' and product_id=${p.id}`)[0];
    expect(diff.classification).toBe("unresolved");
    expect(Number(diff.operational_base)).toBe(40);
    expect(Number(diff.sap_base)).toBe(43);
    expect(Number(diff.difference_base)).toBe(-3);
    const open = await f.h.db`select * from inventory_integrity_alerts where kind='ledger_vs_balance' and status='open'`;
    expect(open).toHaveLength(1);
    expect(open[0].severity).toBe("critical");
    expect(open[0].message).toMatch(/does not match the movement ledger/);
    // a second night with the same drift updates the alert, it does not pile up new ones
    await runIntegrityCheck(f.h.db);
    expect(await f.h.db`select id from inventory_integrity_alerts where kind='ledger_vs_balance' and status='open'`).toHaveLength(1);
    // fix it
    await f.h.db`update inventory_balances set available_stock_base=available_stock_base-3,physical_base=physical_base-3 where product_id=${p.id} and location_id=${depot}`;
    const fixed = await runIntegrityCheck(f.h.db);
    expect(fixed.differences).toBe(0);
    const [alert] = await f.h.db`select status,resolved_by from inventory_integrity_alerts where kind='ledger_vs_balance' order by created_at desc limit 1`;
    expect(alert.status).toBe("resolved");
  });

  it("detects value, total, reserved and batch drift", async () => {
    const tracked = await f.product({ tracked: true });
    const lot = await f.lot(tracked.id, "DRIFT-1", 60);
    await move(tracked.id, null, depot, 20, { lotId: lot, unitCostMinor: 500 });
    await f.h.db`update inventory_balances set inventory_value_minor=inventory_value_minor+1,reserved_base=reserved_base+2 where product_id=${tracked.id} and location_id=${depot}`;
    await f.h.db`update inventory_lot_balances set physical_base=physical_base-1,available_base=available_base-1 where lot_id=${lot} and location_id=${depot}`;
    await f.h.db`update inventory_balances set physical_base=physical_base+1 where product_id=${tracked.id} and location_id=${depot}`;
    const r = await runIntegrityCheck(f.h.db);
    for (const k of ["value_vs_ledger", "reserved_vs_ledger", "lot_vs_ledger", "lot_vs_balance", "physical_vs_statuses"])
      expect(kinds(r)).toContain(k);
    expect(r.alerts.find((/** @type {any} */ a) => a.kind === "reserved_vs_ledger")?.severity).toBe("warning");
    await f.h.db`update inventory_balances set inventory_value_minor=inventory_value_minor-1,reserved_base=reserved_base-2,physical_base=physical_base-1 where product_id=${tracked.id} and location_id=${depot}`;
    await f.h.db`update inventory_lot_balances set physical_base=physical_base+1,available_base=available_base+1 where lot_id=${lot} and location_id=${depot}`;
    expect((await runIntegrityCheck(f.h.db)).differences).toBe(0);
  });

  it("every paid sale must have its stock movement, quantity and void reversal", async () => {
    const p = await f.product();
    await move(p.id, null, truck, 100, { unitCostMinor: 50 });
    const saleId = crypto.randomUUID(),
      okSaleId = crypto.randomUUID(),
      badQtyId = crypto.randomUUID();
    // a real movement for a store sale that exists, one whose sale document is missing
    const sold = await post({ kind: "pos_sale", sourceType: "store_sale", sourceId: okSaleId, lines: [{ productId: p.id, fromLocationId: truck, toLocationId: null, quantityBase: 4, uom: "PC" }] });
    await post({ kind: "pos_sale", sourceType: "store_sale", sourceId: badQtyId, lines: [{ productId: p.id, fromLocationId: truck, toLocationId: null, quantityBase: 6, uom: "PC" }] });
    const orphan = await post({ kind: "pos_sale", sourceType: "store_sale", sourceId: crypto.randomUUID(), lines: [{ productId: p.id, fromLocationId: truck, toLocationId: null, quantityBase: 1, uom: "PC" }] });
    await f.h.db.begin(async (t) => {
      const fake = () => crypto.randomUUID();
      const sale = (/** @type {string} */ id, /** @type {string} */ no, /** @type {string} */ movement, /** @type {number} */ qty) =>
        t`insert into store_sales (id,shift_id,order_id,device_id,receipt_number,fiscal_document_id,movement_id,captured_request,receipt,sold_at) values (${id},${fake()},${fake()},${fake()},${no},${fake()},${movement},${{}},${{ lines: [{ productId: p.id, quantityBase: qty }] }},now())`;
      await sale(okSaleId, "SI-OK-1", sold.movementId, 4);
      await sale(saleId, "SI-NOMOVE-1", fake(), 2); // movement row does not exist
      const bad = await t`select id from inventory_movements where source_document_id=${badQtyId}`;
      await sale(badQtyId, "SI-QTY-1", bad[0].id, 5); // sale says 5, stock moved 6
      await t`insert into store_reversals (id,sale_id,shift_id,kind,reason,requested_by,decided_by,status,request) values (${fake()},${okSaleId},${fake()},'void','test',${fake()},${fake()},'approved',${{}})`;
    });
    const r = await runIntegrityCheck(f.h.db);
    expect(kinds(r)).toEqual(expect.arrayContaining(["sale_without_stock", "stock_without_sale", "sale_quantity", "void_without_reversal"]));
    const refs = async (/** @type {string} */ k) => (await f.h.db`select entity_ref from inventory_reconciliation_differences where run_id=${r.runId} and check_kind=${k}`).map((/** @type {any} */ x) => x.entity_ref);
    expect(await refs("sale_without_stock")).toEqual(["store_sale:SI-NOMOVE-1"]);
    expect(await refs("sale_quantity")).toEqual(["store_sale:SI-QTY-1"]);
    expect((await refs("stock_without_sale")).join()).toContain("store_sale:");
    expect(await refs("void_without_reversal")).toHaveLength(1);
    const [d] = await f.h.db`select classification from inventory_reconciliation_differences where run_id=${r.runId} and check_kind='sale_without_stock'`;
    expect(d.classification).toBe("missing_outbound");
    expect(orphan.movementId).toBeTruthy();
  });

  it("a van sale without a movement, or with a different quantity, is drift too", async () => {
    const p = await f.product();
    await move(p.id, null, truck, 50);
    const sale = crypto.randomUUID(),
      sale2 = crypto.randomUUID();
    const m = await post({ kind: "pos_sale", sourceType: "van_sale", sourceId: sale2, lines: [{ productId: p.id, fromLocationId: truck, toLocationId: null, quantityBase: 3, uom: "PC" }] });
    await f.h.db.begin(async (t) => {
      const fake = () => crypto.randomUUID();
      for (const [id, no, qty] of /** @type {Array<[string,string,number]>} */ ([[sale, "VS-NOMOVE", 2], [sale2, "VS-QTY", 4]])) {
        await t`insert into van_sales (id,trip_id,receipt_number,total_centavos,receipt,captured_request) values (${id},${fake()},${no},100,${{}},${{}})`;
        await t`insert into van_sale_lines (sale_id,ordinal,product_id,quantity_base,total_centavos,facts) values (${id},1,${p.id},${qty},100,${{}})`;
      }
    });
    const r = await runIntegrityCheck(f.h.db);
    // the append-only store rows from the previous test stay behind and stay flagged; look at the van ones
    const refs = async (/** @type {string} */ k) => (await f.h.db`select entity_ref from inventory_reconciliation_differences where run_id=${r.runId} and check_kind=${k} and entity_ref like 'van_sale:%'`).map((/** @type {any} */ x) => x.entity_ref);
    expect(await refs("sale_without_stock")).toEqual(["van_sale:VS-NOMOVE"]);
    expect(await refs("sale_quantity")).toEqual(["van_sale:VS-QTY"]);
    expect(m.movementId).toBeTruthy();
  });

  it("only an administrator reads the status or runs it now; the job is scheduled nightly", async () => {
    const status = await api("integrity");
    expect(status.status).toBe(200);
    expect(status.body.lastRun.differences).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(status.body.alerts)).toBe(true);
    expect((await api("integrity", viewer)).status).toBe(403);
    expect((await api("integrity/run", viewer, "POST")).status).toBe(403);
    const ran = await api("integrity/run", admin, "POST");
    expect(ran.status).toBe(200);
    expect(ran.body.runId).toBeTruthy();
  });
});
