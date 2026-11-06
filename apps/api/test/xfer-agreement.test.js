import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { tx } from "@sunpride/db/client";
import { startHarness, profileStore } from "./harness.js";
import { sha256Hex } from "../src/core/util.js";
import { capabilitiesFor } from "../src/core/capabilities.js";

// IP-NAV: resolve a difference by agreement of the clerk and the seller (SPEC 5.2 step 6): proven, not skipped.
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
const { resolveVarianceByAgreement } =
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


/** A 480-piece document, received 384 good by `admin` (the seller side): 96 short, in review. */
async function shortDocument() {
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
  return { p, id };
}
/** @param {any} p @param {number} clerkBase @param {number} sellerBase */
const agreed = (p, clerkBase, sellerBase) => [
  { productId: p.id, lotId: null, clerkBase, sellerBase },
];
/** @param {string} id @param {any} extra */
const agree = (id, extra) =>
  tx(h.db, (db) =>
    resolveVarianceByAgreement(db, "sunpride", id, {
      idempotencyKey: `agree:${crypto.randomUUID()}`,
      ...extra,
    }),
  );

describe("resolve by agreement", () => {
  it("is refused unless it is two different people, the seller received it, and the counts are the same and match the receipt", async () => {
    const { p, id } = await shortDocument();
    // The same person cannot be both.
    await expect(
      agree(id, { clerkId: admin.userId, sellerId: admin.userId, lines: agreed(p, 384, 384) }),
    ).rejects.toMatchObject({ code: "self_approval" });
    // The seller must be the person who received.
    await expect(
      agree(id, { clerkId: approver.userId, sellerId: clerk.userId, lines: agreed(p, 384, 384) }),
    ).rejects.toMatchObject({ code: "self_approval" });
    // Different counts go to a supervisor.
    await expect(
      agree(id, { clerkId: clerk.userId, sellerId: admin.userId, lines: agreed(p, 480, 384) }),
    ).rejects.toMatchObject({ code: "counts_differ" });
    // Same counts but not what was received.
    await expect(
      agree(id, { clerkId: clerk.userId, sellerId: admin.userId, lines: agreed(p, 400, 400) }),
    ).rejects.toMatchObject({ code: "counts_differ" });
    // A line with a difference must be named.
    await expect(
      agree(id, { clerkId: clerk.userId, sellerId: admin.userId, lines: [] }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    // Nothing was posted by any refusal.
    expect((await stock(p.id, transit)).transit).toBe(96);
    expect((await detail(id)).status).toBe("review_needed");
  });

  it("clears the short through one linked adjustment, records both signatures, and cannot be repeated", async () => {
    const { p, id } = await shortDocument();
    const done = await agree(id, {
      clerkId: clerk.userId,
      sellerId: admin.userId,
      lines: agreed(p, 384, 384),
      chargeTo: "dispatch_side",
      shortReasonCode: "SHORT-TRANSIT",
    });
    expect(done).toMatchObject({ status: "closed", shortBase: 96, agreement: "clerk_and_seller" });
    expect((await stock(p.id, transit)).transit).toBe(0);
    const [res] =
      await h.db`select charge_to,agreement,agreed_clerk_id,agreed_seller_id,decided_by,short_base from stock_transfer_resolutions where transfer_id=${id}`;
    expect(res).toMatchObject({
      charge_to: "dispatch_side",
      agreement: "clerk_and_seller",
      agreed_clerk_id: clerk.userId,
      agreed_seller_id: admin.userId,
      decided_by: clerk.userId,
    });
    const [adj] =
      await h.db`select adjustment_type,status,approved_by,requested_by from inventory_adjustments where source_transfer_id=${id}`;
    expect(adj).toMatchObject({ adjustment_type: "transfer_variance", status: "posted", approved_by: clerk.userId, requested_by: admin.userId });
    expect((await detail(id)).status).toBe("closed");
    await expect(
      agree(id, { clerkId: clerk.userId, sellerId: admin.userId, lines: agreed(p, 384, 384) }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("the normal resolve still refuses the sender and the receiver", async () => {
    const { id } = await shortDocument();
    const own = await command(admin, "transfers/resolve-variance", {
      transferId: id,
      chargeTo: "driver",
      reasonCode: "SHORT-TRANSIT",
    });
    expect(own.status).toBe(403);
  });
});
