import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { tx } from "@sunpride/db/client";
import { setup } from "./value-fixture.js";

mock.module("../src/domains/org/audit.js", () => ({
  writeAudit: async (/** @type {any} */ t, /** @type {any} */ e) => {
    await t`insert into audit_logs (subject,action,entity_type,entity_id,details) values (${e.subject},${e.action},${e.entityType},${e.entityId},${e.details ?? null})`;
  },
}));
const unpriced = new Set();
mock.module("../src/domains/orders/pricing.js", () => ({
  resolvePrice: async (/** @type {any} */ _db, /** @type {any} */ q) => ({
    unitPriceCentavos: unpriced.has(q.productId) ? null : 2000,
    priceListId: null,
    source: "test default price",
  }),
  creditCheck: async () => ({ status: "unknown", limit: null, exposure: null }),
}));
mock.module("../src/domains/analytics/refresh.js", () => ({
  enqueueRefresh: async () => {},
}));
const { install } = await import("../src/domains/inventory/index.js");
const { postMovement } = await import("../src/domains/inventory/posting.js");

/** @type {Awaited<ReturnType<typeof setup>>} */ let f;
/** @type {any} */ let admin;
/** @type {any} */ let viewer;
let depot = "",
  truck = "",
  bin = "";
beforeAll(async () => {
  f = await setup({ installers: [install] });
  admin = await f.person("admin");
  viewer = await f.person("viewer");
  depot = await f.location("Val depot", "warehouse");
  truck = await f.location("Val truck", "truck");
  bin = await f.location("Val bin", "bin");
  await f.h
    .db`update inventory_locations set parent_location_id=${depot} where id=${bin}`;
}, 30000);
afterAll(async () => {
  await f?.h.close();
});
/** @param {any} who @param {string} path */
async function read(who, path) {
  const res = await f.h.fetch(`/api/v1/inventory/${path}`, {
    headers: { cookie: who.cookie },
  });
  const ct = res.headers.get("content-type") ?? "";
  return {
    status: res.status,
    body: ct.includes("json") ? /** @type {any} */ (await res.json()) : await res.text(),
    headers: res.headers,
  };
}
/** @param {any} who @param {string} action @param {any} body */
async function command(who, action, body) {
  const res = await f.h.fetch(`/api/v1/inventory/${action}`, {
    method: "POST",
    headers: { cookie: who.cookie, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), ...body }),
  });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}
/** @param {string} productId @param {string|null} from @param {string|null} to @param {number} qty @param {any} [extra] @param {number} [at] */
const move = (productId, from, to, qty, extra = {}, at = Date.now()) =>
  tx(f.h.db, (t) =>
    postMovement(t, {
      kind: from && !to ? "pos_sale" : from ? "transfer_ship" : "goods_receipt",
      sourceType: "test",
      sourceId: productId,
      idempotencyKey: crypto.randomUUID(),
      occurredAt: at,
      actor: admin,
      organizationId: "sunpride",
      lines: [
        { productId, fromLocationId: from, toLocationId: to, quantityBase: qty, uom: "PC", ...extra },
      ],
    }),
  );

