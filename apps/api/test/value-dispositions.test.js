import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { tx } from "@sunpride/db/client";
import { join } from "node:path";
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

/** @type {Awaited<ReturnType<typeof setup>>} */ let f;
/** @type {any} */ let admin;
/** @type {any} */ let manager;
/** @type {any} */ let approver;
/** @type {any} */ let viewer;
let depot = "";
beforeAll(async () => {
  f = await setup({ installers: [install] });
  [admin, manager, approver, viewer] = await Promise.all([f.person("admin"), f.person("manager"), f.person("approver"), f.person("viewer")]);
  depot = await f.location("Disp depot", "warehouse");
}, 30000);
afterAll(async () => {
  await f?.h.close();
});
/** @param {any} who @param {string} action @param {any} body */
async function command(who, action, body) {
  const res = await f.h.fetch(`/api/v1/inventory/${action}`, {
    method: "POST",
    headers: { cookie: who.cookie, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), ...body }),
  });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}
/** @param {any} who @param {string} path */
async function read(who, path) {
  const res = await f.h.fetch(`/api/v1/inventory/${path}`, { headers: { cookie: who.cookie } });
  const ct = res.headers.get("content-type") ?? "";
  return { status: res.status, body: ct.includes("json") ? /** @type {any} */ (await res.json()) : await res.arrayBuffer(), headers: res.headers };
}
/** @param {string} productId @param {number} qty @param {string} status @param {any} [extra] */
const stockIn = (productId, qty, status, extra = {}) =>
  tx(f.h.db, (t) =>
    postMovement(t, {
      kind: "goods_receipt", sourceType: "test", sourceId: productId, idempotencyKey: crypto.randomUUID(), occurredAt: Date.now(), actor: admin, organizationId: "sunpride",
      lines: [{ productId, fromLocationId: null, toLocationId: depot, quantityBase: qty, uom: "PC", stockStatus: status, unitCostMinor: 1000, ...extra }],
    }),
  );
/** a stored photo owned by `who`, with real bytes @param {any} who */
async function photoFor(who, tag = "x") {
  const bytes = new TextEncoder().encode(`jpeg-${tag}-${crypto.randomUUID()}`);
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const leaf = `${digest}.jpg`;
  await Bun.write(join(f.h.filesDir, leaf), bytes);
  await f.h.db`insert into files (purpose,sha256,mime,size,path,status,created_by,stored_at) values ('disposition-photo',${digest},'image/jpeg',${bytes.length},${leaf},'stored',${who.userId},now())`;
  return digest;
}
/** @param {string} productId @param {string} status */
const balance = async (productId, status) => {
  const col = { available: "available_stock_base", damaged: "damaged_base", expired: "expired_base", quality_hold: "quality_hold_base" }[/** @type {"available"} */ (status)];
  const [b] = await f.h.db.unsafe(`select ${col} as q,physical_base from inventory_balances where product_id=$1 and location_id=$2`, [productId, depot]);
  return Number(b?.q ?? 0);
};
const request = (/** @type {any} */ body, who = admin) =>
  command(who, "dispositions/request", { locationId: depot, ...body });

