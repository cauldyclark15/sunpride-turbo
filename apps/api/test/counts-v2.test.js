import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { tx } from "@sunpride/db/client";
import { startHarness, profileStore } from "./harness.js";
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
const { postMovement } = await import("../src/domains/inventory/posting.js");
const { commands } = await import("../src/domains/inventory/commands.js");
const { planDueCounts } = await import("../src/domains/inventory/counts.js");
const { canClaimInventoryMedia } = await import("../src/domains/inventory/media.js");

/** @type {import('./harness.js').Harness} */ let h;
/** @type {ReturnType<typeof profileStore>} */ let profiles;
/** @type {any} */ let admin;
/** @type {any} */ let planner; // manager: plans, may count, may review
/** @type {any} */ let clerk; // operations: counts
/** @type {any} */ let clerk2;
/** @type {any} */ let sup; // approver: reviews and approves
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

beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  profiles = profileStore(h);
  const [u] =
    await h.db`insert into org_units (organization_id,code,name,type_code,status,effective_from) values ('sunpride','CNT-ROOT','Counts test','national','active',now()-interval '1 day') returning id`;
  unit = u.id;
  h.setHooks({ rootUnitId: async () => unit });
  [admin, planner, clerk, clerk2, sup] = await Promise.all([
    person("admin"),
    person("manager"),
    person("operations"),
    person("operations"),
    person("approver"),
  ]);
  const [piece] =
    await h.db`insert into units_of_measure (organization_id,code,name,dimension,decimal_places,active) values ('sunpride','PC','Piece','count',0,true) returning id`;
  pc = piece.id;
  const [caseUom] =
    await h.db`insert into units_of_measure (organization_id,code,name,dimension,decimal_places,active) values ('sunpride','CS','Case','count',0,true) returning id`;
  cs = caseUom.id;
  for (const role of ["operations", "manager"])
    await h.db`insert into fiscal_authority_rules(org_unit_id,kind,role,channel,min_centavos,max_centavos,self_limit_centavos,approver_roles,offline_allowed,effective_from,sample) values(${unit},'stock',${role},'*',0,100000000,0,${["approver"]},false,'2026-01-01',true)`;
  // IP-INT2: an admin's own band (used when a till cashier's count is approved on the approver's authority).
  await h.db`insert into fiscal_authority_rules(org_unit_id,kind,role,channel,min_centavos,max_centavos,self_limit_centavos,approver_roles,offline_allowed,effective_from,sample) values(${unit},'stock','admin','*',0,100000000,100000,${["super_admin"]},false,'2026-01-01',true)`;
}, 30000);
afterAll(async () => {
  await h?.close();
});

describe("SPEC 4.9: a van load during the count does not throw it out", () => {
  it("08:00 count, line counted 08:30, van loads 09:00: approves cleanly and lands on the right stock", async () => {
    const t0 = Date.now() - 4 * 3600000; // "08:00"
    const loc = await location(`Depot-${crypto.randomUUID()}`, "warehouse");
    const [a, b, c] = [await product(), await product(), await product()];
    await stockIn(loc, [{ p: a, qty: 20 }, { p: b, qty: 20 }, { p: c, qty: 20 }], t0 - 3600000);
    const plan = await command(planner, "counts/plan", {
      locationId: loc,
      assignedTo: clerk.userId,
      blindCount: true,
      title: "Morning count",
    });
    expect(plan.status).toBe(200);
    expect(plan.body.number).toMatch(/^CNT-/);
    expect(plan.body.lines).toBe(3);
    const sid = plan.body.id;
    const first = await lines(clerk, sid);
    expect(first.lines).toHaveLength(3);
    // B is counted at 08:30 BEFORE the load posts, A and C are saved after it (late sync).
    const at = t0 + 30 * MIN;
    expect((await saveBy(clerk, sid, first.lines, { [b.id]: 20 }, { countedAt: at })).status).toBe(200);
    // 09:00 the van loads 6 of A, 5 of B and 5 of C (movement time 09:00).
    for (const [p, n] of [[a, 6], [b, 5], [c, 5]])
      await stockOut(loc, p, n, t0 + 60 * MIN);
    expect(await balance(loc, a)).toBe(14);
    // A counted 20 and C counted 18 at 08:30, saved only now.
    expect(
      (await saveBy(clerk, sid, first.lines, { [a.id]: 20, [c.id]: 18 }, { countedAt: at })).status,
    ).toBe(200);
    const submitted = await command(clerk, "counts/submit", { sessionId: sid });
    expect(submitted.status).toBe(200);
    // A and B exact, C is -2 pieces / P2: inside tolerance, accepted on the spot.
    expect(submitted.body.autoAccepted).toBe(3);
    expect(submitted.body.needsReview).toBe(0);
    const approved = await command(sup, "counts/approve", { sessionId: sid });
    expect(approved.status).toBe(200);
    expect(approved.body.posted).toBe(1);
    expect(await balance(loc, a)).toBe(14);
    expect(await balance(loc, b)).toBe(15);
    expect(await balance(loc, c)).toBe(13); // 20 - 5 loaded - 2 missing
    const adj = await h.db`select * from inventory_adjustments where source_count_id=${sid}`;
    expect(adj).toHaveLength(1);
    expect(adj[0].adjustment_number).toMatch(/^ADJ-/);
    expect(adj[0].status).toBe("posted");
  });
});

