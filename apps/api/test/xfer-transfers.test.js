import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { tx } from "@sunpride/db/client";
import { startHarness, profileStore } from "./harness.js";
import { sha256Hex } from "../src/core/util.js";
import { capabilitiesFor } from "../src/core/capabilities.js";

// IP-XFER: one movement document (SPEC 5.1/5.6) and the multi-line goods receipt (SPEC 4.2/4.9).
// Real inventory, constraints and HTTP handlers; only audit, pricing and analytics boundaries are mocked.
mock.module("../src/domains/org/audit.js", () => ({
  writeAudit: async (/** @type {any} */ t, /** @type {any} */ e) => {
    await t`insert into audit_logs (subject,action,entity_type,entity_id,details) values (${e.subject},${e.action},${e.entityType},${e.entityId},${e.details ?? null})`;
  },
}));
mock.module("../src/domains/orders/pricing.js", () => ({
  resolvePrice: async () => ({
    unitPriceCentavos: 1250,
    priceListId: null,
    source: "test default price",
  }),
  creditCheck: async () => ({ status: "unknown", limit: null, exposure: null }),
}));
mock.module("../src/domains/analytics/refresh.js", () => ({
  enqueueRefresh: async () => {},
}));
const { install } = await import("../src/domains/inventory/index.js");
const { recordLoadInDocument } =
  await import("../src/domains/inventory/transfers.js");
/** @type {import('./harness.js').Harness} */ let h;
/** @type {ReturnType<typeof profileStore>} */ let profiles;
/** @type {any} */ let admin; // receives
/** @type {any} */ let clerk; // dispatches (operations)
/** @type {any} */ let approver; // approves and resolves
/** @type {string} */ let unit;
/** @type {string} */ let pc;
/** @type {string} */ let cs;
/** @type {string} */ let depot;
/** @type {string} */ let store;
/** @type {string} */ let truck;
/** @type {string} */ let transit;
const CASE = 48;
const COST = 2000; // centavos per piece: one case = P960, over the P500 default tolerance

/** @param {string} role */
async function person(role) {
  const [u] =
    await h.db`insert into users (email,password_hash) values (${`${crypto.randomUUID()}@test.invalid`},'fixture-not-a-login') returning id`;
  const profile = profiles.set(u.id, { role, orgUnitId: unit });
  const token = `sps_${crypto.randomUUID().replaceAll("-", "")}`;
  await h.db`insert into sessions (user_id,token_hash,app,expires_at) values (${u.id},${sha256Hex(token)},'web',now()+interval '1 day')`;
  return {
    userId: u.id,
    profileId: profile.id,
    role,
    orgUnitId: unit,
    capabilities: new Set(capabilitiesFor(role)),
    cookie: `sp_session=${token}`,
  };
}
/** @param {string} name @param {string} type */
async function location(name, type) {
  const [r] =
    await h.db`insert into inventory_locations (organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values ('sunpride',${unit},'TEST',${name},${name},${type},true,true,true,true,false) returning id`;
  return r.id;
}
/** @param {{tracked?:boolean, quality?:boolean}} [opts] */
async function product(opts = {}) {
  const [p] =
    await h.db`insert into products (code,name,category,uom,unit_price,active,organization_id,base_uom_id,quantity_scale,tracking_mode,allocation_policy) values (${`P-${crypto.randomUUID()}`},'Test longganisa','Frozen','PC',0,true,'sunpride',${pc},1,${opts.tracked ? "lot" : "none"},'fefo') returning *`;
  await h.db`insert into uom_conversions (organization_id,product_id,from_uom_id,to_uom_id,numerator,denominator,rounding_mode,effective_from,active) values ('sunpride',${p.id},${cs},${pc},${CASE},1,'exact',now()-interval '1 year',true)`;
  if (opts.tracked || opts.quality)
    await h.db`insert into product_inventory_policies (organization_id,product_id,base_uom_id,quantity_scale,quantity_precision,tracking_mode,allocation_policy,allow_mixed_lots_per_line,allow_negative_stock,quality_release_required,expiry_date_required,manufacture_date_required,minimum_remaining_shelf_life_days,costing_method,version,active) values ('sunpride',${p.id},${pc},1,0,${opts.tracked ? "lot" : "none"},'fefo',true,false,${opts.quality === true},${opts.tracked === true},false,0,'weighted_average',1,true)`;
  return p;
}
/** @param {any} who @param {string} action @param {any} body */
async function command(who, action, body) {
  const res = await h.fetch(`/api/v1/inventory/${action}`, {
    method: "POST",
    headers: { cookie: who.cookie, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), ...body }),
  });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}