describe("IP-INT2 ask 4: office photo upload for bad orders", () => {
  /** @param {any} who @param {Uint8Array} bytes */
  const upload = async (who, bytes) => {
    const res = await f.h.fetch("/api/v1/inventory/dispositions/upload", {
      method: "POST",
      headers: { cookie: who.cookie, "content-type": "image/jpeg" },
      body: /** @type {any} */ (bytes),
    });
    return { status: res.status, body: /** @type {any} */ (await res.json()) };
  };
  it("stores a JPEG under the disposition-photo purpose and the request attaches it by digest; other files and viewers are refused", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode(`office-${crypto.randomUUID()}`)]);
    const up = await upload(manager, jpeg);
    expect(up.status).toBe(200);
    expect(up.body.sha256).toBe(new Bun.CryptoHasher("sha256").update(jpeg).digest("hex"));
    const [row] = await f.h.db`select purpose,status,mime from files where sha256=${up.body.sha256}`;
    expect(row).toMatchObject({ purpose: "disposition-photo", status: "stored", mime: "image/jpeg" });
    const p = await f.product({ perCase: 12 });
    await stockIn(p.id, 24, "damaged");
    const r = await command(manager, "dispositions/request", { locationId: depot, productId: p.id, fromStatus: "damaged", cases: 1, decision: "write_off", reasonCode: "DMG-HANDLING", photoDigests: [up.body.sha256] });
    expect(r.status).toBe(200);
    expect(r.body.photos).toBe(1);
    // a file that is not a photo, and a person who cannot ask for bad orders
    expect((await upload(manager, new TextEncoder().encode("not a photo"))).status).toBe(422);
    expect((await upload(viewer, jpeg)).status).toBe(403);
    // a photo uploaded for another purpose (e.g. a truck-damage file) is not accepted as a bad-order photo
    const bytes = new TextEncoder().encode(`other-${crypto.randomUUID()}`);
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    await f.h.db`insert into files (purpose,sha256,mime,size,path,status,created_by,stored_at) values ('truck-damage',${digest},'image/jpeg',${bytes.length},'x.jpg','stored',${manager.userId},now())`;
    const wrong = await command(manager, "dispositions/request", { locationId: depot, productId: p.id, fromStatus: "damaged", cases: 1, decision: "write_off", reasonCode: "DMG-HANDLING", photoDigests: [digest] });
    expect(wrong.status).toBe(422);
  });
});

