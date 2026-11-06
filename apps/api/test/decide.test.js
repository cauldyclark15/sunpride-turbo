import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { tx } from "@sunpride/db/client";
import { startHarness, profileStore, boundDevice } from "./harness.js";
import { sha256Hex } from "../src/core/util.js";
import { capabilitiesFor } from "../src/core/capabilities.js";

// Same boundaries as inventory.test.js: other lanes are absent, so only these are mocked.
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
const { install: installStorepos } = await import("../src/domains/storepos/index.js");
const { install: installVan } = await import("../src/domains/van/index.js");
const { install: installDecide } = await import("../src/domains/decide/index.js");
const { postMovement } = await import("../src/domains/inventory/posting.js");
const { commands } = await import("../src/domains/inventory/commands.js");

/** @type {import('./harness.js').Harness} */ let h;
/** @type {ReturnType<typeof profileStore>} */ let profiles;
/** @type {any} */ let admin;
/** @type {any} */ let planner; // manager: plans, may count, may review
/** @type {any} */ let clerk; // operations: counts
/** @type {any} */ let clerk2;
/** @type {any} */ let sup; // approver: reviews and approves
/** @type {any} */ let sup2; // second approver
/** @type {any} */ let cashier;
/** @type {any} */ let boss; // super admin: receives
/** @type {any} */ let device;
/** @type {string} */ let storeLoc;
/** @type {string} */ let unit;
/** @type {string} */ let pc;
/** @type {string} */ let cs;
const MIN = 60000;