/** @param {any} who @param {string} path */
async function read(who, path) {
  const res = await h.fetch(`/api/v1/inventory/${path}`, {
    headers: { cookie: who.cookie },
  });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}
/** @param {string} productId @param {string} locationId */
async function stock(productId, locationId) {
  const [b] =
    await h.db`select available_stock_base,damaged_base,quality_hold_base,in_transit_base,reserved_base,physical_base from inventory_balances where product_id=${productId} and location_id=${locationId}`;
  return {
    available: Number(b?.available_stock_base ?? 0),
    damaged: Number(b?.damaged_base ?? 0),
    hold: Number(b?.quality_hold_base ?? 0),
    transit: Number(b?.in_transit_base ?? 0),
    reserved: Number(b?.reserved_base ?? 0),
  };
}
/** @param {any} p @param {number} qty @param {any} [extra] */
const receipt = (p, qty, extra = {}) =>
  command(admin, "receipts/post", {
    receivingLocationId: depot,
    lines: [
      { productId: p.id, quantityBase: qty, unitCostMinor: COST, ...extra },
    ],
  });
/** Depot → store document, approved. @param {any} p @param {number} qty @param {any} [extra] */
async function approved(p, qty, extra = {}) {
  const made = await command(clerk, "transfers/request", {
    type: "depot_transfer",
    sourceLocationId: depot,
    destinationLocationId: store,
    inTransitLocationId: transit,
    lines: [{ productId: p.id, quantityBase: qty }],
    ...extra,
  });
  expect(made.status).toBe(200);
  const ok = await command(approver, "transfers/approve", {
    transferId: made.body.id,
  });
  expect(ok.status).toBe(200);
  return made.body.id;
}
/** @param {string} id */
const detail = async (id) =>
  (await read(admin, `transfers/detail?id=${id}`)).body;
/** Request, approve, dispatch. @param {any} p @param {number} qty */
async function dispatched(p, qty) {
  const id = await approved(p, qty);
  const sent = await command(clerk, "transfers/dispatch", {
    transferId: id,
    driverName: "Juan Dela Cruz",
    vehiclePlate: "ABC 1234",
    receiverName: "Maria Santos",
  });
  expect(sent.status).toBe(200);
  return id;
}

beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  profiles = profileStore(h);
  const [u] =
    await h.db`insert into org_units (organization_id,code,name,type_code,status,effective_from) values ('sunpride','XF-ROOT','Transfer test','national','active',now()) returning id`;
  unit = u.id;
  h.setHooks({ rootUnitId: async () => unit });
  [admin, clerk, approver] = await Promise.all([
    person("admin"),
    person("operations"),
    person("approver"),
  ]);
  const [piece] =
    await h.db`insert into units_of_measure (organization_id,code,name,dimension,decimal_places,active) values ('sunpride','PC','Piece','count',0,true) returning id`;
  pc = piece.id;
  const [caseUom] =
    await h.db`insert into units_of_measure (organization_id,code,name,dimension,decimal_places,active) values ('sunpride','CS','Case','count',0,true) returning id`;
  cs = caseUom.id;
  depot = await location("Cebu main depot", "warehouse");
  store = await location("Mandaue store", "warehouse");
  truck = await location("Van ABC-1234", "truck");
  transit = await location("Cebu in transit", "in_transit");
}, 30000);
afterAll(async () => {
  await h?.close();
});