describe("dispositions", () => {
  it("bad-order queue shows stock waiting with its value; request needs the reason's photo; a different person decides; the stock leaves in one posting", async () => {
    const p = await f.product({ perCase: 12 });
    await stockIn(p.id, 24, "damaged");
    const q0 = await read(viewer, "dispositions");
    const waiting = q0.body.waiting.find((/** @type {any} */ w) => w.productId === p.id);
    expect(waiting.status).toBe("damaged");
    expect(waiting.quantity.display).toBe("2 cs");
    expect(waiting.valueCentavos).toBe(24 * 1000);
    expect(waiting.releasable).toBe(true);
    // no photo -> plain refusal
    const noPhoto = await request({ productId: p.id, fromStatus: "damaged", cases: 1, decision: "write_off", reasonCode: "DMG-HANDLING" });
    expect(noPhoto.status).toBe(422);
    expect(noPhoto.body.error.message).toMatch(/Take a photo/);
    const photo = await photoFor(admin);
    const r = await request({ productId: p.id, fromStatus: "damaged", cases: 1, decision: "write_off", reasonCode: "DMG-HANDLING", photoDigests: [photo] });
    expect(r.status).toBe(200);
    expect(r.body.number).toMatch(/^DSP-/);
    expect(r.body.valueCentavos).toBe(12 * 1000);
    expect(r.body.approvalLevel).toBe("supervisor");
    expect(r.body.photos).toBe(1);
    // queue now shows the request with value and photo, and the waiting row shrinks to the rest
    const q1 = await read(manager, "dispositions");
    const req = q1.body.requests.find((/** @type {any} */ x) => x.id === r.body.id);
    expect(req.valueCentavos).toBe(12000);
    expect(req.photos).toBe(1);
    expect(req.canDecide).toBe(true);
    expect(q1.body.waiting.find((/** @type {any} */ w) => w.productId === p.id).quantity.base).toBe(12);
    const img = await read(manager, req.photoUrls[0].replace("/api/v1/inventory/", ""));
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/jpeg");
    // the person who asked cannot decide
    const self = await command(admin, "dispositions/decide", { dispositionId: r.body.id, verdict: "approve" });
    expect(self.status).toBe(403);
    expect(await balance(p.id, "damaged")).toBe(24);
    const ok = await command(manager, "dispositions/decide", { dispositionId: r.body.id, verdict: "approve", note: "Seen it" });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("posted");
    expect(await balance(p.id, "damaged")).toBe(12);
    const [m] = await f.h.db`select movement_type,source_type,source_document_id from inventory_movements where id=${ok.body.movementId}`;
    expect(m).toEqual({ movement_type: "inventory_adjustment", source_type: "disposition", source_document_id: r.body.id });
    const [d] = await f.h.db`select status,decided_by,movement_id from inventory_dispositions where id=${r.body.id}`;
    expect(d.status).toBe("posted");
    expect(d.decided_by).toBe(manager.userId);
    // deciding twice is refused
    expect((await command(manager, "dispositions/decide", { dispositionId: r.body.id, verdict: "approve" })).status).toBe(409);
    // the stock card shows the disposition by its number
    const card = await read(admin, `stock-card?productId=${p.id}&locationId=${depot}`);
    expect(card.body.rows.some((/** @type {any} */ row) => row.documentNumber === r.body.number)).toBe(true);
  });

  it("approval follows the value: above the limit only an approver may decide, and a reason can carry its own limit", async () => {
    const p = await f.product();
    await stockIn(p.id, 500, "damaged"); // 500 pc x P10 = P5,000
    const big = await request({ productId: p.id, fromStatus: "damaged", quantityBase: 200, decision: "write_off", reasonCode: "EXP" });
    expect(big.body.valueCentavos).toBe(200000);
    expect(big.body.approvalLevel).toBe("manager");
    const asManager = await command(manager, "dispositions/decide", { dispositionId: big.body.id, verdict: "approve" });
    expect(asManager.status).toBe(403);
    const asApprover = await command(approver, "dispositions/decide", { dispositionId: big.body.id, verdict: "approve" });
    expect(asApprover.status).toBe(200);
    expect(await balance(p.id, "damaged")).toBe(300);
    // raise the EXP limit to P3,000 and the same size of request is a supervisor job
    await f.h.db`update inventory_reason_codes set approval_threshold_centavos=300000 where code='EXP'`;
    const mid = await request({ productId: p.id, fromStatus: "damaged", quantityBase: 250, decision: "write_off", reasonCode: "EXP" });
    expect(mid.body.valueCentavos).toBe(250000);
    expect(mid.body.approvalLevel).toBe("supervisor");
    await f.h.db`update inventory_reason_codes set approval_threshold_centavos=null where code='EXP'`;
  });

  it("destroy needs a photo as proof before it can be approved; a decline needs a reason", async () => {
    const p = await f.product();
    await stockIn(p.id, 10, "expired");
    const r = await request({ productId: p.id, fromStatus: "expired", quantityBase: 10, decision: "destroy", reasonCode: "EXP" });
    expect(r.status).toBe(200);
    expect(r.body.photos).toBe(0);
    const early = await command(manager, "dispositions/decide", { dispositionId: r.body.id, verdict: "approve" });
    expect(early.status).toBe(422);
    expect(early.body.error.message).toBe("Destroying stock needs a photo as proof.");
    const q = await read(manager, "dispositions");
    expect(q.body.requests.find((/** @type {any} */ x) => x.id === r.body.id).needsPhoto).toBe(true);
    const added = await command(admin, "dispositions/photo", { dispositionId: r.body.id, photoDigests: [await photoFor(admin)] });
    expect(added.body.photos).toBe(1);
    const decline = await command(manager, "dispositions/decide", { dispositionId: r.body.id, verdict: "reject" });
    expect(decline.status).toBe(422);
    const rejected = await command(manager, "dispositions/decide", { dispositionId: r.body.id, verdict: "reject", note: "Count it again first" });
    expect(rejected.body.status).toBe("rejected");
    expect(await balance(p.id, "expired")).toBe(10);
    // a photo that was never uploaded is refused in plain words
    const bad = await request({ productId: p.id, fromStatus: "expired", quantityBase: 1, decision: "destroy", reasonCode: "EXP", photoDigests: ["a".repeat(64)] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toMatch(/not uploaded yet/);
  });

  it("return to supplier needs the slip number and issues the stock; the same pieces cannot be requested twice", async () => {
    const p = await f.product();
    await stockIn(p.id, 30, "damaged");
    const noSlip = await request({ productId: p.id, fromStatus: "damaged", quantityBase: 10, decision: "return_to_supplier", reasonCode: "DMG-TRANSIT", photoDigests: [await photoFor(admin)] });
    expect(noSlip.status).toBe(422);
    const a = await request({ productId: p.id, fromStatus: "damaged", quantityBase: 20, decision: "return_to_supplier", reasonCode: "DMG-TRANSIT", supplierRef: "RTS-0042", photoDigests: [await photoFor(admin)] });
    expect(a.status).toBe(200);
    const over = await request({ productId: p.id, fromStatus: "damaged", quantityBase: 11, decision: "write_off", reasonCode: "DMG-HANDLING", photoDigests: [await photoFor(admin)] });
    expect(over.status).toBe(422);
    expect(over.body.error.message).toMatch(/Only 10 pc left/);
    const done = await command(manager, "dispositions/decide", { dispositionId: a.body.id, verdict: "approve" });
    const [m] = await f.h.db`select movement_type from inventory_movements where id=${done.body.movementId}`;
    expect(m.movement_type).toBe("inventory_issue");
    expect(await balance(p.id, "damaged")).toBe(10);
  });

  it("release puts held or damaged stock back on sale, but never expired stock or a recalled batch", async () => {
    const p = await f.product();
    await stockIn(p.id, 20, "quality_hold");
    await stockIn(p.id, 5, "expired");
    const expiredRelease = await request({ productId: p.id, fromStatus: "expired", quantityBase: 5, decision: "release", note: "looks fine" });
    expect(expiredRelease.status).toBe(422);
    expect(expiredRelease.body.error.message).toBe("Expired stock can't go back on sale.");
    const noNote = await request({ productId: p.id, fromStatus: "quality_hold", quantityBase: 20, decision: "release" });
    expect(noNote.status).toBe(422);
    const r = await request({ productId: p.id, fromStatus: "quality_hold", quantityBase: 20, decision: "release", note: "Temperature log is fine" });
    expect(r.status).toBe(200);
    expect((await command(manager, "dispositions/decide", { dispositionId: r.body.id, verdict: "approve" })).status).toBe(200);
    expect(await balance(p.id, "available")).toBe(20);
    expect(await balance(p.id, "quality_hold")).toBe(0);
    // a recalled batch cannot be released to sale
    const t = await f.product({ tracked: true });
    const lot = await f.lot(t.id, "RECALLED", 90);
    await stockIn(t.id, 12, "quality_hold", { lotId: lot });
    await f.h.db`insert into inventory_lot_holds (lot_id,source_type,source_id,actor_subject) values (${lot},'retail_recall',${crypto.randomUUID()},'test')`;
    const rec = await request({ productId: t.id, lotId: lot, fromStatus: "quality_hold", quantityBase: 12, decision: "release", note: "ok" });
    const refused = await command(manager, "dispositions/decide", { dispositionId: rec.body.id, verdict: "approve" });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe("recall_hold");
    // an expired batch cannot be released either
    const old = await f.product({ tracked: true });
    const oldLot = await f.lot(old.id, "OLD", -3);
    await stockIn(old.id, 4, "damaged", { lotId: oldLot });
    const oldReq = await request({ productId: old.id, lotId: oldLot, fromStatus: "damaged", quantityBase: 4, decision: "release", note: "dented only" });
    const oldNo = await command(manager, "dispositions/decide", { dispositionId: oldReq.body.id, verdict: "approve" });
    expect(oldNo.status).toBe(422);
    expect(oldNo.body.error.message).toMatch(/past its expiry date/);
  });

  it("products with batches must name the batch; products without batches work too", async () => {
    const t = await f.product({ tracked: true });
    const lot = await f.lot(t.id, "B-1", 40);
    await stockIn(t.id, 6, "damaged", { lotId: lot });
    const noLot = await request({ productId: t.id, fromStatus: "damaged", quantityBase: 6, decision: "write_off", reasonCode: "DMG-HANDLING", photoDigests: [await photoFor(admin)] });
    expect(noLot.status).toBe(422);
    expect(noLot.body.error.message).toBe("Choose the batch for this product.");
    const q = await read(admin, "dispositions");
    expect(q.body.waiting.find((/** @type {any} */ w) => w.lotId === lot).lotNumber).toBe("B-1");
    const ok = await request({ productId: t.id, lotId: lot, fromStatus: "damaged", quantityBase: 6, decision: "write_off", reasonCode: "DMG-HANDLING", photoDigests: [await photoFor(admin)] });
    expect((await command(manager, "dispositions/decide", { dispositionId: ok.body.id, verdict: "approve" })).status).toBe(200);
    const [lb] = await f.h.db`select physical_base from inventory_lot_balances where lot_id=${lot} and stock_status='damaged'`;
    expect(Number(lb.physical_base)).toBe(0);
    const plain = await f.product();
    const withLot = await request({ productId: plain.id, lotId: lot, fromStatus: "damaged", quantityBase: 1, decision: "write_off", reasonCode: "DMG-HANDLING" });
    expect(withLot.status).toBe(422);
  });

  it("a viewer can read the queue but not ask or decide", async () => {
    expect((await read(viewer, "dispositions")).status).toBe(200);
    const p = await f.product();
    await stockIn(p.id, 3, "damaged");
    expect((await request({ productId: p.id, fromStatus: "damaged", quantityBase: 1, decision: "write_off", reasonCode: "DMG-HANDLING" }, viewer)).status).toBe(403);
  });
});

describe("expiry board", () => {
  it("lists batches by days to expiry and offers hold, bad order and prioritise", async () => {
    const p = await f.product({ tracked: true });
    const mk = async (/** @type {string} */ n, /** @type {number} */ days) => {
      const lot = await f.lot(p.id, n, days);
      await stockIn(p.id, 24, "available", { lotId: lot });
      return lot;
    };
    const l10 = await mk("D10", 10),
      l45 = await mk("D45", 45),
      l80 = await mk("D80", 80);
    await mk("D200", 200);
    const board = await read(viewer, `expiry-board?days=90&productId=${p.id}`);
    expect(board.status).toBe(200);
    const byKey = Object.fromEntries(board.body.buckets.map((/** @type {any} */ b) => [b.key, b]));
    expect(byKey["30"].rows.map((/** @type {any} */ r) => r.lotNumber)).toEqual(["D10"]);
    expect(byKey["60"].rows.map((/** @type {any} */ r) => r.lotNumber)).toEqual(["D45"]);
    expect(byKey["90"].rows.map((/** @type {any} */ r) => r.lotNumber)).toEqual(["D80"]);
    expect(byKey["30"].rows[0].valueCentavos).toBe(24000);
    expect(byKey["30"].rows[0].daysLeft).toBe(10);
    expect(byKey["30"].valueCentavos).toBe(24000);
    // hold -> available becomes On hold
    const hold = await command(admin, "expiry/act", { action: "hold", lotId: l10, locationId: depot, note: "check temp" });
    expect(hold.status).toBe(200);
    expect(await balance(p.id, "quality_hold")).toBe(24);
    // bad order of part of a batch
    const bad = await command(admin, "expiry/act", { action: "bad_order", lotId: l45, locationId: depot, quantityBase: 10, note: "will not sell in time" });
    expect(bad.status).toBe(200);
    expect(await balance(p.id, "expired")).toBe(10);
    expect((await command(admin, "expiry/act", { action: "bad_order", lotId: l45, locationId: depot, quantityBase: 500 })).status).toBe(422);
    // prioritise flags the batch for the next load; clear it again
    expect((await command(manager, "expiry/act", { action: "prioritise", lotId: l80, locationId: depot })).status).toBe(200);
    let b2 = await read(viewer, `expiry-board?days=90&productId=${p.id}`);
    expect(b2.body.buckets.find((/** @type {any} */ b) => b.key === "90").rows[0].prioritised).toBe(true);
    await command(manager, "expiry/act", { action: "unprioritise", lotId: l80, locationId: depot });
    b2 = await read(viewer, `expiry-board?days=90&productId=${p.id}`);
    expect(b2.body.buckets.find((/** @type {any} */ b) => b.key === "90").rows[0].prioritised).toBe(false);
    // the held batch is still listed, as On hold, and can now be released through a disposition
    const held = b2.body.buckets.find((/** @type {any} */ b) => b.key === "30").rows.find((/** @type {any} */ r) => r.lotId === l10);
    expect(held.status).toBe("quality_hold");
    // a manager may not hold stock (needs inventory.write)
    expect((await command(manager, "expiry/act", { action: "hold", lotId: l80, locationId: depot })).status).toBe(403);
  });

  it("shows batches that have already expired in their own group", async () => {
    const p = await f.product({ tracked: true });
    const lot = await f.lot(p.id, "GONE", -2);
    await stockIn(p.id, 5, "available", { lotId: lot });
    const board = await read(viewer, `expiry-board?productId=${p.id}`);
    const gone = board.body.buckets.find((/** @type {any} */ b) => b.key === "expired");
    expect(gone.rows.some((/** @type {any} */ r) => r.lotNumber === "GONE" && r.daysLeft <= 0)).toBe(true);
  });
});