/** @param {string} role */
async function person(role) {
  const [u] =
    await h.db`insert into users (email,password_hash) values (${`${crypto.randomUUID()}@test.invalid`},'fixture-not-a-login') returning id`;
  const profile = profiles.set(u.id, { role, orgUnitId: unit });
  const token = `sps_${crypto.randomUUID().replaceAll("-", "")}`;
  await h.db`insert into sessions (user_id,token_hash,app,expires_at) values (${u.id},${sha256Hex(token)},'web',now()+interval '1 day')`;
  // The shared fiscal matrix (F-124) reads persisted people at approval time.
  await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${profile.id},${u.id},${u.id},${`Test ${role}`},${`p-${u.id}@example.test`},${role},'active',${unit})`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${profile.id},${unit},${role},now()-interval '1 day','TEST','TEST')`;
  return {
    userId: u.id,
    profileId: profile.id,
    role,
    orgUnitId: unit,
    capabilities: new Set(capabilitiesFor(role)),
    cookie: `sp_session=${token}`,
  };
}
/** @param {string} name @param {string} [type] @param {string|null} [parent] */
async function location(name, type = "bin", parent = null) {
  const [r] =
    await h.db`insert into inventory_locations (organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production,parent_location_id) values ('sunpride',${unit},'TEST',${name},${name},${type},true,true,true,true,false,${parent}) returning id`;
  return r.id;
}
/** @param {{tracked?:boolean}} [opts] */
async function product(opts = {}) {
  const [p] =
    await h.db`insert into products (code,name,category,uom,unit_price,active,organization_id,base_uom_id,quantity_scale,tracking_mode,allocation_policy) values (${`P-${crypto.randomUUID().slice(0, 8)}`},'Test corned beef','Canned','PC',0,true,'sunpride',${pc},1,${opts.tracked ? "lot" : "none"},'fefo') returning *`;
  await h.db`insert into uom_conversions (organization_id,product_id,from_uom_id,to_uom_id,numerator,denominator,rounding_mode,effective_from,active) values ('sunpride',${p.id},${cs},${pc},48,1,'exact',now()-interval '1 year',true)`;
  if (opts.tracked)
    await h.db`insert into product_inventory_policies (organization_id,product_id,base_uom_id,quantity_scale,quantity_precision,tracking_mode,allocation_policy,allow_mixed_lots_per_line,allow_negative_stock,quality_release_required,expiry_date_required,manufacture_date_required,minimum_remaining_shelf_life_days,costing_method,version,active) values ('sunpride',${p.id},${pc},1,0,'lot','fefo',true,false,false,true,false,0,'weighted_average',1,true)`;
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
/** Stock in with a cost. @param {string} to @param {{p:any,qty:number,cost?:number}[]} items @param {number} [at] */
function stockIn(to, items, at = Date.now() - 6 * 3600000) {
  return tx(h.db, (t) =>
    postMovement(t, {
      kind: "goods_receipt",
      sourceType: "test",
      sourceId: items[0].p.id,
      idempotencyKey: crypto.randomUUID(),
      occurredAt: at,
      actor: admin,
      organizationId: "sunpride",
      lines: items.map((i) => ({
        productId: i.p.id,
        fromLocationId: null,
        toLocationId: to,
        quantityBase: i.qty,
        uom: "PC",
        unitCostMinor: i.cost ?? 100,
      })),
    }),
  );
}
/** Stock out (a sale / a van load) at a given time. @param {string} from @param {any} p @param {number} qty @param {number} at */
function stockOut(from, p, qty, at) {
  return tx(h.db, (t) =>
    postMovement(t, {
      kind: "inventory_issue",
      sourceType: "test",
      sourceId: p.id,
      idempotencyKey: crypto.randomUUID(),
      occurredAt: at,
      actor: admin,
      organizationId: "sunpride",
      lines: [
        { productId: p.id, fromLocationId: from, toLocationId: null, quantityBase: qty, uom: "PC" },
      ],
    }),
  );
}
/** @param {string} loc @param {any} p @param {string} [status] */
async function balance(loc, p, status = "available_stock_base") {
  const [b] =
    await h.db`select * from inventory_balances where product_id=${p.id} and location_id=${loc}`;
  return Number(b?.[status] ?? 0);
}
/** @param {any} who @param {string} sessionId @param {string} [q] */
async function lines(who, sessionId, q = "limit=200") {
  const r = await read(who, `counts/lines?sessionId=${sessionId}&${q}`);
  expect(r.status).toBe(200);
  return r.body;
}
/** Save counts by product id. @param {any} who @param {string} sessionId @param {any[]} all @param {Record<string,number>} counts @param {any} [extra] */
async function saveBy(who, sessionId, all, counts, extra = {}) {
  const entries = all
    .filter((l) => counts[l.productId] !== undefined)
    .map((l) => ({ lineId: l.id, countedBase: counts[l.productId], ...extra }));
  const r = await command(who, "counts/save-lines", { sessionId, lines: entries, ...(extra.deviceLabel ? { deviceLabel: extra.deviceLabel } : {}) });
  return r;
}


/** @param {any} who @param {string} id @param {string} verdict @param {any} [more] */
async function act(who, id, verdict, more = {}) {
  const res = await h.fetch("/api/v1/decide/act", {
    method: "POST",
    headers: { cookie: who.cookie, "content-type": "application/json" },
    body: JSON.stringify({ id, verdict, idempotencyKey: crypto.randomUUID(), ...more }),
  });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}
/** @param {any} who */
async function inbox(who) {
  const res = await h.fetch("/api/v1/decide/inbox", { headers: { cookie: who.cookie } });
  expect(res.status).toBe(200);
  return /** @type {any} */ (await res.json());
}
/** @param {any} who @param {string} ref */
const rowOf = async (who, ref) => (await inbox(who)).items.find((/** @type {any} */ i) => i.ref === ref);

beforeAll(async () => {
  h = await startHarness({ installers: [install, installVan, installStorepos, installDecide] });
  profiles = profileStore(h);
  const [u] =
    await h.db`insert into org_units (organization_id,code,name,type_code,status,effective_from) values ('sunpride','SUNPRIDE','Decide test','national','active',now()-interval '1 day') returning id`;
  unit = u.id;
  h.setHooks({ rootUnitId: async () => unit });
  [admin, planner, clerk, sup, sup2, cashier, boss] = await Promise.all([
    person("admin"),
    person("manager"),
    person("operations"),
    person("approver"),
    person("approver"),
    person("sales"),
    person("super_admin"),
  ]);
  const [piece] =
    await h.db`insert into units_of_measure (organization_id,code,name,dimension,decimal_places,active) values ('sunpride','PC','Piece','count',0,true) returning id`;
  pc = piece.id;
  const [caseUom] =
    await h.db`insert into units_of_measure (organization_id,code,name,dimension,decimal_places,active) values ('sunpride','CS','Case','count',0,true) returning id`;
  cs = caseUom.id;
  for (const role of ["operations", "manager"])
    await h.db`insert into fiscal_authority_rules(org_unit_id,kind,role,channel,min_centavos,max_centavos,self_limit_centavos,approver_roles,offline_allowed,effective_from,sample) values(${unit},'stock',${role},'*',0,100000000,0,${["approver"]},false,'2026-01-01',true)`;
  storeLoc = await location(`Store-${crypto.randomUUID()}`, "store");
}, 30000);
afterAll(async () => {
  await h?.close();
});


describe("transfer differences", () => {
  /** A short delivery: `clerk` dispatched, `boss` received 384 of 480. */
  async function shortTransfer(type = "depot_transfer") {
    const depot = await location(`Dep-${crypto.randomUUID()}`, "warehouse");
    const dest = await location(`Dst-${crypto.randomUUID()}`, "warehouse");
    const transit = await location(`Tr-${crypto.randomUUID()}`, "in_transit");
    const p = await product();
    await stockIn(depot, [{ p, qty: 480, cost: 2000 }]);
    const made = await command(clerk, "transfers/request", {
      type, sourceLocationId: depot, destinationLocationId: dest, inTransitLocationId: transit,
      lines: [{ productId: p.id, quantityBase: 480 }],
    });
    expect((await command(sup, "transfers/approve", { transferId: made.body.id })).status).toBe(200);
    expect((await command(clerk, "transfers/dispatch", { transferId: made.body.id })).status).toBe(200);
    const detail = (await read(boss, `transfers/detail?id=${made.body.id}`)).body;
    const r = await command(boss, "transfers/receive", {
      transferId: made.body.id, final: true, lines: [{ lineId: detail.lines[0].id, receivedGoodBase: 384 }],
    });
    expect(r.body.status).toBe("review_needed");
    return { id: made.body.id, p, transit };
  }
  it("shows the difference with value and rule; the receiver is refused in words; a reject needs a reason and sends it back; approve writes it off", async () => {
    const { id, transit, p } = await shortTransfer();
    const row = await rowOf(sup, id);
    expect(row).toMatchObject({ kind: "transfer_variance", valueCentavos: 96 * 2000, canDecide: true, needs: { chargeTo: true }, sentBack: null });
    expect(row.documentNumber).toMatch(/^TRF-/);
    expect(row.rule).toContain("needs a person to decide");
    // The receiver (who may approve in general) is blocked by the rule, up front and by the server.
    const mine = await rowOf(boss, id);
    expect(mine).toMatchObject({ canDecide: false });
    expect(mine.blockedReason).toMatch(/different person/);
    const refused = await act(boss, row.id, "approve", { chargeTo: "driver" });
    expect(refused.status).toBe(403);
    // Reject needs a reason; with one it is sent back and stays visible, last in the queue.
    expect((await act(sup, row.id, "reject")).status).toBe(422);
    const back = await act(sup, row.id, "reject", { reason: "Count the pallet again" });
    expect(back.status).toBe(200);
    expect(back.body.status).toBe("Sent back for a recount.");
    const after = await rowOf(sup, id);
    expect(after.sentBack).toMatchObject({ reason: "Count the pallet again" });
    expect((await read(boss, `transfers/detail?id=${id}`)).body.status).toBe("review_needed");
    // Approve needs to say who carries it; then one linked adjustment clears In transit and the item leaves the inbox.
    expect((await act(sup, row.id, "approve")).status).toBe(422);
    const ok = await act(sup, row.id, "approve", { chargeTo: "carrier", reason: "Two cases left at the depot gate" });
    expect(ok.status).toBe(200);
    expect(await rowOf(sup, id)).toBeUndefined();
    expect(await balance(transit, p, "in_transit_base")).toBe(0);
    expect((await h.db`select kind,verdict from decide_log where ref_id=${id} order by created_at`).map((/** @type {any} */ r) => `${r.kind}:${r.verdict}`)).toEqual(["transfer_send_back:rejected", "transfer_resolved:approved"]);
    // The same tap twice decides once, and a stale item is a plain 404.
    expect((await act(sup, row.id, "approve", { chargeTo: "carrier" })).status).toBe(404);
  });
});

describe("reload and load-in differences", () => {
  it("a reload document and a load-in document are their own kinds in the same queue, with the same rule", async () => {
    for (const [type, kind, label] of [["van_reload", "reload_difference", "Reload difference"]]) {
      const d = await (async () => {
        const depot = await location(`Rl-${crypto.randomUUID()}`, "warehouse");
        const dest = await location(`Rt-${crypto.randomUUID()}`, "truck");
        const transit = await location(`Rx-${crypto.randomUUID()}`, "in_transit");
        const p = await product();
        await stockIn(depot, [{ p, qty: 96, cost: 2000 }]);
        const made = await command(clerk, "transfers/request", { type, sourceLocationId: depot, destinationLocationId: dest, inTransitLocationId: transit, lines: [{ productId: p.id, quantityBase: 96 }] });
        expect(made.status, JSON.stringify(made.body)).toBe(200);
        expect((await command(sup, "transfers/approve", { transferId: made.body.id })).status).toBe(200);
        expect((await command(clerk, "transfers/dispatch", { transferId: made.body.id })).status).toBe(200);
        const detail = (await read(boss, `transfers/detail?id=${made.body.id}`)).body;
        const r = await command(boss, "transfers/receive", { transferId: made.body.id, final: true, lines: [{ lineId: detail.lines[0].id, receivedGoodBase: 48 }] });
        expect(r.body.status).toBe("review_needed");
        return made.body.id;
      })();
      const row = await rowOf(sup, d);
      expect(row).toMatchObject({ kind, kindLabel: label, valueCentavos: 48 * 2000, canDecide: true });
      expect((await act(sup, row.id, "approve", { chargeTo: "driver", reason: "Left at the first stop" })).status).toBe(200);
    }
  });
});

describe("bad orders", () => {
  it("lists a request with its value and the limit rule; the asker cannot approve; a manager-level one needs a manager", async () => {
    const loc = await location(`Dsp-${crypto.randomUUID()}`, "warehouse");
    const p = await product();
    await tx(h.db, (t) =>
      postMovement(t, {
        kind: "goods_receipt", sourceType: "test", sourceId: p.id, idempotencyKey: crypto.randomUUID(), occurredAt: Date.now(), actor: admin, organizationId: "sunpride",
        lines: [{ productId: p.id, fromLocationId: null, toLocationId: loc, quantityBase: 400, uom: "PC", stockStatus: "expired", unitCostMinor: 1000 }],
      }),
    );
    const small = await command(clerk, "dispositions/request", { locationId: loc, productId: p.id, fromStatus: "expired", quantityBase: 24, decision: "write_off", reasonCode: "EXP" });
    expect(small.status).toBe(200);
    const big = await command(clerk, "dispositions/request", { locationId: loc, productId: p.id, fromStatus: "expired", quantityBase: 200, decision: "write_off", reasonCode: "EXP" });
    expect(big.status).toBe(200);
    const r1 = await rowOf(sup, small.body.id);
    expect(r1).toMatchObject({ kind: "disposition", valueCentavos: 24000, canDecide: true });
    expect(r1.rule).toMatch(/supervisor decides/);
    const r2 = await rowOf(sup, big.body.id);
    expect(r2.rule).toMatch(/manager decides/);
    expect(r2.valueCentavos).toBe(200000);
    // The person who asked cannot decide, and the page says so.
    const asker = await rowOf(clerk, small.body.id);
    expect(asker).toMatchObject({ canDecide: false });
    expect(asker.blockedReason).toMatch(/You asked for this/);
    expect((await act(clerk, r1.id, "approve")).status).toBe(403);
    // A manager may take the small one, not the big one (above the supervisor limit).
    const mgrBig = await rowOf(planner, big.body.id);
    expect(mgrBig.canDecide).toBe(false);
    expect(mgrBig.blockedReason).toMatch(/manager/);
    expect((await act(planner, r1.id, "approve")).status).toBe(200);
    expect((await act(sup, r2.id, "reject", { reason: "Photos do not match the stock" })).status).toBe(200);
    expect((await h.db`select status from inventory_dispositions where id=${big.body.id}`)[0].status).toBe("rejected");
    expect((await h.db`select status from inventory_dispositions where id=${small.body.id}`)[0].status).toBe("posted");
    expect(await rowOf(sup, big.body.id)).toBeUndefined();
  });
});

describe("count reviews", () => {
  it("a submitted count is one row; the counter never sees it; approve posts, reject sends the lines back for a recount", async () => {
    const loc = await location(`Cnt-${crypto.randomUUID()}`, "warehouse");
    const p = await product();
    await stockIn(loc, [{ p, qty: 20, cost: 5000 }]);
    /** @param {number} counted */
    async function submitted(counted) {
      const plan = await command(planner, "counts/plan", { locationId: loc, assignedTo: clerk.userId, blindCount: true, title: "Weekly" });
      expect(plan.status).toBe(200);
      const l = await lines(clerk, plan.body.id);
      expect((await saveBy(clerk, plan.body.id, l.lines, { [p.id]: counted })).status).toBe(200);
      expect((await command(clerk, "counts/submit", { sessionId: plan.body.id })).status).toBe(200);
      return plan.body.id;
    }
    const first = await submitted(10);
    const row = await rowOf(sup, first);
    expect(row).toMatchObject({ kind: "count_review", canDecide: true });
    expect(row.valueCentavos).toBeGreaterThan(0);
    expect(row.documentNumber).toMatch(/^CNT-/);
    expect(await rowOf(clerk, first)).toBeUndefined(); // the counter is not shown their own count
    expect((await act(sup, row.id, "reject")).status).toBe(422);
    const sent = await act(sup, row.id, "reject", { reason: "Recount the top shelf" });
    expect(sent.status).toBe(200);
    expect((await h.db`select status from stock_count_sessions where id=${first}`)[0].status).toBe("counting");
    expect(await rowOf(sup, first)).toBeUndefined();
    // Submit again; a second approver posts it.
    const recount = await lines(clerk, first, "limit=200&filter=recount");
    expect(recount.lines).toHaveLength(1);
    expect((await saveBy(clerk, first, recount.lines, { [p.id]: 10 })).status).toBe(200);
    expect((await command(clerk, "counts/submit", { sessionId: first })).status).toBe(200);
    const again = await rowOf(sup2, first);
    expect(again).toBeTruthy();
    const ok = await act(sup2, again.id, "approve", { reason: "Counted twice" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await h.db`select status from stock_count_sessions where id=${first}`)[0].status).toBe("posted");
    expect(await balance(loc, p)).toBe(10);
  });
});

describe("till counts, forced closes and overrides", () => {
  /** @param {{kind?:string, variance?:number}} [o] */
  async function closure(o = {}) {
    device = await boundDevice(h, profiles, { app: "van-android", orgUnitId: unit });
    await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${device.profile.id},${device.userId},${device.userId},'Device owner',${device.email},'sales','active',${unit}) on conflict do nothing`;
    const [reg] =
      await h.db`insert into store_registers(location_id,terminal_code,name,effective_from) values(${storeLoc},${`T-${crypto.randomUUID().slice(0, 8)}`},'Register 1',now()-interval '1 year') returning id`;
    const [pol] =
      await h.db`insert into store_register_policies(register_id,tolerance_centavos,effective_from) values(${reg.id},10000,now()-interval '1 year') returning id`;
    const [mode] =
      await h.db`insert into pos_device_modes(device_id,register_id,mode,effective_from,actor_profile_id) values(${device.deviceId},${reg.id},'store',now()-interval '1 year',${cashier.profileId}) returning id`;
    const shiftId = crypto.randomUUID();
    await h.db`insert into store_shifts(id,register_id,mode_version_id,policy_id,device_id,cashier_id,service_date,opening_centavos,opened_at) values(${shiftId},${reg.id},${mode.id},${pol.id},${device.deviceId},${cashier.profileId},current_date,500000,now()-interval '9 hours')`;
    const closureId = crypto.randomUUID();
    const variance = o.variance ?? -25000;
    await h.db`insert into store_shift_closures(id,shift_id,declared_centavos,expected_centavos,variance_centavos,needs_review,closed_at,kind,forced_by,force_reason)
      values(${closureId},${shiftId},${1000000 + variance},1000000,${variance},true,now()-interval '1 hour',${o.kind ?? "cashier"},${o.kind === "forced" ? planner.profileId : null},${o.kind === "forced" ? "Cashier went home sick" : null})`;
    return { closureId, regId: reg.id, shiftId };
  }
  it("a short till is a row with its tolerance; the cashier cannot decide it; a manager accepts it; reject opens an investigation", async () => {
    const a = await closure({ variance: -25000 });
    const row = await rowOf(planner, a.closureId);
    expect(row).toMatchObject({ kind: "cash_variance", valueCentavos: 25000, canDecide: true });
    expect(row.title).toContain("short");
    expect(row.rule).toContain("₱100.00");
    expect([403, 404]).toContain((await act(cashier, row.id, "approve")).status); // sales: no authority, and it is not listed for them
    expect((await act(planner, row.id, "reject")).status).toBe(422);
    const ok = await act(planner, row.id, "reject", { reason: "Drawer was left open" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await h.db`select decision from store_shift_decisions where closure_id=${a.closureId}`)[0].decision).toBe("investigate");
    expect(await rowOf(planner, a.closureId)).toBeUndefined();
    const b = await closure({ variance: 30000 });
    expect((await act(sup, `cash_variance:${b.closureId}`, "approve", { reason: "Over, banked" })).status).toBe(200);
    expect((await h.db`select decision from store_shift_decisions where closure_id=${b.closureId}`)[0].decision).toBe("accepted");
  });
  it("a forced close shows who closed it and why; the person who closed it cannot review it", async () => {
    const a = await closure({ kind: "forced" });
    const row = await rowOf(sup, a.closureId);
    expect(row.kindLabel).toBe("Forced close");
    expect(row.rule).toContain("Cashier went home sick");
    const closer = await rowOf(planner, a.closureId);
    expect(closer).toMatchObject({ canDecide: false });
    expect(closer.blockedReason).toMatch(/You closed this session/);
    expect((await act(planner, row.id, "approve")).status).toBe(403);
    expect((await act(sup, row.id, "approve", { reason: "Verified with the store manager" })).status).toBe(200);
  });
  it("a refund approved at the till gets a second look from someone who was not there; it is logged and leaves the inbox", async () => {
    const a = await closure({ variance: 0 });
    const [o] = await h.db`insert into store_overrides(id,register_id,shift_id,kind,method,supervisor_profile_id,cashier_profile_id,reason,amount_centavos,ref_type,ref_id,captured_at)
      values(${crypto.randomUUID()},${a.regId},${a.shiftId},'refund','pin_online',${planner.profileId},${cashier.profileId},'Wrong item',45000,'sale',${crypto.randomUUID()},now()-interval '2 hours') returning id`;
    const row = await rowOf(sup, o.id);
    expect(row).toMatchObject({ kind: "override_review", valueCentavos: 45000, canDecide: true });
    expect(row.title).toContain("Refund");
    const involved = await rowOf(planner, o.id);
    expect(involved).toMatchObject({ canDecide: false });
    expect((await act(planner, row.id, "approve")).status).toBe(403);
    expect((await act(sup, row.id, "reject", { reason: "No receipt on file" })).status).toBe(200);
    expect(await rowOf(sup, o.id)).toBeUndefined();
    const [log] = await h.db`select verdict,reason,value_centavos from decide_log where kind='override_review' and ref_id=${o.id}`;
    expect(log).toMatchObject({ verdict: "rejected", reason: "No receipt on file" });
    expect(Number(log.value_centavos)).toBe(45000);
  });
});

describe("the inbox", () => {
  it("counts every kind, is readable by everyone who may read stock, and keeps a recent-decisions list", async () => {
    const res = await inbox(sup);
    expect(typeof res.total).toBe("number");
    expect(res.kinds.load_difference).toBe("Load difference");
    expect(res.recent.length).toBeGreaterThan(0);
    expect(res.recent[0]).toMatchObject({ by: expect.any(String) });
    expect(res.warnings).toEqual([]);
    const sales = await inbox(cashier);
    expect(sales.items.every((/** @type {any} */ i) => i.canDecide === false)).toBe(true);
  });
  it("refuses a bad request in words", async () => {
    expect((await act(sup, "nonsense", "approve")).status).toBe(422);
    const noKey = await h.fetch("/api/v1/decide/act", { method: "POST", headers: { cookie: sup.cookie, "content-type": "application/json" }, body: JSON.stringify({ id: "count_review:x", verdict: "approve" }) });
    expect(noKey.status).toBe(400);
    expect((await act(sup, "count_review:00000000-0000-0000-0000-000000000000", "maybe")).status).toBe(422);
  });
});