describe("request, approve (reserves), pick, dispatch", () => {
  it("numbers the document, reserves on approve, refuses to promise the same stock twice, and cancel gives it back", async () => {
    const p = await product();
    expect((await receipt(p, 480)).status).toBe(200);
    const first = await approved(p, 480);
    const d = await detail(first);
    expect(d.number).toMatch(/^TRF-[A-Z0-9-]+-\d{6}-\d{4}$/);
    expect(d.status).toBe("approved");
    expect((await stock(p.id, depot)).reserved).toBe(480);
    const second = await command(clerk, "transfers/request", {
      sourceLocationId: depot,
      destinationLocationId: store,
      inTransitLocationId: transit,
      lines: [{ productId: p.id, quantityBase: 48 }],
    });
    const refused = await command(approver, "transfers/approve", {
      transferId: second.body.id,
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error.message ?? refused.body.message).toMatch(
      /Insufficient available stock/,
    );
    expect(
      (await command(approver, "transfers/cancel", { transferId: first }))
        .status,
    ).toBe(200);
    expect((await stock(p.id, depot)).reserved).toBe(0);
    expect((await detail(first)).status).toBe("cancelled");
  });
  it("maker is not checker; pick sets what ships; dispatch carries driver, plate and receiver and moves stock to In transit", async () => {
    const p = await product();
    await receipt(p, 480);
    const made = await command(clerk, "transfers/request", {
      sourceLocationId: depot,
      destinationLocationId: store,
      inTransitLocationId: transit,
      lines: [{ productId: p.id, quantityBase: 480 }],
    });
    expect(
      (await command(clerk, "transfers/approve", { transferId: made.body.id }))
        .status,
    ).toBe(403);
    expect(
      (
        await command(approver, "transfers/approve", {
          transferId: made.body.id,
        })
      ).status,
    ).toBe(200);
    const doc = await detail(made.body.id);
    const picked = await command(clerk, "transfers/pick", {
      transferId: made.body.id,
      lines: [{ lineId: doc.lines[0].id, pickedBase: 432 }],
    });
    expect(picked.body.status).toBe("picking");
    const sent = await command(clerk, "transfers/dispatch", {
      transferId: made.body.id,
      driverName: "Juan Dela Cruz",
      vehiclePlate: "ABC 1234",
      receiverName: "Maria Santos",
    });
    expect(sent.status).toBe(200);
    const after = await detail(made.body.id);
    expect(after.status).toBe("dispatched");
    expect(after.header).toMatchObject({
      driverName: "Juan Dela Cruz",
      vehiclePlate: "ABC 1234",
      receiverName: "Maria Santos",
    });
    expect(after.lines[0]).toMatchObject({
      approvedBase: 480,
      pickedBase: 432,
      dispatchedBase: 432,
    });
    expect(await stock(p.id, depot)).toMatchObject({
      available: 48,
      reserved: 0,
    });
    expect((await stock(p.id, transit)).transit).toBe(432);
  });
});

describe("receive: good / damaged / on hold, partial, short, over", () => {
  it("receives in two partial receipts; the sending numbers never change", async () => {
    const p = await product();
    await receipt(p, 480);
    const id = await dispatched(p, 480);
    const doc = await detail(id);
    const line = doc.lines[0].id;
    const one = await command(admin, "transfers/receive", {
      transferId: id,
      lines: [{ lineId: line, receivedGoodBase: 200 }],
    });
    expect(one.status).toBe(200);
    expect(one.body.status).toBe("partially_received");
    expect((await stock(p.id, store)).available).toBe(200);
    expect((await stock(p.id, transit)).transit).toBe(280);
    const two = await command(admin, "transfers/receive", {
      transferId: id,
      lines: [{ lineId: line, receivedGoodBase: 280 }],
    });
    expect(two.body.status).toBe("received");
    expect(two.body.varianceStatus).toBe("none");
    const done = await detail(id);
    expect(done.lines[0]).toMatchObject({
      dispatchedBase: 480,
      receivedGoodBase: 480,
      shortBase: 0,
    });
    expect((await stock(p.id, store)).available).toBe(480);
    expect((await stock(p.id, transit)).transit).toBe(0);
    // Closed documents take no more stock.
    expect(
      (
        await command(admin, "transfers/receive", {
          transferId: id,
          lines: [{ lineId: line, receivedGoodBase: 1 }],
        })
      ).status,
    ).toBe(409);
    expect(
      (await command(admin, "transfers/close", { transferId: id })).body.status,
    ).toBe("closed");
  });
  it("SPEC 5.6: 10 cases received as 9 good + 1 damaged shows a variance until resolved, then closes", async () => {
    const p = await product();
    await receipt(p, 480);
    const id = await dispatched(p, 480);
    const line = (await detail(id)).lines[0].id;
    const noReason = await command(admin, "transfers/receive", {
      transferId: id,
      lines: [{ lineId: line, receivedGoodBase: 432, receivedDamagedBase: 48 }],
    });
    expect(noReason.status).toBe(422);
    const noPhoto = await command(admin, "transfers/receive", {
      transferId: id,
      lines: [
        {
          lineId: line,
          receivedGoodBase: 432,
          receivedDamagedBase: 48,
          reasonCode: "DMG-TRANSIT",
        },
      ],
    });
    expect(noPhoto.status).toBe(422);
    const r = await command(admin, "transfers/receive", {
      transferId: id,
      lines: [
        {
          lineId: line,
          receivedGoodBase: 432,
          receivedDamagedBase: 48,
          reasonCode: "DMG-TRANSIT",
          photoCount: 1,
        },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("review_needed");
    expect(r.body.varianceStatus).toBe("open");
    expect(await stock(p.id, store)).toMatchObject({
      available: 432,
      damaged: 48,
    });
    expect((await stock(p.id, transit)).transit).toBe(0);
    const open = await detail(id);
    expect(open.status).toBe("review_needed");
    expect(open.varianceValueCentavos).toBe(48 * COST);
    // The receiver cannot sign off their own numbers; the sender cannot either.
    expect(
      (
        await command(admin, "transfers/resolve-variance", {
          transferId: id,
          chargeTo: "carrier",
          note: "ok",
        })
      ).status,
    ).toBe(403);
    const resolved = await command(approver, "transfers/resolve-variance", {
      transferId: id,
      chargeTo: "carrier",
      note: "Damaged on the truck, carrier charged",
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe("closed");
    expect((await detail(id)).varianceStatus).toBe("resolved");
    // Damaged stock is already in Damaged at the store: nothing else moved.
    expect(await stock(p.id, store)).toMatchObject({
      available: 432,
      damaged: 48,
    });
  });
  it("short stays in transit as a variance; a person with authority writes it off through a linked adjustment", async () => {
    const p = await product();
    await receipt(p, 480);
    const id = await dispatched(p, 480);
    const line = (await detail(id)).lines[0].id;
    const r = await command(admin, "transfers/receive", {
      transferId: id,
      final: true,
      lines: [{ lineId: line, receivedGoodBase: 384 }],
    });
    expect(r.body.status).toBe("review_needed");
    expect(await stock(p.id, store)).toMatchObject({ available: 384 });
    expect((await stock(p.id, transit)).transit).toBe(96); // still ours, still In transit
    const d = await detail(id);
    expect(d.lines[0]).toMatchObject({ shortBase: 96, dispatchedBase: 480 });
    const noReason = await command(approver, "transfers/resolve-variance", {
      transferId: id,
      chargeTo: "driver",
    });
    expect(noReason.status).toBe(422);
    const noCharge = await command(approver, "transfers/resolve-variance", {
      transferId: id,
      reasonCode: "SHORT-TRANSIT",
    });
    expect(noCharge.status).toBe(422);
    const ok = await command(approver, "transfers/resolve-variance", {
      transferId: id,
      reasonCode: "SHORT-TRANSIT",
      chargeTo: "driver",
      note: "Two cases not on the truck",
    });
    expect(ok.status).toBe(200);
    expect(ok.body.shortBase).toBe(96);
    expect((await stock(p.id, transit)).transit).toBe(0);
    const [adj] =
      await h.db`select * from inventory_adjustments where source_transfer_id=${id}`;
    expect(adj).toMatchObject({
      adjustment_type: "transfer_variance",
      status: "posted",
      reason_code: "SHORT-TRANSIT",
    });
    expect(adj.adjustment_number).toMatch(/^ADJ-/);
    const [res] =
      await h.db`select charge_to,short_base from stock_transfer_resolutions where transfer_id=${id}`;
    expect(res).toMatchObject({ charge_to: "driver" });
    expect(Number(res.short_base)).toBe(96);
    expect((await detail(id)).status).toBe("closed");
  });
  it("late stock fixes a short: receiving again before it is resolved shrinks the variance", async () => {
    const p = await product();
    await receipt(p, 480);
    const id = await dispatched(p, 480);
    const line = (await detail(id)).lines[0].id;
    await command(admin, "transfers/receive", {
      transferId: id,
      final: true,
      lines: [{ lineId: line, receivedGoodBase: 384 }],
    });
    const late = await command(admin, "transfers/receive", {
      transferId: id,
      lines: [{ lineId: line, receivedGoodBase: 96 }],
    });
    expect(late.status).toBe(200);
    expect(late.body.status).toBe("received");
    expect((await stock(p.id, store)).available).toBe(480);
  });
  it("over is counted but not in the ledger until resolved; then it is added to the destination", async () => {
    const p = await product();
    await receipt(p, 480);
    const id = await dispatched(p, 480);
    const line = (await detail(id)).lines[0].id;
    const r = await command(admin, "transfers/receive", {
      transferId: id,
      lines: [{ lineId: line, receivedGoodBase: 576 }],
    });
    expect(r.body.status).toBe("review_needed");
    expect((await stock(p.id, store)).available).toBe(480);
    expect((await detail(id)).lines[0].overBase).toBe(96);
    expect(
      (
        await command(approver, "transfers/resolve-variance", {
          transferId: id,
          reasonCode: "SHORT-TRANSIT", // out-only code on an "in" difference
          chargeTo: "dispatch_side",
        })
      ).status,
    ).toBe(422);
    const ok = await command(approver, "transfers/resolve-variance", {
      transferId: id,
      reasonCode: "COUNT-ERR",
      chargeTo: "dispatch_side",
      note: "Depot under-counted the pick",
    });
    expect(ok.status).toBe(200);
    expect(ok.body.overBase).toBe(96);
    expect((await stock(p.id, store)).available).toBe(576);
  });
  it("a difference inside the allowed tolerance closes by itself and still clears In transit", async () => {
    const p = await product();
    await receipt(p, 480, { unitCostMinor: 100 }); // P1 a piece: 3 pieces = P3
    const id = await dispatched(p, 480);
    const line = (await detail(id)).lines[0].id;
    const r = await command(admin, "transfers/receive", {
      transferId: id,
      final: true,
      lines: [{ lineId: line, receivedGoodBase: 477 }],
    });
    expect(r.body.status).toBe("closed");
    expect(r.body.varianceStatus).toBe("auto_accepted");
    expect((await stock(p.id, transit)).transit).toBe(0);
    const [res] =
      await h.db`select auto,charge_to from stock_transfer_resolutions where transfer_id=${id}`;
    expect(res).toMatchObject({ auto: true, charge_to: "tolerance" });
  });
  it("a batch recalled while in transit is received into On hold, never refused", async () => {
    const p = await product({ tracked: true });
    await receipt(p, 96, {
      lotNumber: "LOT-RECALL",
      expiresAt: Date.now() + 60 * 86400000,
    });
    const id = await dispatched(p, 96);
    const [lot] =
      await h.db`select id from inventory_lots where product_id=${p.id} and lot_number='LOT-RECALL'`;
    await h.db`insert into inventory_lot_holds(lot_id,source_type,source_id,actor_subject) values(${lot.id},'retail_recall',${crypto.randomUUID()},'test')`;
    const doc = await detail(id);
    expect(doc.lines[0].allocations[0]).toMatchObject({
      batch: "LOT-RECALL",
      dispatchedBase: 96,
    });
    const r = await command(admin, "transfers/receive", {
      transferId: id,
      lines: [
        { lineId: doc.lines[0].id, batchId: lot.id, receivedGoodBase: 96 },
      ],
    });
    expect(r.status).toBe(200);
    expect(await stock(p.id, store)).toMatchObject({ available: 0, hold: 96 });
    const after = await detail(id);
    expect(after.lines[0]).toMatchObject({
      receivedHoldBase: 96,
      receivedGoodBase: 0,
    });
  });
  it("a recall that lands while stock is reserved does not block dispatch; the free batches ship", async () => {
    const p = await product({ tracked: true });
    const soon = Date.now() + 30 * 86400000,
      later = Date.now() + 90 * 86400000;
    await receipt(p, 96, { lotNumber: "LOT-SOON", expiresAt: soon });
    await receipt(p, 96, { lotNumber: "LOT-LATER", expiresAt: later });
    const id = await approved(p, 96); // reserves the earliest expiry
    const [soonLot] =
      await h.db`select id from inventory_lots where product_id=${p.id} and lot_number='LOT-SOON'`;
    const { holdRecallLots } =
      await import("../src/domains/inventory/holds.js");
    await tx(h.db, (t) =>
      holdRecallLots(
        {
          db: t,
          actor: {
            subject: admin.userId,
            profileId: admin.profileId,
            userId: admin.userId,
          },
          now: Date.now(),
        },
        crypto.randomUUID(),
        [soonLot.id],
      ),
    );
    const sent = await command(clerk, "transfers/dispatch", { transferId: id });
    expect(sent.status).toBe(200);
    const doc = await detail(id);
    expect(doc.lines[0].dispatchedBase).toBe(96);
    const batches = doc.lines[0].allocations
      .filter((/** @type {any} */ a) => a.dispatchedBase > 0)
      .map((/** @type {any} */ a) => a.batch);
    expect(batches).toEqual(["LOT-LATER"]);
  });
  it("lists and reads documents inside scope; the receive queue shows inbound transfers", async () => {
    const p = await product();
    await receipt(p, 96);
    const id = await dispatched(p, 96);
    const list = await read(admin, "transfers/list?status=in_transit");
    expect(list.status).toBe(200);
    expect(
      list.body.transfers.some((/** @type {any} */ t) => t.id === id),
    ).toBe(true);
    const queue = await read(admin, "receive/queue");
    expect(queue.status).toBe(200);
    expect(
      queue.body.inboundTransfers.some((/** @type {any} */ t) => t.id === id),
    ).toBe(true);
    expect(queue.body.expectedDeliveries).toEqual([]);
    expect(
      (await read(admin, `transfers/detail?id=${crypto.randomUUID()}`)).status,
    ).toBe(404);
  });
});

describe("van load-in document", () => {
  it("allows over and records it as a variance; a difference above the allowed amount needs a supervisor", async () => {
    const p = await product();
    await receipt(p, 480);
    const pTruck = await command(admin, "receipts/post", {
      receivingLocationId: truck,
      lines: [{ productId: p.id, quantityBase: 96, unitCostMinor: COST }],
    });
    expect(pTruck.status).toBe(200);
    const trip = {
      id: crypto.randomUUID(),
      truck_location_id: truck,
      source_location_id: depot,
      vehicle_id: crypto.randomUUID(),
      driver_name: "Juan",
    };
    const doc = await tx(h.db, (t) =>
      recordLoadInDocument(
        { db: t, actor: admin, now: Date.now(), trusted: true },
        {
          trip,
          sellerUserId: clerk.userId,
          source: "van_load_in:test",
          lines: [
            {
              productId: p.id,
              lotId: null,
              status: "available",
              expectedBase: 96,
              receivedBase: 144,
              toStatus: "available",
            },
          ],
        },
      ),
    );
    expect(doc.number).toMatch(/^LIN-/);
    expect(doc.status).toBe("review_needed");
    const d = await detail(doc.id);
    expect(d.type).toBe("van_load_in");
    expect(d.lines[0]).toMatchObject({ dispatchedBase: 96, overBase: 48 });
    const ok = await command(approver, "transfers/resolve-variance", {
      transferId: doc.id,
      reasonCode: "FOUND",
      chargeTo: "receive_side",
      note: "Clerk counted four more cases than the seller",
    });
    expect(ok.status).toBe(200);
    expect((await stock(p.id, depot)).available).toBe(480 + 48);
  });
});

describe("goods receipt: many lines, one post", () => {
  it("SPEC 4.9: a 40-line delivery posts as one receipt with supplier, delivery receipt no. and PO", async () => {
    const products = [];
    for (let i = 0; i < 40; i++) products.push(await product());
    const res = await command(admin, "receipts/post", {
      receivingLocationId: depot,
      receiptType: "purchase_order",
      supplierName: "Mekeni Foods",
      deliveryReference: "DR-77821",
      purchaseOrderRef: "PO-2026-114",
      lines: products.map((p, i) => ({
        productId: p.id,
        quantityBase: 48 * (i + 1),
        unitCostMinor: 1500,
        ...(i === 3
          ? {
              rejectedBase: 5,
              rejectedReasonCode: "DMG-HANDLING",
              photoCount: 1,
            }
          : {}),
      })),
    });
    expect(res.status).toBe(200);
    expect(res.body.number).toMatch(/^RCV-[A-Z0-9-]+-\d{6}-\d{4}$/);
    expect(res.body.lineCount).toBe(40);
    const [r] =
      await h.db`select count(*)::int as n from goods_receipts where id=${res.body.id}`;
    expect(r.n).toBe(1);
    const [l] =
      await h.db`select count(*)::int as n from goods_receipt_lines where receipt_id=${res.body.id}`;
    expect(l.n).toBe(40);
    const [m] =
      await h.db`select count(distinct movement_id)::int as n from inventory_ledger_entries where movement_id in (select movement_id from goods_receipts where id=${res.body.id})`;
    expect(m.n).toBe(1);
    const back = await read(admin, `receipts/list?id=${res.body.id}`);
    expect(back.body).toMatchObject({
      supplierName: "Mekeni Foods",
      deliveryReceiptNo: "DR-77821",
      purchaseOrderRef: "PO-2026-114",
      rejectedLines: 1,
    });
    expect(back.body.lines).toHaveLength(40);
    expect(await stock(products[3].id, depot)).toMatchObject({
      available: 48 * 4,
    });
    const [rej] =
      await h.db`select rejected_base from inventory_balances where product_id=${products[3].id} and location_id=${depot}`;
    expect(Number(rej.rejected_base)).toBe(5);
  });
  it("rejected quantity needs a reason from the list; products needing quality release land On hold", async () => {
    const p = await product();
    const q = await product({ quality: true });
    const bad = await command(admin, "receipts/post", {
      receivingLocationId: depot,
      supplierName: "Mekeni Foods",
      lines: [{ productId: p.id, quantityBase: 48, rejectedBase: 2 }],
    });
    expect(bad.status).toBe(422);
    const ok = await command(admin, "receipts/post", {
      receivingLocationId: depot,
      supplierName: "Mekeni Foods",
      deliveryReference: "DR-1",
      lines: [
        {
          productId: p.id,
          quantityBase: 48,
          rejectedBase: 2,
          rejectedReasonCode: "EXP",
        },
        { productId: q.id, quantityBase: 96 },
      ],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.heldLines).toBe(1);
    expect(await stock(q.id, depot)).toMatchObject({ available: 0, hold: 96 });
  });
  it("a delivery of a recalled batch lands On hold instead of being refused", async () => {
    const p = await product({ tracked: true });
    const expiresAt = Date.now() + 60 * 86400000;
    await receipt(p, 48, { lotNumber: "LOT-R2", expiresAt });
    const [lot] =
      await h.db`select id from inventory_lots where product_id=${p.id} and lot_number='LOT-R2'`;
    await h.db`insert into inventory_lot_holds(lot_id,source_type,source_id,actor_subject) values(${lot.id},'retail_recall',${crypto.randomUUID()},'test')`;
    const again = await receipt(p, 48, { lotNumber: "LOT-R2", expiresAt });
    expect(again.status).toBe(200);
    expect(await stock(p.id, depot)).toMatchObject({ available: 48, hold: 48 });
  });
});