describe("plan: scope, counter, blind", () => {
  it("scopes by bin range in bin order, by product filter and by fast movers", async () => {
    const root = await location(`WH-${crypto.randomUUID()}`, "warehouse");
    const bins = [
      await location("B-01", "bin", root),
      await location("B-02", "bin", root),
      await location("B-03", "bin", root),
    ];
    const ps = [await product(), await product(), await product(), await product()];
    await stockIn(bins[0], [{ p: ps[0], qty: 50 }]);
    await stockIn(bins[1], [{ p: ps[1], qty: 50 }, { p: ps[2], qty: 50 }]);
    await stockIn(bins[2], [{ p: ps[3], qty: 50 }]);
    // ps[2] sells a lot, ps[1] a little, the rest never.
    for (let i = 0; i < 3; i++) await stockOut(bins[1], ps[2], 1, Date.now() - (i + 1) * MIN);
    await stockOut(bins[1], ps[1], 1, Date.now() - MIN);

    const all = await command(planner, "counts/plan", { locationId: root, includeSublocations: true, blindCount: false });
    expect(all.body.lines).toBe(4);
    const allLines = await lines(planner, all.body.id);
    expect(allLines.lines.map((/** @type {any} */ l) => l.bin)).toEqual(["B-01", "B-02", "B-02", "B-03"]);

    const range = await command(planner, "counts/plan", { locationId: root, includeSublocations: true, scope: { binFrom: "B-02", binTo: "B-03" }, countType: "cycle" });
    expect(range.body.lines).toBe(3);
    const fast = await command(planner, "counts/plan", { locationId: root, includeSublocations: true, scope: { fastMovers: { days: 7, top: 1 } }, countType: "cycle" });
    expect(fast.body.lines).toBe(1);
    expect((await lines(planner, fast.body.id)).lines[0].productId).toBe(ps[2].id);
    const some = await command(planner, "counts/plan", { locationId: root, includeSublocations: true, scope: { productIds: [ps[0].id, ps[3].id] }, countType: "cycle" });
    expect(some.body.lines).toBe(2);
    const preview = await read(planner, `counts/preview?locationId=${root}&includeSublocations=1&binFrom=B-01&binTo=B-01`);
    expect(preview.body.lines).toBe(1);
    // A full count of part of the place is a contradiction in terms.
    const bad = await command(planner, "counts/plan", { locationId: root, countType: "full", scope: { binFrom: "B-02" } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("scope_needs_cycle");
  });

  it("the assigned counter never sees expected on a blind count; the reviewer does; only the counter may enter", async () => {
    const loc = await location(`Blind-${crypto.randomUUID()}`);
    const p = await product();
    await stockIn(loc, [{ p, qty: 10 }]);
    const plan = await command(planner, "counts/plan", { locationId: loc, assignedTo: clerk.userId });
    const sid = plan.body.id;
    const mine = await read(clerk, "counts/mine");
    expect(mine.body.mine.map((/** @type {any} */ s) => s.id)).toContain(sid);
    expect((await read(planner, "counts/mine")).body.mine.map((/** @type {any} */ s) => s.id)).not.toContain(sid);
    const counter = await lines(clerk, sid);
    expect(counter.canSeeExpected).toBe(false);
    expect(counter.lines[0]).not.toHaveProperty("expected");
    expect(counter.lines[0]).not.toHaveProperty("variance");
    expect(counter.lines[0].basePerCase).toBe(48);
    // Stock screens stay embargoed for the counter while the blind count is open (existing rule), not for the planner.
    expect((await command(planner, "counts/save-lines", { sessionId: sid, lines: [{ lineId: counter.lines[0].id, countedBase: 9 }] })).status).toBe(403);
    expect((await command(clerk2, "counts/save-lines", { sessionId: sid, lines: [{ lineId: counter.lines[0].id, countedBase: 9 }] })).status).toBe(403);
    expect((await command(clerk, "counts/save-lines", { sessionId: sid, lines: [{ lineId: counter.lines[0].id, countedBase: 9 }] })).status).toBe(200);
    const review = await read(sup, `counts/review?sessionId=${sid}`);
    expect(review.body.canSeeExpected).toBe(true);
    expect(review.body.lines[0].expected.base).toBe(10);
    expect(review.body.lines[0].variance.base).toBe(-1);
    // The counter can't open the review numbers either.
    expect((await read(clerk, `counts/review?sessionId=${sid}`)).status).toBe(403);
    // An assignee must be able to count here.
    const nobody = await command(planner, "counts/plan", { locationId: loc, assignedTo: crypto.randomUUID() });
    expect(nobody.status).toBe(422);
  });

  it("a non-blind count shows expected to the counter", async () => {
    const loc = await location(`Open-${crypto.randomUUID()}`);
    const p = await product();
    await stockIn(loc, [{ p, qty: 7 }]);
    const plan = await command(clerk, "counts/plan", { locationId: loc, blindCount: false });
    const r = await lines(clerk, plan.body.id);
    expect(r.canSeeExpected).toBe(true);
    expect(r.lines[0].expected.base).toBe(7);
  });
});

describe("count: save per line, found items, findings", () => {
  it("saves partial drafts, resends are idempotent, an older save from another device does not win", async () => {
    const loc = await location(`Save-${crypto.randomUUID()}`);
    const [a, b] = [await product(), await product()];
    await stockIn(loc, [{ p: a, qty: 10 }, { p: b, qty: 10 }]);
    const plan = await command(planner, "counts/plan", { locationId: loc, assignedTo: clerk.userId });
    const sid = plan.body.id;
    const { lines: ls } = await lines(clerk, sid);
    expect((await command(clerk, "counts/submit", { sessionId: sid })).status).toBe(409); // nothing counted yet
    const k = crypto.randomUUID();
    const one = await command(clerk, "counts/save-lines", { idempotencyKey: k, sessionId: sid, deviceLabel: "Phone A", lines: [{ lineId: ls[0].id, countedBase: 10, clientOpId: "op-1" }] });
    expect(one.body.progress).toMatchObject({ total: 2, counted: 1 });
    const [session] = await h.db`select status,counting_started_at from stock_count_sessions where id=${sid}`;
    expect(session.status).toBe("counting");
    // Same key again: replayed, nothing changes.
    const again = await command(clerk, "counts/save-lines", { idempotencyKey: k, sessionId: sid, deviceLabel: "Phone A", lines: [{ lineId: ls[0].id, countedBase: 10, clientOpId: "op-1" }] });
    expect(again.body.duplicate).toBe(true);
    // Same line op from a retry with a new key: duplicate result.
    const retry = await command(clerk, "counts/save-lines", { sessionId: sid, lines: [{ lineId: ls[0].id, countedBase: 10, clientOpId: "op-1" }] });
    expect(retry.body.results[0].result).toBe("duplicate");
    // Phone B saved the same line earlier in real life (older countedAt): it is ignored.
    const old = await command(clerk, "counts/save-lines", { sessionId: sid, deviceLabel: "Phone B", lines: [{ lineId: ls[0].id, countedBase: 3, countedAt: Date.now() - 2 * 3600000 }] });
    expect(old.body.results[0].result).toBe("superseded");
    const [row] = await h.db`select counted_base,device_label from stock_count_lines where id=${ls[0].id}`;
    expect(Number(row.counted_base)).toBe(10);
    expect(row.device_label).toBe("Phone A");
    const bad = await command(clerk, "counts/save-lines", { sessionId: sid, lines: [{ lineId: crypto.randomUUID(), countedBase: 1 }] });
    expect(bad.status).toBe(422);
    const events = await h.db`select kind from stock_count_line_events where session_id=${sid}`;
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it("adds a found item and a wrong batch; an unknown batch is refused; findings carry a photo", async () => {
    const loc = await location(`Found-${crypto.randomUUID()}`);
    const other = await location(`Other-${crypto.randomUUID()}`);
    const known = await product();
    const found = await product();
    const tracked = await product({ tracked: true });
    await stockIn(loc, [{ p: known, qty: 10 }]);
    await stockIn(other, [{ p: found, qty: 1, cost: 250 }]); // a found item still needs a cost known somewhere
    // Two batches of the tracked product exist; only L1 is in this place.
    for (const [lot, place] of [["L1", loc], ["L2", other]])
      expect(
        (await command(admin, "receipts/post", { receivingLocationId: place, lines: [{ productId: tracked.id, quantityBase: 12, lotNumber: lot, expiresAt: Date.now() + 90 * 86400000, unitCostMinor: 100 }] })).status,
      ).toBe(200);
    const plan = await command(planner, "counts/plan", { locationId: loc, assignedTo: clerk.userId });
    const sid = plan.body.id;
    const ls = (await lines(clerk, sid)).lines;
    expect(ls).toHaveLength(2); // known + tracked L1
    const l1 = ls.find((/** @type {any} */ l) => l.lotNumber === "L1");
    // Wrong batch: the shelf holds L2, which the books keep elsewhere.
    const wrong = await command(clerk, "counts/add-line", { sessionId: sid, productId: tracked.id, lotNumber: "L2", countedBase: 4, finding: "wrong_lot", note: "L2 on the L1 shelf" });
    expect(wrong.status).toBe(200);
    expect(wrong.body.created).toBe(true);
    const unknown = await command(clerk, "counts/add-line", { sessionId: sid, productId: tracked.id, lotNumber: "NOPE", countedBase: 1 });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe("lot_required");
    // A product the plan never listed, found on the shelf.
    const add = await command(clerk, "counts/add-line", { sessionId: sid, productId: found.id, countedBase: 3 });
    expect(add.status).toBe(200);
    const [fl] = await h.db`select source,finding,system_base,counted_base from stock_count_lines where id=${add.body.lineId}`;
    expect(fl).toMatchObject({ source: "found", finding: "over" });
    expect(Number(fl.system_base)).toBe(0);
    // Same thing again is a save, not a second line.
    const again = await command(clerk, "counts/add-line", { sessionId: sid, productId: found.id, countedBase: 4 });
    expect(again.body.created).toBe(false);
    expect(Number((await h.db`select counted_base from stock_count_lines where id=${add.body.lineId}`)[0].counted_base)).toBe(4);
    // A damaged finding with a photo.
    const [file] = await h.db`insert into files (owner_id,purpose,sha256,mime,size,status,created_by) values (null,'count-finding',${"a".repeat(64)},'image/jpeg',1234,'stored',${clerk.userId}) returning id`;
    const foreignPhoto = await command(clerk, "counts/save-lines", { sessionId: sid, lines: [{ lineId: ls.find((/** @type {any} */ l) => !l.lotNumber).id, countedBase: 8, finding: "damaged", photoFileId: crypto.randomUUID() }] });
    expect(foreignPhoto.status).toBe(422);
    const ok = await command(clerk, "counts/save-lines", { sessionId: sid, lines: [{ lineId: ls.find((/** @type {any} */ l) => !l.lotNumber).id, countedBase: 8, finding: "damaged", note: "2 dented", photoFileId: file.id }, { lineId: l1.id, countedBase: 12 }] });
    expect(ok.status).toBe(200);
    const all = await lines(clerk, sid);
    expect(all.lines.find((/** @type {any} */ l) => l.finding === "damaged")).toMatchObject({ photoFileId: file.id, note: "2 dented" });
    expect(all.progress.total).toBe(4);
    expect((await command(clerk, "counts/submit", { sessionId: sid })).status).toBe(200);

    // Review: the damaged line (−2, ₱2) is inside tolerance; the found items need a decision. Damage-handling needs a photo.
    const review = await read(sup, `counts/review?sessionId=${sid}&filter=needs_review`);
    const needs = review.body.lines;
    const foundLine = needs.find((/** @type {any} */ l) => l.id === add.body.lineId);
    expect(foundLine.source).toBe("found");
    expect(foundLine.tolerance.within).toBe(false);
    const noReason = await command(sup, "counts/review", { sessionId: sid, lineId: foundLine.id, decision: "accepted" });
    expect(noReason.body.error.code).toBe("reason_required");
    const wrongDir = await command(sup, "counts/review", { sessionId: sid, lineId: foundLine.id, decision: "accepted", reasonCode: "EXP", note: "x" });
    expect(wrongDir.body.error.code).toBe("reason_code_invalid"); // Expired is stock going out; this is stock found
    expect((await command(sup, "counts/review", { sessionId: sid, lineId: foundLine.id, decision: "accepted", reasonCode: "FOUND", note: "On the wrong shelf" })).status).toBe(200);
    const wrongLine = needs.find((/** @type {any} */ l) => l.id === wrong.body.lineId);
    expect((await command(sup, "counts/review", { sessionId: sid, lineId: wrongLine.id, decision: "accepted", reasonCode: "FOUND", note: "L2 shelf" })).status).toBe(200);
    expect((await command(sup, "counts/approve", { sessionId: sid })).status).toBe(200);
    expect(await balance(loc, found)).toBe(4);
    const [lot2] = await h.db`select physical_base from inventory_lot_balances b join inventory_lots l on l.id=b.lot_id where l.lot_number='L2' and b.location_id=${loc}`;
    expect(Number(lot2.physical_base)).toBe(4);
  });
});

describe("review: per line, sorted by peso difference, tolerance, recount, reasons", () => {
  it("orders lines by peso difference, auto-accepts inside tolerance, lets a reviewer reject or recount a line, posts per-line reasons", async () => {
    const loc = await location(`Review-${crypto.randomUUID()}`);
    const [a, b, c, d] = [await product(), await product(), await product(), await product()];
    await stockIn(loc, [
      { p: a, qty: 20, cost: 100 }, // 5 short x P1 = P5
      { p: b, qty: 20, cost: 5000 }, // 3 short x P50 = P150
      { p: c, qty: 20, cost: 100 }, // 1 over = P1 (inside tolerance)
      { p: d, qty: 20, cost: 100 }, // exact
    ]);
    const plan = await command(planner, "counts/plan", { locationId: loc, assignedTo: clerk.userId });
    const sid = plan.body.id;
    const ls = (await lines(clerk, sid)).lines;
    expect((await saveBy(clerk, sid, ls, { [a.id]: 15, [b.id]: 17, [c.id]: 21, [d.id]: 20 })).status).toBe(200);
    const sub = await command(clerk, "counts/submit", { sessionId: sid });
    expect(sub.body).toMatchObject({ autoAccepted: 2, needsReview: 2 });
    // Cannot approve while two lines wait for a decision.
    const early = await command(sup, "counts/approve", { sessionId: sid });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("review_required");
    const review = await read(sup, `counts/review?sessionId=${sid}`);
    expect(review.body.lines.map((/** @type {any} */ l) => l.productId).slice(0, 2)).toEqual([b.id, a.id]);
    expect(review.body.lines[0].diffCentavos).toBe(15000);
    expect(review.body.lines[1].diffCentavos).toBe(500);
    expect(review.body.summary).toMatchObject({ withDifference: 3, autoAccepted: 2, needsReview: 2, shortCentavos: 15500, overCentavos: 100, netCentavos: -15400 });
    expect(review.body.tolerance).toMatchObject({ maxCentavos: 50000, maxPieces: 2 });
    const lineA = review.body.lines.find((/** @type {any} */ l) => l.productId === a.id);
    const lineB = review.body.lines.find((/** @type {any} */ l) => l.productId === b.id);
    // B: recount. The counter's number is cleared and the session goes back to counting.
    const rc = await command(sup, "counts/request-recount", { sessionId: sid, lineIds: [lineB.id], note: "Check the second shelf" });
    expect(rc.status).toBe(200);
    expect(rc.body.status).toBe("counting");
    const cl = await lines(clerk, sid, "filter=recount");
    expect(cl.lines).toHaveLength(1);
    expect(cl.lines[0]).toMatchObject({ needsRecount: true, recountNote: "Check the second shelf", counted: null });
    expect(cl.lines[0]).not.toHaveProperty("previousCounted"); // blind: no hint of the first number
    const mineAfter = await read(clerk, "counts/mine");
    expect(mineAfter.body.mine.find((/** @type {any} */ s) => s.id === sid).progress.recount).toBe(1);
    // Re-submit before recounting is refused.
    expect((await command(clerk, "counts/submit", { sessionId: sid })).status).toBe(409);
    expect((await saveBy(clerk, sid, ls, { [b.id]: 19 })).status).toBe(200); // found 2 more on recount: -1
    const sub2 = await command(clerk, "counts/submit", { sessionId: sid });
    expect(sub2.body.autoAccepted + sub2.body.needsReview).toBeGreaterThanOrEqual(1);
    // A: leave it out, with a reason in words.
    expect((await command(sup, "counts/review", { sessionId: sid, lineId: lineA.id, decision: "rejected" })).status).toBe(422);
    expect((await command(sup, "counts/review", { sessionId: sid, lineId: lineA.id, decision: "rejected", note: "Counted the wrong pallet" })).status).toBe(200);
    // The counter can't approve their own count.
    expect((await command(clerk, "counts/approve", { sessionId: sid })).status).toBe(403);
    const done = await command(sup, "counts/approve", { sessionId: sid });
    expect(done.status).toBe(200);
    expect(await balance(loc, a)).toBe(20); // rejected: untouched
    expect(await balance(loc, b)).toBe(19);
    expect(await balance(loc, c)).toBe(21);
    const reasons = await h.db`select l.product_id,l.reason_code from inventory_adjustment_lines l join inventory_adjustments a on a.id=l.adjustment_id where a.source_count_id=${sid}`;
    expect(reasons).toHaveLength(2);
    expect(reasons.every((/** @type {any} */ r) => r.reason_code === "COUNT-ERR")).toBe(true);
    const hist = await h.db`select kind from stock_count_line_events where line_id=${lineB.id} order by occurred_at`;
    expect(hist.map((/** @type {any} */ r) => r.kind)).toContain("recount_requested");
    expect((await h.db`select previous_counted_base,recount_count from stock_count_lines where id=${lineB.id}`)[0]).toMatchObject({ recount_count: 1 });
  });

  it("each accepted line carries its own reason; a photo-required reason needs the photo", async () => {
    const loc = await location(`Reasons-${crypto.randomUUID()}`);
    const [a, b] = [await product(), await product()];
    await stockIn(loc, [{ p: a, qty: 30, cost: 100 }, { p: b, qty: 30, cost: 100 }]);
    const plan = await command(planner, "counts/plan", { locationId: loc, assignedTo: clerk.userId });
    const sid = plan.body.id;
    const ls = (await lines(clerk, sid)).lines;
    const [photo] = await h.db`insert into files (owner_id,purpose,sha256,mime,size,status,created_by) values (null,'count-finding',${"b".repeat(64)},'image/jpeg',99,'stored',${clerk.userId}) returning id`;
    await saveBy(clerk, sid, ls, { [a.id]: 20, [b.id]: 25 });
    await command(clerk, "counts/save-lines", { sessionId: sid, lines: [{ lineId: ls.find((/** @type {any} */ l) => l.productId === a.id).id, countedBase: 20, finding: "damaged" }] });
    expect((await command(clerk, "counts/submit", { sessionId: sid })).body.needsReview).toBe(2);
    const lineA = ls.find((/** @type {any} */ l) => l.productId === a.id);
    const lineB = ls.find((/** @type {any} */ l) => l.productId === b.id);
    const noPhoto = await command(sup, "counts/review", { sessionId: sid, lineId: lineA.id, decision: "accepted", reasonCode: "DMG-HANDLING", note: "Crushed pallet" });
    expect(noPhoto.status).toBe(422);
    expect(noPhoto.body.error.message).toContain("photo");
    // The counter attaches the photo with a resubmit of the line... after a recount; here simply attach via the DB-free path: recount.
    expect((await command(sup, "counts/request-recount", { sessionId: sid, lineIds: [lineA.id] })).status).toBe(200);
    expect((await command(clerk, "counts/save-lines", { sessionId: sid, lines: [{ lineId: lineA.id, countedBase: 20, finding: "damaged", photoFileId: photo.id }] })).status).toBe(200);
    expect((await command(clerk, "counts/submit", { sessionId: sid })).status).toBe(200);
    expect((await command(sup, "counts/review", { sessionId: sid, lineId: lineA.id, decision: "accepted", reasonCode: "DMG-HANDLING", note: "Crushed pallet" })).status).toBe(200);
    expect((await command(sup, "counts/review", { sessionId: sid, lineId: lineB.id, decision: "accepted", reasonCode: "SHORT-PICK" })).status).toBe(200);
    const done = await command(sup, "counts/approve", { sessionId: sid });
    expect(done.status).toBe(200);
    const rs = await h.db`select l.product_id,l.reason_code,l.variance_base from inventory_adjustment_lines l join inventory_adjustments a on a.id=l.adjustment_id where a.source_count_id=${sid}`;
    const byProduct = Object.fromEntries(rs.map((/** @type {any} */ r) => [r.product_id, r.reason_code]));
    expect(byProduct).toEqual({ [a.id]: "DMG-HANDLING", [b.id]: "SHORT-PICK" });
    expect(await balance(loc, a)).toBe(20);
    expect(await balance(loc, b)).toBe(25);
    // One adjustment, one movement.
    expect(await h.db`select id from inventory_adjustments where source_count_id=${sid}`).toHaveLength(1);
  });
});

describe("SPEC 4.9: a 300-line count over two sessions and two devices, approved per line", () => {
  it("counts 300 lines from two phones, pages them, reviews per line, and posts one adjustment (130+ lines in two writer batches)", async () => {
    const loc = await location(`Big-${crypto.randomUUID()}`);
    /** @type {any[]} */ const ps = [];
    for (let i = 0; i < 300; i++) ps.push(await product());
    for (let i = 0; i < 300; i += 100)
      await stockIn(loc, ps.slice(i, i + 100).map((p) => ({ p, qty: 10, cost: 100 })));
    const plan = await command(planner, "counts/plan", { locationId: loc, assignedTo: clerk.userId, blindCount: true });
    expect(plan.status).toBe(200);
    expect(plan.body.lines).toBe(300);
    const sid = plan.body.id;
    // Paged: three pages of 100, no cap.
    const p1 = await lines(clerk, sid, "limit=100");
    expect(p1.lines).toHaveLength(100);
    expect(p1.nextCursor).toBe("100");
    const p2 = await lines(clerk, sid, `limit=100&cursor=${p1.nextCursor}`);
    const p3 = await lines(clerk, sid, `limit=100&cursor=${p2.nextCursor}`);
    expect(p3.nextCursor).toBeNull();
    const ls = [...p1.lines, ...p2.lines, ...p3.lines];
    expect(new Set(ls.map((/** @type {any} */ l) => l.id)).size).toBe(300);
    const counts = new Map();
    ps.forEach((p, i) => {
      // 0-129: one short (inside tolerance, auto). 130-134: five short (needs review). 135: found 4 over (needs review).
      counts.set(p.id, i < 130 ? 9 : i < 135 ? 5 : i === 135 ? 14 : 10);
    });
    const byId = new Map(ls.map((/** @type {any} */ l) => [l.productId, l.id]));
    const entries = ps.map((p) => ({ lineId: byId.get(p.id), countedBase: counts.get(p.id) }));
    // Session one, phone A: first 150 lines. Count the rest from phone B in a second session.
    expect((await command(clerk, "counts/save-lines", { sessionId: sid, deviceLabel: "Phone A", lines: entries.slice(0, 150) })).status).toBe(200);
    const mid = await lines(clerk, sid, "filter=todo&limit=200");
    expect(mid.progress).toMatchObject({ total: 300, counted: 150 });
    expect(mid.lines).toHaveLength(150);
    // Not done yet.
    const early = await command(clerk, "counts/submit", { sessionId: sid });
    expect(early.status).toBe(409);
    expect(early.body.error.message).toContain("150 items still need a count");
    expect((await command(clerk, "counts/save-lines", { sessionId: sid, deviceLabel: "Phone B", lines: entries.slice(150, 300) })).status).toBe(200);
    const sub = await command(clerk, "counts/submit", { sessionId: sid });
    expect(sub.status).toBe(200);
    expect(sub.body).toMatchObject({ autoAccepted: 294, needsReview: 6 });
    const queue = await read(sup, `counts/review?sessionId=${sid}&filter=needs_review&limit=50`);
    expect(queue.body.lines).toHaveLength(6);
    expect(queue.body.summary.total).toBe(300);
    const ids = queue.body.lines.map((/** @type {any} */ l) => l.id);
    // Per line: accept five with reasons, leave the over one out.
    const overLine = queue.body.lines.find((/** @type {any} */ l) => l.productId === ps[135].id);
    for (const l of queue.body.lines)
      if (l.id === overLine.id)
        expect((await command(sup, "counts/review", { sessionId: sid, lineId: l.id, decision: "rejected", note: "Belongs to the next pallet" })).status).toBe(200);
      else
        expect((await command(sup, "counts/review", { sessionId: sid, lineId: l.id, decision: "accepted", reasonCode: "SHORT-PICK" })).status).toBe(200);
    void ids;
    const done = await command(sup, "counts/approve", { sessionId: sid });
    expect(done.status).toBe(200);
    expect(done.body.posted).toBe(135);
    // ONE adjustment document; the writer's 100-line limit means two movements inside the same transaction.
    expect(await h.db`select id from inventory_adjustments where source_count_id=${sid}`).toHaveLength(1);
    const [session] = await h.db`select status,movement_ids from stock_count_sessions where id=${sid}`;
    expect(session.status).toBe("posted");
    expect(session.movement_ids).toHaveLength(2);
    expect(await h.db`select l.id from inventory_adjustment_lines l join inventory_adjustments a on a.id=l.adjustment_id where a.source_count_id=${sid}`).toHaveLength(135);
    expect(await balance(loc, ps[0])).toBe(9);
    expect(await balance(loc, ps[131])).toBe(5);
    expect(await balance(loc, ps[135])).toBe(10); // rejected line left alone
    expect(await balance(loc, ps[200])).toBe(10);
  }, 120000);
});

describe("rules that stay", () => {
  it("the counter cannot approve and a different approver can; the starter may count their own count", async () => {
    const loc = await location(`Starter-${crypto.randomUUID()}`);
    const p = await product();
    await stockIn(loc, [{ p, qty: 10 }]);
    const plan = await command(planner, "counts/plan", { locationId: loc }); // planner counts it too
    const sid = plan.body.id;
    const ls = (await lines(planner, sid)).lines;
    expect((await command(planner, "counts/save-lines", { sessionId: sid, lines: [{ lineId: ls[0].id, countedBase: 9 }] })).status).toBe(200);
    expect((await command(planner, "counts/submit", { sessionId: sid })).status).toBe(200);
    const self = await command(planner, "counts/approve", { sessionId: sid });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe("self_approval");
    expect((await command(sup, "counts/approve", { sessionId: sid })).status).toBe(200);
    // Counted by two people (a second phone helped): neither may approve.
    const plan2 = await command(planner, "counts/plan", { locationId: loc, blindCount: false });
    const ls2 = (await lines(planner, plan2.body.id)).lines;
    await command(planner, "counts/save-lines", { sessionId: plan2.body.id, lines: [{ lineId: ls2[0].id, countedBase: 9 }] });
    expect((await command(planner, "counts/cancel", { sessionId: plan2.body.id })).status).toBe(200);
    expect((await command(planner, "counts/cancel", { sessionId: plan2.body.id })).status).toBe(409);
  });

  it("the old calling convention used by the store till still works end to end", async () => {
    const loc = await location(`Legacy-${crypto.randomUUID()}`);
    const [a, b] = [await product(), await product()];
    await stockIn(loc, [{ p: a, qty: 10 }, { p: b, qty: 10 }]);
    const [location_] = await h.db`select * from inventory_locations where id=${loc}`;
    const counter = await person("manager");
    const approver = sup;
    const ctxFor = (/** @type {any} */ db, /** @type {any} */ actor) => ({ db, actor, now: Date.now() });
    const session = await tx(h.db, async (db) => {
      const started = await commands["counts/start"].run(ctxFor(db, counter), { countType: "full", blindCount: true, idempotencyKey: "k1" }, location_);
      const [s] = await db`select * from stock_count_sessions where id=${started.id}`;
      const rows = await db`select * from stock_count_lines where session_id=${s.id}`;
      expect(s.legacy_whole).toBe(true);
      // Stock moves while the till is counting: the old engine would have thrown the count out.
      await stockOut(loc, a, 1, Date.now());
      await commands["counts/submit"].run(
        ctxFor(db, counter),
        { lines: rows.map((/** @type {any} */ r) => ({ lineId: r.id, countedBase: 9 })), idempotencyKey: "k2" },
        s,
      );
      return s;
    }).catch((e) => {
      throw e;
    });
    void session;
    // The legacy path takes the rest without per-line review (the old single decision), counter != approver.
    const [s] = await h.db`select * from stock_count_sessions where location_id=${loc}`;
    expect(s.status).toBe("submitted");
    const ok = await command(approver, "counts/approve", { sessionId: s.id });
    expect(ok.status).toBe(200);
    expect(await balance(loc, b)).toBe(9);
    // a left the shelf (-1) BEFORE it was counted 9: nothing to correct. The old engine would have refused the whole count.
    expect(await balance(loc, a)).toBe(9);
  });
});

describe("IP-INT2 ask 7: a 150-line count is posted in batches of 100 and reversed in full", () => {
  it("approve posts two movements; adjustments/reverse reverses both and puts every shelf back", async () => {
    const loc = await location(`Rev-${crypto.randomUUID()}`);
    /** @type {any[]} */ const ps = [];
    for (let i = 0; i < 150; i++) ps.push(await product());
    for (let i = 0; i < 150; i += 100)
      await stockIn(loc, ps.slice(i, i + 100).map((p) => ({ p, qty: 10, cost: 100 })));
    const plan = await command(planner, "counts/plan", { locationId: loc, assignedTo: clerk.userId, blindCount: true });
    expect(plan.body.lines).toBe(150);
    const sid = plan.body.id;
    const ls = (await lines(clerk, sid, "limit=200")).lines;
    expect(ls).toHaveLength(150);
    const save = await command(clerk, "counts/save-lines", { sessionId: sid, lines: ls.map((/** @type {any} */ l) => ({ lineId: l.id, countedBase: 9 })) });
    expect(save.status).toBe(200);
    expect((await command(clerk, "counts/submit", { sessionId: sid })).status).toBe(200);
    const done = await command(sup, "counts/approve", { sessionId: sid });
    expect(done.status).toBe(200);
    expect(done.body.posted).toBe(150);
    const [session] = await h.db`select movement_ids from stock_count_sessions where id=${sid}`;
    expect(session.movement_ids).toHaveLength(2);
    expect(await balance(loc, ps[0])).toBe(9);
    expect(await balance(loc, ps[149])).toBe(9);
    // reversal: both batches come back, not just the first
    const rev = await command(sup, "adjustments/reverse", { adjustmentId: done.body.adjustmentId, reason: "Counted the wrong aisle" });
    expect(rev.status).toBe(200);
    expect(rev.body.movementIds).toHaveLength(2);
    for (const i of [0, 99, 100, 149]) expect(await balance(loc, ps[i])).toBe(10);
    const moved = await h.db`select id,status from inventory_movements where id in ${h.db(session.movement_ids)}`;
    expect(moved.every((/** @type {any} */ m) => m.status === "reversed")).toBe(true);
    expect((await h.db`select status from inventory_adjustments where id=${done.body.adjustmentId}`)[0].status).toBe("reversed");
    // and it cannot be reversed twice
    const again = await command(sup, "adjustments/reverse", { adjustmentId: done.body.adjustmentId, reason: "Again" });
    expect(again.status).toBeGreaterThanOrEqual(400);
  }, 120000);
});

describe("IP-INT2 ask 2: a store cashier's till count can be approved", () => {
  it("a sales-role counter (no stock band, no count capability) is approved by someone with a stock band; the counter and an approver above their limit are refused", async () => {
    const loc = await location(`Till-${crypto.randomUUID()}`);
    const [a, b] = [await product(), await product()];
    await stockIn(loc, [{ p: a, qty: 10, cost: 100 }, { p: b, qty: 10, cost: 100 }]);
    const [location_] = await h.db`select * from inventory_locations where id=${loc}`;
    const cashier = await person("sales");
    const ctxFor = (/** @type {any} */ db, /** @type {any} */ actor) => ({ db, actor, now: Date.now() });
    await tx(h.db, async (db) => {
      const started = await commands["counts/start"].run(ctxFor(db, cashier), { countType: "full", blindCount: true, idempotencyKey: "till-1" }, location_);
      const [s] = await db`select * from stock_count_sessions where id=${started.id}`;
      const rows = await db`select * from stock_count_lines where session_id=${s.id}`;
      await commands["counts/submit"].run(
        ctxFor(db, cashier),
        { lines: rows.map((/** @type {any} */ r) => ({ lineId: r.id, countedBase: 8 })), idempotencyKey: "till-2" },
        s,
      );
    });
    const [s] = await h.db`select * from stock_count_sessions where location_id=${loc}`;
    expect(s.status).toBe("submitted");
    // the cashier cannot approve their own count (and cannot even reach the command)
    expect((await command(cashier, "counts/approve", { sessionId: s.id })).status).toBe(403);
    // a manager (adjustment capability, but a band of P0) is told, in plain words, to ask someone with a higher limit
    const low = await command(planner, "counts/approve", { sessionId: s.id });
    expect(low.status).toBe(409);
    expect(low.body.error.message).toContain("more than you may approve");
    expect(await balance(loc, a)).toBe(10);
    // an admin (band P1,000) approves it: 4 pieces at P1.00 = P4.00
    const ok = await command(admin, "counts/approve", { sessionId: s.id });
    expect(ok.status).toBe(200);
    expect(ok.body.posted).toBe(2);
    expect(await balance(loc, a)).toBe(8);
    expect(await balance(loc, b)).toBe(8);
    const [done] = await h.db`select status from stock_count_sessions where id=${s.id}`;
    expect(done.status).toBe("posted");
  });
});

describe("IP-INT2 ask 4: count-finding photos", () => {
  it("only a count-finding photo can be attached to a finding; only the counter may claim one for their open count", async () => {
    const loc = await location(`Photo-${crypto.randomUUID()}`);
    const p = await product();
    await stockIn(loc, [{ p, qty: 5 }]);
    const plan = await command(planner, "counts/plan", { locationId: loc, assignedTo: clerk.userId, blindCount: true });
    const sid = plan.body.id;
    const [line] = (await lines(clerk, sid)).lines;
    const [other] = await h.db`insert into files (owner_id,purpose,sha256,mime,size,status,created_by) values (null,'truck-damage',${crypto.randomUUID().replaceAll("-", "").repeat(2)},'image/jpeg',10,'stored',${clerk.userId}) returning id`;
    const wrong = await command(clerk, "counts/save-lines", { sessionId: sid, lines: [{ lineId: line.id, countedBase: 4, finding: "damaged", photoFileId: other.id }] });
    expect(wrong.status).toBe(422);
    const claim = (/** @type {any} */ who, /** @type {any} */ owner) => canClaimInventoryMedia(h.db, who, { purpose: "count-finding", ownerId: owner, deviceId: crypto.randomUUID() });
    expect(await claim(clerk, sid)).toBe(true);
    expect(await claim(clerk2, sid)).toBe(false);
    expect(await claim(clerk, null)).toBe(false);
    expect(await canClaimInventoryMedia(h.db, sup, { purpose: "disposition-photo", ownerId: null, deviceId: crypto.randomUUID() })).toBe(false); // an approver may not raise bad orders
    expect(await canClaimInventoryMedia(h.db, planner, { purpose: "disposition-photo", ownerId: null, deviceId: crypto.randomUUID() })).toBe(true);
  });
});

describe("schedules", () => {
  it("plans a due schedule once, skips while the last count is open, and moves the next date", async () => {
    const loc = await location(`Sched-${crypto.randomUUID()}`);
    const p = await product();
    await stockIn(loc, [{ p, qty: 5 }]);
    const saved = await command(planner, "counts/schedule-save", { name: "Fast movers weekly", locationId: loc, scope: { fastMovers: { days: 30, top: 10 } }, cadenceDays: 7, assignedTo: clerk.userId });
    expect(saved.status).toBe(200);
    await stockOut(loc, p, 1, Date.now() - MIN);
    const now = Date.now();
    const first = await planDueCounts(h.db, now);
    expect(first.planned).toHaveLength(1);
    const [s] = await h.db`select * from stock_count_sessions where id=${first.planned[0]}`;
    expect(s).toMatchObject({ status: "planned", title: "Fast movers weekly", created_by: clerk.userId });
    const again = await planDueCounts(h.db, now);
    expect(again.planned).toHaveLength(0);
    const [sch] = await h.db`select next_due from stock_count_schedules where id=${saved.body.id}`;
    expect(new Date(sch.next_due).getTime()).toBeGreaterThan(now);
    const list = await read(planner, "counts/schedules");
    expect(list.body[0]).toMatchObject({ name: "Fast movers weekly", cadenceDays: 7 });
    expect(list.body[0].scope).toContain("Fast movers");
  });
});

describe("pickers for the plan and found-item screens", () => {
  it("lists who can count at a place and finds products by code or name", async () => {
    const loc = await location(`Pick-${crypto.randomUUID()}`);
    const p = await product();
    const counters = await read(planner, `counts/counters?locationId=${loc}`);
    expect(counters.status).toBe(200);
    const ids = counters.body.map((/** @type {any} */ c) => c.userId);
    expect(ids).toContain(clerk.userId);
    expect(ids).not.toContain(sup.userId); // an approver cannot count
    const found = await read(clerk, `counts/find-products?q=${encodeURIComponent(p.code)}`);
    expect(found.body.map((/** @type {any} */ r) => r.id)).toContain(p.id);
    expect(found.body[0]).toMatchObject({ basePerCase: 48, basePerPiece: 1, tracking: "none" });
    expect((await read(clerk, "counts/find-products?q=a")).body).toEqual([]);
    // A viewer cannot plan or preview.
    const viewer = await person("viewer");
    expect((await read(viewer, `counts/preview?locationId=${loc}`)).status).toBe(403);
  });
});

describe("WEB-078: the web sends the request key as the idempotency-key header", () => {
  it("Add count saves with the header key alone, and a resend replays the same plan", async () => {
    const loc = await location(`Header-${crypto.randomUUID()}`);
    await stockIn(loc, [{ p: await product(), qty: 5 }]);
    const key = crypto.randomUUID();
    const send = async () => {
      const res = await h.fetch("/api/v1/inventory/counts/plan", {
        method: "POST",
        headers: {
          cookie: planner.cookie,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify({ locationId: loc, blindCount: true }),
      });
      return {
        status: res.status,
        body: /** @type {any} */ (await res.json()),
      };
    };
    const first = await send();
    expect(first.body.error?.message ?? null).toBe(null);
    expect(first.status).toBe(200);
    expect(first.body.number).toMatch(/^CNT-/);
    const again = await send();
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
  });
});