describe("valuation and stock card", () => {
  it("cost value uses the weighted average from the ledger and equals the stock card closing value", async () => {
    const p = await f.product({ perCase: 24 });
    // 48 pc at P10.00, then 24 pc at P13.00 -> avg P11.00 on 72 pc = P792.00
    await move(p.id, null, depot, 48, { unitCostMinor: 1000 });
    await move(p.id, null, depot, 24, { unitCostMinor: 1300 });
    // sell 12 pc out of the depot: cost leaves at the average
    await move(p.id, depot, null, 12);
    const v = await read(admin, `valuation?basis=cost&productId=${p.id}`);
    expect(v.status).toBe(200);
    const row = v.body.rows.find((/** @type {any} */ r) => r.locationId === depot);
    expect(row.onHand.base).toBe(60);
    expect(row.onHand.display).toBe("2 cs 12 pc");
    expect(row.costValueCentavos).toBe(60 * 1100);
    expect(row.sellingValueCentavos).toBe(60 * 2000);
    expect(v.body.basis).toBe("cost");
    expect(v.body.valueLabel).toMatch(/^Cost value/);
    expect(v.body.secondaryValueLabel).toMatch(/^Selling value/);
    expect(row.available.base).toBe(60);
    const card = await read(admin, `stock-card?productId=${p.id}&locationId=${depot}`);
    expect(card.status).toBe(200);
    expect(card.body.closing.valueCentavos).toBe(row.costValueCentavos);
    expect(card.body.closing.quantity.base).toBe(60);
    expect(card.body.reconcilesToday).toBe(true);
    expect(card.body.rows.map((/** @type {any} */ r) => r.balance.base)).toEqual([48, 72, 60]);
    expect(card.body.rows.map((/** @type {any} */ r) => r.in?.base ?? 0)).toEqual([48, 24, 0]);
    expect(card.body.rows.map((/** @type {any} */ r) => r.out?.base ?? 0)).toEqual([0, 0, 12]);
    expect(card.body.rows.map((/** @type {any} */ r) => r.valueBalanceCentavos)).toEqual([48000, 79200, 66000]);
    expect(card.body.opening.quantity.base).toBe(0);
  });

  it("the Stock on hand cost total equals the sum of every stock card closing value", async () => {
    const products = [await f.product(), await f.product(), await f.product()];
    for (const [i, p] of products.entries()) {
      await move(p.id, null, depot, 100 + i, { unitCostMinor: 700 + i * 50 });
      await move(p.id, depot, truck, 10 + i);
      await move(p.id, truck, null, 3);
    }
    const v = await read(admin, "valuation?basis=cost");
    let closing = 0;
    for (const r of v.body.rows) {
      const card = await read(admin, `stock-card?productId=${r.productId}&locationId=${r.locationId}`);
      expect(card.body.reconcilesToday).toBe(true);
      closing += card.body.closing.valueCentavos;
    }
    expect(v.body.totals.costValueCentavos).toBe(closing);
    expect(closing).toBeGreaterThan(0);
  });

  it("the stock card has an opening balance for the period and links a receipt by its number", async () => {
    const p = await f.product();
    const day = (/** @type {number} */ n) => Date.now() - n * 86400000;
    await move(p.id, null, depot, 20, { unitCostMinor: 500 }, day(10));
    const rec = await command(admin, "receipts/post", {
      receivingLocationId: depot,
      deliveryReference: "DR-77",
      lines: [{ productId: p.id, quantityBase: 5, unitCostMinor: 500 }],
    });
    expect(rec.status).toBe(200);
    const from = new Date(day(2)).toISOString().slice(0, 10);
    const card = await read(admin, `stock-card?productId=${p.id}&locationId=${depot}&from=${from}`);
    expect(card.body.opening.quantity.base).toBe(20);
    expect(card.body.rows).toHaveLength(1);
    const [r] = card.body.rows;
    const [doc] = await f.h.db`select receipt_number from goods_receipts where id=${rec.body.id}`;
    expect(r.documentNumber).toBe(doc.receipt_number);
    expect(r.link).toEqual({ type: "goods_receipt", id: rec.body.id });
    expect(r.balance.base).toBe(25);
    expect(card.body.closing.quantity.base).toBe(25);
  });

  it("splits Available / Reserved / On hold / Damaged / Expired / In transit and filters by location tree and status", async () => {
    const p = await f.product();
    await move(p.id, null, depot, 100, { unitCostMinor: 100 });
    await move(p.id, null, bin, 40, { unitCostMinor: 100 });
    await move(p.id, depot, depot, 10, { fromStockStatus: "available", toStockStatus: "damaged" });
    await tx(f.h.db, (t) =>
      postMovement(t, {
        kind: "status_change", sourceType: "test", sourceId: "s", idempotencyKey: crypto.randomUUID(), occurredAt: Date.now(), actor: admin, organizationId: "sunpride",
        lines: [
          { productId: p.id, fromLocationId: depot, toLocationId: depot, quantityBase: 7, uom: "PC", fromStockStatus: "available", toStockStatus: "quality_hold" },
        ],
      }),
    );
    const tree = await read(admin, `valuation?productId=${p.id}&locationId=${depot}`);
    // depot + its child bin
    expect(tree.body.rows.map((/** @type {any} */ r) => r.locationId).sort()).toEqual([bin, depot].sort());
    const d = tree.body.rows.find((/** @type {any} */ r) => r.locationId === depot);
    expect(d.hold.base).toBe(7);
    expect(d.damaged.base).toBe(10);
    expect(d.available.base).toBe(100 - 17);
    expect(d.onHand.base).toBe(100);
    const hold = await read(admin, `valuation?productId=${p.id}&status=hold`);
    expect(hold.body.rows.map((/** @type {any} */ r) => r.locationId)).toEqual([depot]);
    expect((await read(admin, `valuation?status=bogus`)).status).toBe(422);
  });

  it("exports CSV with money in pesos and a labelled second value column", async () => {
    const p = await f.product({ perCase: 12 });
    await move(p.id, null, truck, 30, { unitCostMinor: 1275 });
    const csv = await read(admin, `valuation?basis=cost&productId=${p.id}&format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const lines = String(csv.body).replace("\uFEFF", "").trim().split("\r\n");
    const header = lines[0].split(",").map((/** @type {string} */ h) => h.replaceAll('"', ""));
    expect(header.indexOf("Cost value (PHP)")).toBeGreaterThan(-1);
    expect(header.indexOf("Cost value (PHP)")).toBeLessThan(header.indexOf("Selling value (PHP)"));
    const cells = lines[1].split(",").map((/** @type {string} */ h) => h.replaceAll('"', ""));
    expect(cells[header.indexOf("Cost value (PHP)")]).toBe("382.50");
    expect(cells[header.indexOf("Selling value (PHP)")]).toBe("600.00");
    expect(cells[header.indexOf("On hand cases")]).toBe("2");
    expect(cells[header.indexOf("On hand pieces")]).toBe("6");
    const selling = await read(admin, `valuation?basis=selling&productId=${p.id}&format=csv`);
    const sh = String(selling.body).replace("\uFEFF", "").split("\r\n")[0];
    expect(sh.indexOf("Selling value")).toBeLessThan(sh.indexOf("Cost value"));
  });

  it("flags stock with no cost instead of pretending it is worth zero, and keeps unknown prices unknown", async () => {
    const p = await f.product();
    await move(p.id, null, depot, 10); // no unit cost
    unpriced.add(p.id);
    const v = await read(admin, `valuation?productId=${p.id}`);
    unpriced.delete(p.id);
    expect(v.body.rows[0].costKnown).toBe(false);
    expect(v.body.rows[0].sellingValueCentavos).toBeNull();
    expect(v.body.totals.rowsWithoutCost).toBe(1);
    expect(v.body.totals.sellingValueCentavos).toBeNull();
  });

  it("groups by batch with expiry and honours the expiring-within filter", async () => {
    const p = await f.product({ tracked: true });
    const soon = Date.now() + 10 * 86400000,
      later = Date.now() + 200 * 86400000;
    for (const [lot, exp] of /** @type {Array<[string,number]>} */ ([["SOON", soon], ["LATER", later]])) {
      const r = await command(admin, "receipts/post", {
        receivingLocationId: depot,
        lines: [{ productId: p.id, quantityBase: 24, lotNumber: lot, expiresAt: exp, unitCostMinor: 400 }],
      });
      expect(r.status).toBe(200);
    }
    const all = await read(admin, `valuation?productId=${p.id}&groupBy=lot`);
    expect(all.body.rows.map((/** @type {any} */ r) => r.lotNumber)).toEqual(["SOON", "LATER"]);
    expect(all.body.rows[0].daysToExpiry).toBe(10);
    expect(all.body.rows[0].costValueCentavos).toBe(24 * 400);
    const near = await read(admin, `valuation?productId=${p.id}&groupBy=lot&expiringWithinDays=30`);
    expect(near.body.rows.map((/** @type {any} */ r) => r.lotNumber)).toEqual(["SOON"]);
  });

  it("is scoped like every stock read: a person with no stock scope sees nothing and an unknown location is refused", async () => {
    const res = await read(admin, `stock-card?productId=${crypto.randomUUID()}&locationId=${crypto.randomUUID()}`);
    expect(res.status).toBe(404);
    const bad = await read(admin, "stock-card?productId=nope&locationId=nope");
    expect(bad.status).toBe(422);
    const v = await read(viewer, "valuation");
    expect(v.status).toBe(200);
  });
});
