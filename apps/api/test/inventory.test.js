import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { tx } from "@sunpride/db/client";
import { startHarness, profileStore } from "./harness.js";
import { sha256Hex } from "../src/core/util.js";
import { capabilitiesFor } from "../src/core/capabilities.js";

// Other lanes are absent. Only these named boundaries are mocked; all inventory,
// authentication cookies, transactions, constraints, jobs and HTTP handlers are real.
mock.module("../src/domains/org/audit.js", () => ({
  writeAudit: async (/** @type {any} */ t, /** @type {any} */ e) => {
    await t`insert into audit_logs (subject,action,entity_type,entity_id,details) values (${e.subject},${e.action},${e.entityType},${e.entityId},${e.details ?? null})`;
  },
}));
const unpriced = new Set();
mock.module("../src/domains/orders/pricing.js", () => ({
  resolvePrice: async (/** @type {any} */ _db, /** @type {any} */ q) => ({
    unitPriceCentavos: unpriced.has(q.productId) ? null : 1250,
    priceListId: null,
    source: "test default price",
  }),
  creditCheck: async () => ({ status: "unknown", limit: null, exposure: null }),
}));
const refreshes = /** @type {any[]} */ ([]);
mock.module("../src/domains/analytics/refresh.js", () => ({
  enqueueRefresh: async (/** @type {any} */ _ctx, /** @type {any} */ input) => {
    refreshes.push(input);
  },
}));
const { install } = await import("../src/domains/inventory/index.js");
const { postMovement } = await import("../src/domains/inventory/posting.js");
const { expireLots } = await import("../src/domains/inventory/jobs.js");
const { quantity } = await import("../src/domains/inventory/units.js");
/** @type {import('./harness.js').Harness} */ let h;
/** @type {ReturnType<typeof profileStore>} */ let profiles;
/** @type {any} */ let admin;
/** @type {any} */ let approver;
/** @type {any} */ let manager;
/** @type {any} */ let viewer;
/** @type {string} */ let unit;
/** @type {string} */ let foreignUnit;
/** @type {string} */ let pc;
/** @type {string} */ let cs;
/** @type {string} */ let depot;
/** @type {string} */ let truck;
/** @type {string} */ let transit;
/** @type {string} */ let foreign;
/** @param {string} role @param {string} [orgUnitId] */
async function person(role, orgUnitId = unit) {
  const [u] =
    await h.db`insert into users (email,password_hash) values (${`${crypto.randomUUID()}@test.invalid`},'fixture-not-a-login') returning id`;
  const profile = profiles.set(u.id, { role, orgUnitId });
  const token = `sps_${crypto.randomUUID().replaceAll("-", "")}`;
  await h.db`insert into sessions (user_id,token_hash,app,expires_at) values (${u.id},${sha256Hex(token)},'web',now()+interval '1 day')`;
  return {
    userId: u.id,
    profileId: profile.id,
    role,
    orgUnitId,
    capabilities: new Set(capabilitiesFor(role)),
    cookie: `sp_session=${token}`,
  };
}
/** @param {string} name @param {string} type @param {string} [orgUnit] */
async function location(name, type, orgUnit = unit) {
  const [r] =
    await h.db`insert into inventory_locations (organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values ('sunpride',${orgUnit},'TEST',${name},${name},${type},true,true,true,true,false) returning id`;
  return r.id;
}
/** @param {{tracked?:boolean,quality?:boolean,scale?:number}} [opts] */
async function product(opts = {}) {
  const [p] =
    await h.db`insert into products (code,name,category,uom,unit_price,active,organization_id,base_uom_id,quantity_scale,tracking_mode,allocation_policy) values (${`P-${crypto.randomUUID()}`},'Test corned beef','Canned','PC',0,true,'sunpride',${pc},${opts.scale ?? 1},${opts.tracked ? "lot" : "none"},'fefo') returning *`;
  await h.db`insert into uom_conversions (organization_id,product_id,from_uom_id,to_uom_id,numerator,denominator,rounding_mode,effective_from,active) values ('sunpride',${p.id},${cs},${pc},48,1,'exact',now()-interval '1 year',true)`;
  if (opts.tracked)
    await h.db`insert into product_inventory_policies (organization_id,product_id,base_uom_id,quantity_scale,quantity_precision,tracking_mode,allocation_policy,allow_mixed_lots_per_line,allow_negative_stock,quality_release_required,expiry_date_required,manufacture_date_required,minimum_remaining_shelf_life_days,costing_method,version,active) values ('sunpride',${p.id},${pc},1,0,'lot','fefo',true,false,${opts.quality ?? false},true,false,0,'weighted_average',1,true)`;
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
/** @param {any} p @param {number} qty @param {string|null} [from] @param {string|null} [to] @param {any} [extra] */
function input(p, qty, from = null, to = depot, extra = {}) {
  return {
    kind: from ? "inventory_issue" : "goods_receipt",
    sourceType: "test",
    sourceId: p.id,
    idempotencyKey: crypto.randomUUID(),
    occurredAt: Date.now(),
    actor: admin,
    organizationId: "sunpride",
    lines: [
      {
        productId: p.id,
        fromLocationId: from,
        toLocationId: to,
        quantityBase: qty,
        uom: "PC",
      },
    ],
    ...extra,
  };
}
/** @param {any} data */
const movement = (data) => tx(h.db, (t) => postMovement(t, data));
/** @param {any} p @param {number} qty @param {any} [extra] */
const receipt = (p, qty, extra = {}) =>
  command(admin, "receipts/post", {
    receivingLocationId: depot,
    lines: [{ productId: p.id, quantityBase: qty, ...extra }],
  });

beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  profiles = profileStore(h);
  const [u] =
    await h.db`insert into org_units (organization_id,code,name,type_code,status,effective_from) values ('sunpride','INV-ROOT','Inventory test','national','active',now()) returning id`;
  unit = u.id;
  const [f] =
    await h.db`insert into org_units (organization_id,code,name,type_code,status,effective_from) values ('sunpride','INV-FOREIGN','Other region','region','active',now()) returning id`;
  foreignUnit = f.id;
  h.setHooks({ rootUnitId: async () => unit });
  [admin, approver, manager, viewer] = await Promise.all([
    person("admin"),
    person("approver"),
    person("manager"),
    person("viewer"),
  ]);
  const [piece] =
    await h.db`insert into units_of_measure (organization_id,code,name,dimension,decimal_places,active) values ('sunpride','PC','Piece','count',0,true) returning id`;
  pc = piece.id;
  const [caseUom] =
    await h.db`insert into units_of_measure (organization_id,code,name,dimension,decimal_places,active) values ('sunpride','CS','Case','count',0,true) returning id`;
  cs = caseUom.id;
  depot = await location("Main depot", "warehouse");
  truck = await location("Truck one", "truck");
  transit = await location("Goods on the road", "in_transit");
  foreign = await location("Foreign depot", "warehouse", foreignUnit);
}, 30000);
afterAll(async () => {
  await h?.close();
});

describe("single transactional posting authority", () => {
  it("replays the exact key once, conflicts on changed content and writes command/movement/ledger/audit/outbox together", async () => {
    const p = await product(),
      data = input(p, 1920);
    const first = await movement(data),
      again = await movement(data);
    expect(first.duplicate).toBe(false);
    expect(again).toEqual({ ...first, duplicate: true });
    await expect(
      movement({ ...data, lines: [{ ...data.lines[0], quantityBase: 1921 }] }),
    ).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    const [counts] =
      await h.db`select (select count(*) from inventory_movements where id=${first.movementId}) as movements,(select count(*) from inventory_commands where movement_id=${first.movementId}) as commands,(select count(*) from inventory_ledger_entries where movement_id=${first.movementId}) as ledger,(select count(*) from integration_events where movement_id=${first.movementId}) as outbox,(select count(*) from audit_logs where entity_id=${first.movementId}) as audit`;
    expect(Object.values(counts).map(Number)).toEqual([1, 1, 1, 1, 1]);
  });
  it("refuses negative stock and rolls back every attempted write", async () => {
    const p = await product(),
      data = input(p, 2, depot, null);
    await expect(movement(data)).rejects.toMatchObject({
      code: "negative_stock",
      status: 422,
    });
    const [r] =
      await h.db`select count(*) as n from inventory_commands where idempotency_key=${data.idempotencyKey}`;
    expect(Number(r.n)).toBe(0);
    const rows =
      await h.db`select * from inventory_balances where product_id=${p.id}`;
    expect(rows).toHaveLength(0);
  });
  it("serializes concurrent duplicate posting and competing issues", async () => {
    const p = await product(),
      data = input(p, 10);
    const r = await Promise.all([movement(data), movement(data)]);
    expect(r.map((x) => x.duplicate).sort()).toEqual([false, true]);
    const issues = await Promise.allSettled([
      movement(input(p, 7, depot, null)),
      movement(input(p, 7, depot, null)),
    ]);
    expect(issues.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const [b] =
      await h.db`select physical_base from inventory_balances where product_id=${p.id} and location_id=${depot}`;
    expect(Number(b.physical_base)).toBe(3);
  });
  it("reauthorizes scope before an idempotent duplicate return", async () => {
    const p = await product(),
      who = await person("operations"),
      data = input(p, 10, null, depot, { actor: who });
    await movement(data);
    profiles.set(who.userId, { role: "operations", orgUnitId: foreignUnit });
    await expect(movement(data)).rejects.toMatchObject({
      code: "out_of_scope",
    });
  });
  it("lot-tracked van damage: an in-place available → damaged change allocates and keeps the lot; two lines via outside cannot", async () => {
    const p = await product({ tracked: true });
    await receipt(p, 10, {
      lotNumber: "VAN-DMG",
      expiresAt: Date.now() + 60 * 86400000,
    });
    const line = {
      productId: p.id,
      fromLocationId: depot,
      toLocationId: depot,
      quantityBase: 2,
      uom: "PC",
    };
    // The old van shape: the inward "damaged" line has no source, so no lot can be chosen.
    await expect(
      movement({
        ...input(p, 2),
        kind: "status_change",
        lines: [
          { ...line, toLocationId: null, stockStatus: "available" },
          { ...line, fromLocationId: null, stockStatus: "damaged" },
        ],
      }),
    ).rejects.toThrow("Select a lot for this movement");
    const done = await movement({
      ...input(p, 2),
      kind: "status_change",
      lines: [
        { ...line, fromStockStatus: "available", toStockStatus: "damaged" },
      ],
    });
    expect(done.duplicate).toBe(false);
    const rows =
      await h.db`select l.lot_number,b.stock_status,b.physical_base from inventory_lot_balances b join inventory_lots l on l.id=b.lot_id where b.product_id=${p.id} order by b.stock_status`;
    expect(
      rows.map((/** @type {any} */ r) => [
        r.lot_number,
        r.stock_status,
        Number(r.physical_base),
      ]),
    ).toEqual([
      ["VAN-DMG", "available", 8],
      ["VAN-DMG", "damaged", 2],
    ]);
  });
  it("a domain-vouched location skips only the actor's own scope gate (van seller loading from an area depot)", async () => {
    const p = await product(),
      seller = await person("sales"),
      root = await person("super_admin");
    await movement(input(p, 10, null, foreign, { actor: root }));
    const load = input(p, 4, foreign, truck, { actor: seller });
    await expect(movement(load)).rejects.toMatchObject({
      code: "out_of_scope",
    });
    const posted = await movement({
      ...load,
      idempotencyKey: crypto.randomUUID(),
      authorizedLocations: [foreign, truck],
    });
    expect(posted.duplicate).toBe(false);
    const [b] =
      await h.db`select physical_base from inventory_balances where product_id=${p.id} and location_id=${foreign}`;
    expect(Number(b.physical_base)).toBe(6);
    // Vouching for the truck alone still gates the foreign depot line.
    await expect(
      movement({
        ...input(p, 1, foreign, truck, { actor: seller }),
        authorizedLocations: [truck],
      }),
    ).rejects.toMatchObject({ code: "out_of_scope" });
    await expect(
      movement({
        ...input(p, 1, foreign, truck, { actor: seller }),
        authorizedLocations: ["not-a-uuid"],
      }),
    ).rejects.toThrow("Location must be a UUID");
  });
  it("ledger sums equal each balance quantity, reserved amount and value across 25 randomized sequences", async () => {
    let seed = 0x713913;
    const rand = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    for (let run = 0; run < 25; run++) {
      const p = await product({ scale: run % 2 ? 1000 : 1 });
      const first = input(p, 10000, null, depot);
      first.lines[0].unitCostMinor = 1234;
      const second = input(p, 10000, null, truck);
      second.lines[0].unitCostMinor = 1285;
      await movement(first);
      await movement(second);
      for (let step = 0; step < 20; step++) {
        const qty = 1 + (rand() % 48),
          from = rand() % 2 ? depot : truck,
          kind = rand() % 4;
        if (kind === 0) {
          const receive = input(p, qty, null, from);
          receive.lines[0].unitCostMinor = 100 + (rand() % 2000);
          await movement(receive);
        } else if (kind === 1) await movement(input(p, qty, from, null));
        else if (kind === 2)
          await movement(
            input(p, qty, from, from === depot ? truck : depot, {
              kind: "transfer_ship",
            }),
          );
        else {
          await movement(input(p, qty, from, null, { kind: "reservation" }));
          await movement(
            input(p, qty, from, null, { kind: "reservation_release" }),
          );
        }
      }
      const rows =
        await h.db`select b.location_id,b.physical_base,b.reserved_base,b.inventory_value_minor,coalesce(sum(e.quantity_delta_base),0) as quantity,coalesce(sum(e.reserved_delta_base),0) as reserved,coalesce(sum(e.value_delta_minor),0) as value from inventory_balances b left join inventory_ledger_entries e on e.product_id=b.product_id and e.location_id=b.location_id and e.organization_id=b.organization_id where b.product_id=${p.id} group by b.id`;
      for (const b of rows) {
        expect(BigInt(b.quantity)).toBe(BigInt(b.physical_base));
        expect(BigInt(b.reserved)).toBe(BigInt(b.reserved_base));
        expect(BigInt(b.value)).toBe(BigInt(b.inventory_value_minor));
      }
    }
  }, 120000);
  it("allows only explicit bounded distributor negatives and requires another person to settle after coverage", async () => {
    const p = await product();
    const allow = await command(admin, "negative/allow", {
      locationId: truck,
      active: true,
      movementTypes: ["inventory_issue"],
      limitBase: 5,
      sourceRef: "CALL-10 test",
    });
    expect(allow.status).toBe(200);
    await movement(input(p, 5, truck, null));
    await expect(movement(input(p, 1, truck, null))).rejects.toMatchObject({
      code: "negative_stock_limit",
    });
    const flags = await read(manager, "negative");
    const flag = flags.body.flags.items.find(
      (/** @type {any} */ f) => f.code === p.code,
    );
    expect(flag.current.base).toBe(-5);
    expect(
      (
        await command(admin, "negative/resolve", {
          flagId: flag.id,
          note: "Covered",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await command(manager, "negative/resolve", {
          flagId: flag.id,
          note: "Covered",
        })
      ).status,
    ).toBe(422);
    await movement(input(p, 5, null, truck));
    expect(
      (
        await command(manager, "negative/resolve", {
          flagId: flag.id,
          note: "Covered by receipt",
        })
      ).status,
    ).toBe(200);
  });
});

describe("receipts, transfers, reservations and quality", () => {
  it("posts receipt once with the same document IDs and values 1920 pieces as 40 cases", async () => {
    const p = await product(),
      key = crypto.randomUUID(),
      body = {
        idempotencyKey: key,
        receivingLocationId: depot,
        lines: [{ productId: p.id, quantityBase: 1920 }],
      };
    const a = await command(admin, "receipts/post", body),
      b = await command(admin, "receipts/post", body);
    expect(a.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.duplicate).toBe(true);
    const overview = await read(admin, `overview?locationId=${depot}`);
    expect(overview.status).toBe(200);
    const row = overview.body.rows.find(
      (/** @type {any} */ r) => r.productId === p.id,
    );
    expect(row.onHand).toMatchObject({
      base: 1920,
      cases: 40,
      pieces: 0,
      display: "40 cs",
      valueCentavos: 2400000,
    });
    expect(row.daysCover).toBeNull();
    expect(refreshes.some((r) => r.kind === "stock")).toBe(true);
  });
  it("keeps all three transfer locations scoped and enforces request/approve/ship/receive with exact lot continuity", async () => {
    const p = await product({ tracked: true }),
      expiry = Date.now() + 60 * 86400000;
    expect(
      (await receipt(p, 96, { lotNumber: "LOT-TR", expiresAt: expiry })).status,
    ).toBe(200);
    const request = {
      sourceLocationId: depot,
      destinationLocationId: truck,
      inTransitLocationId: transit,
      lines: [{ productId: p.id, quantityBase: 48 }],
    };
    expect(
      (
        await command(admin, "transfers/request", {
          ...request,
          destinationLocationId: foreign,
        })
      ).status,
    ).toBe(403);
    const a = await command(admin, "transfers/request", request);
    expect(a.status).toBe(200);
    expect(
      (await command(admin, "transfers/approve", { transferId: a.body.id }))
        .status,
    ).toBe(403);
    expect(
      (await command(approver, "transfers/approve", { transferId: a.body.id }))
        .status,
    ).toBe(200);
    expect(
      (await command(admin, "transfers/receive", { transferId: a.body.id }))
        .status,
    ).toBe(409);
    expect(
      (await command(admin, "transfers/ship", { transferId: a.body.id }))
        .status,
    ).toBe(200);
    expect(
      (await command(admin, "transfers/receive", { transferId: a.body.id }))
        .status,
    ).toBe(200);
    const lots =
      await h.db`select location_id,physical_base,lot_id from inventory_lot_balances where product_id=${p.id} and physical_base>0`;
    expect(lots).toHaveLength(2);
    expect(new Set(lots.map((/** @type {any} */ l) => l.lot_id)).size).toBe(1);
  });
  it("hard reservations hold availability, prevent double spending, consume/release through the single ledger", async () => {
    const p = await product();
    await receipt(p, 20);
    const r = await command(admin, "reservations/create", {
      sourceDocumentId: "TEST-ORDER",
      lines: [{ productId: p.id, locationId: depot, quantityBase: 12 }],
    });
    expect(r.status).toBe(200);
    await expect(movement(input(p, 9, depot, null))).rejects.toMatchObject({
      code: "negative_stock",
    });
    const consume = await command(admin, "reservations/consume", {
      reservationId: r.body.id,
    });
    expect(consume.status).toBe(200);
    const r2 = await command(admin, "reservations/create", {
      sourceDocumentId: "TEST-ORDER-2",
      lines: [{ productId: p.id, locationId: depot, quantityBase: 8 }],
    });
    expect(r2.status).toBe(200);
    expect(
      (
        await command(admin, "reservations/release", {
          reservationId: r2.body.id,
        })
      ).status,
    ).toBe(200);
    const [b] =
      await h.db`select physical_base,reserved_base,available_base from inventory_balances where product_id=${p.id} and location_id=${depot}`;
    expect(Object.values(b).map(Number)).toEqual([8, 0, 8]);
  });
  it("quality release needs inventory.approve and expired lots cannot sell even before the daily job", async () => {
    const p = await product({ tracked: true, quality: true });
    const expiresAt = Date.now() + 86400000;
    await receipt(p, 48, { lotNumber: "QUALITY", expiresAt });
    const [lot] =
      await h.db`select * from inventory_lots where product_id=${p.id}`;
    const body = {
      lotId: lot.id,
      locationId: depot,
      fromStatus: "quality_hold",
      toStatus: "available",
      quantityBase: 48,
      reasonCode: "inspected",
    };
    expect((await command(admin, "quality/change", body)).status).toBe(403);
    expect((await command(approver, "quality/change", body)).status).toBe(200);
    await h.db`update inventory_lots set expires_at=now()-interval '1 second' where id=${lot.id}`;
    await expect(movement(input(p, 1, depot, null))).rejects.toMatchObject({
      code: "negative_stock",
    });
    const job = await expireLots(h.db);
    expect(job.processed).toBeGreaterThan(0);
    const [b] =
      await h.db`select physical_base,available_stock_base,expired_base from inventory_balances where product_id=${p.id} and location_id=${depot}`;
    expect(Object.values(b).map(Number)).toEqual([48, 0, 48]);
    expect((await expireLots(h.db)).processed).toBe(0);
    expect(
      h.app.scheduler.tasks.some((t) => t.name === "inventory.expire-lots"),
    ).toBe(true);
  });
  it("movement traces and document lists never reveal foreign stock locations", async () => {
    const p = await product(),
      root = await person("super_admin"),
      data = input(p, 5, null, foreign, { actor: root });
    const posted = await movement(data);
    expect(
      (await read(admin, `trace?movementId=${posted.movementId}`)).status,
    ).toBe(404);
    expect(
      (await read(root, `trace?movementId=${posted.movementId}`)).status,
    ).toBe(200);
    expect(
      (await read(viewer, "locations")).body.some(
        (/** @type {any} */ l) => l.id === foreign,
      ),
    ).toBe(false);
  });
});

describe("blind counts and adjustment separation", () => {
  it("hides expected/variance from counter and viewer; a different approver can see and post", async () => {
    const p = await product();
    await receipt(p, 10);
    const a = await command(manager, "counts/start", {
      locationId: truck,
      blindCount: true,
    });
    // Truck already has other stock; use a dedicated location for a single-line proof.
    const loc = await location(`Count-${crypto.randomUUID()}`, "bin");
    await movement(input(p, 10, null, loc));
    const started = await command(manager, "counts/start", {
      locationId: loc,
      blindCount: true,
    });
    expect(started.status).toBe(200);
    void a;
    const own = await read(
        manager,
        `counts/detail?sessionId=${started.body.id}`,
      ),
      v = await read(viewer, `counts/detail?sessionId=${started.body.id}`),
      review = await read(
        approver,
        `counts/detail?sessionId=${started.body.id}`,
      );
    expect(own.body.lines[0]).not.toHaveProperty("expected");
    expect(v.body.lines[0]).not.toHaveProperty("expected");
    expect(review.body.lines[0].expected.base).toBe(10);
    for (const path of [
      `overview?locationId=${loc}`,
      "movements",
      "lots",
      "negative",
    ])
      expect((await read(manager, path)).body.error.code).toBe(
        "blind_count_active",
      );
    const submit = await command(manager, "counts/submit", {
      sessionId: started.body.id,
      lines: [{ lineId: own.body.lines[0].id, countedBase: 8 }],
    });
    expect(submit.status).toBe(200);
    expect(
      (await command(manager, "counts/approve", { sessionId: started.body.id }))
        .status,
    ).toBe(403);
    expect(
      (
        await command(approver, "counts/approve", {
          sessionId: started.body.id,
        })
      ).status,
    ).toBe(200);
    const ownAfter = await read(
      manager,
      `counts/detail?sessionId=${started.body.id}`,
    );
    expect(ownAfter.body.lines[0]).not.toHaveProperty("variance");
  });
  it("rejects changed-and-restored stock by frozen version, not merely matching quantity", async () => {
    const p = await product(),
      loc = await location(`Stale-${crypto.randomUUID()}`, "bin");
    await movement(input(p, 10, null, loc));
    const start = await command(manager, "counts/start", { locationId: loc });
    const detail = await read(
      manager,
      `counts/detail?sessionId=${start.body.id}`,
    );
    await movement(input(p, 5, null, loc));
    await movement(input(p, 5, loc, null));
    const response = await command(manager, "counts/submit", {
      sessionId: start.body.id,
      lines: [{ lineId: detail.body.lines[0].id, countedBase: 10 }],
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("stale_snapshot");
    const [session] =
      await h.db`select status from stock_count_sessions where id=${start.body.id}`;
    expect(session.status).toBe("counting");
  });
  it("manual adjustments require inventory.approve, never the requester, even for super admin", async () => {
    const p = await product(),
      root = await person("super_admin");
    await receipt(p, 10);
    const r = await command(root, "adjustments/request", {
      reasonCode: "damage",
      lines: [{ productId: p.id, locationId: depot, varianceBase: -2 }],
    });
    expect(r.status).toBe(200);
    expect(
      (
        await command(root, "adjustments/decide", {
          adjustmentId: r.body.id,
          decision: "approved",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await command(manager, "adjustments/decide", {
          adjustmentId: r.body.id,
          decision: "approved",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await command(approver, "adjustments/decide", {
          adjustmentId: r.body.id,
          decision: "approved",
        })
      ).status,
    ).toBe(200);
  });
});

describe("inventory lifecycle counterexamples", () => {
  it("refuses approval after stock changed and was restored after submission, without creating an adjustment", async () => {
    const p = await product(),
      loc = await location(`Approval-stale-${crypto.randomUUID()}`, "bin");
    await movement(input(p, 10, null, loc));
    const start = await command(manager, "counts/start", { locationId: loc });
    const detail = await read(
      manager,
      `counts/detail?sessionId=${start.body.id}`,
    );
    expect(
      (
        await command(manager, "counts/submit", {
          sessionId: start.body.id,
          lines: [{ lineId: detail.body.lines[0].id, countedBase: 9 }],
        })
      ).status,
    ).toBe(200);
    await movement(input(p, 1, null, loc));
    await movement(input(p, 1, loc, null));
    const approved = await command(approver, "counts/approve", {
      sessionId: start.body.id,
    });
    expect(approved.status).toBe(409);
    expect(approved.body.error.code).toBe("stale_snapshot");
    const [count] =
      await h.db`select count(*) as n from inventory_adjustments where source_count_id=${start.body.id}`;
    expect(Number(count.n)).toBe(0);
  });
  it("posts and reverses receipts and adjustments atomically without losing exact lot identity", async () => {
    const p = await product({ tracked: true }),
      received = await receipt(p, 10, {
        lotNumber: "REVERSE-LOT",
        expiresAt: Date.now() + 90 * 86400000,
        unitCostMinor: 150,
      });
    expect(received.status).toBe(200);
    const reverseBody = {
      receiptId: received.body.id,
      reason: "Delivery returned",
      idempotencyKey: crypto.randomUUID(),
    };
    const reversed = await command(admin, "receipts/reverse", reverseBody);
    expect(reversed.status).toBe(200);
    expect(
      (await command(admin, "receipts/reverse", reverseBody)).body.movementId,
    ).toBe(reversed.body.movementId);
    const [b] =
      await h.db`select physical_base,inventory_value_minor from inventory_balances where product_id=${p.id} and location_id=${depot}`;
    expect(Object.values(b).map(Number)).toEqual([0, 0]);
    const simple = await product();
    await receipt(simple, 10);
    const request = await command(admin, "adjustments/request", {
      reasonCode: "damage",
      lines: [{ productId: simple.id, locationId: depot, varianceBase: -2 }],
    });
    await command(approver, "adjustments/decide", {
      adjustmentId: request.body.id,
      decision: "approved",
    });
    expect(
      (
        await command(approver, "adjustments/reverse", {
          adjustmentId: request.body.id,
          reason: "Inspection corrected",
        })
      ).status,
    ).toBe(200);
    const [after] =
      await h.db`select physical_base from inventory_balances where product_id=${simple.id} and location_id=${depot}`;
    expect(Number(after.physical_base)).toBe(10);
  });
  it("replenishment targets drive suggested quantities, cover excludes transfers, and prior stock comes from ledger", async () => {
    const p = await product(),
      loc = await location(`Cover-${crypto.randomUUID()}`, "bin");
    await movement(input(p, 480, null, loc));
    await movement(input(p, 28, loc, null));
    await movement(input(p, 48, loc, truck, { kind: "transfer_ship" }));
    expect(
      (
        await command(admin, "replenishment/save", {
          productId: p.id,
          locationId: loc,
          reorderPointBase: 480,
          targetLevelBase: 960,
          safetyStockBase: 48,
        })
      ).status,
    ).toBe(200);
    const response = await read(admin, `overview?locationId=${loc}`);
    const r = response.body.rows.find(
      (/** @type {any} */ row) => row.productId === p.id,
    );
    expect(r.issues28.base).toBe(28);
    expect(r.avgDailyIssueBase).toBe(1);
    expect(r.daysCover).toBe(404);
    expect(r.prior.base).toBe(0);
    expect(r.suggested.base).toBe(556);
    expect(r.status).toBe("low");
    const suggestions = await read(admin, `replenishment?locationId=${loc}`);
    expect(
      suggestions.body.find((/** @type {any} */ row) => row.productId === p.id)
        .suggested.base,
    ).toBe(556);
  });
  it("location setup is national-only, scoped and cannot retire or transfer ownership of stocked locations", async () => {
    const name = `Setup-${crypto.randomUUID()}`,
      body = { orgUnitId: unit, code: name, name, type: "bin" };
    expect((await command(manager, "locations/save", body)).status).toBe(403);
    const created = await command(admin, "locations/save", body);
    expect(created.status).toBe(200);
    const p = await product();
    await movement(input(p, 10, null, created.body.id));
    expect(
      (
        await command(admin, "locations/save", {
          ...body,
          id: created.body.id,
          active: false,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await command(admin, "locations/save", {
          ...body,
          id: created.body.id,
          orgUnitId: foreignUnit,
        })
      ).status,
    ).toBe(403);
  });
  it("opening stock rejects existing stock in a hold partition and keeps the cutover source", async () => {
    const p = await product(),
      loc = await location(`Opening-${crypto.randomUUID()}`, "bin");
    const opened = await command(admin, "opening/post", {
      sourceReference: "OPENING-TEST",
      lines: [{ productId: p.id, locationId: loc, quantityBase: 96 }],
    });
    expect(opened.status).toBe(200);
    const [m] =
      await h.db`select * from inventory_movements where id=${opened.body.receipts[0].movementId}`;
    expect(m.movement_type).toBe("opening_balance");
    expect(m.source_type).toBe("cutover");
    await movement(
      input(p, 96, loc, loc, {
        kind: "status_change",
        lines: [
          {
            productId: p.id,
            fromLocationId: loc,
            toLocationId: loc,
            quantityBase: 96,
            uom: "PC",
            fromStockStatus: "available",
            toStockStatus: "quality_hold",
          },
        ],
      }),
    );
    expect(
      (
        await command(admin, "opening/post", {
          sourceReference: "OTHER-FILE",
          lines: [{ productId: p.id, locationId: loc, quantityBase: 96 }],
        })
      ).body.error.code,
    ).toBe("duplicate_stock");
  });
  it("expires reserved lots in bounded batches and drains continuation without stranding the reserve", async () => {
    const p = await product({ tracked: true });
    for (let i = 0; i < 21; i++)
      expect(
        (
          await receipt(p, 1, {
            lotNumber: `EXP-${i}`,
            expiresAt: Date.now() + (i + 1) * 86400000,
          })
        ).status,
      ).toBe(200);
    const reserved = await command(admin, "reservations/create", {
      sourceDocumentId: "EXPIRY-ORDER",
      lines: [{ productId: p.id, locationId: depot, quantityBase: 1 }],
    });
    expect(reserved.status).toBe(200);
    await h.db`update inventory_lots set expires_at=now()-interval '1 second' where product_id=${p.id}`;
    const first = await expireLots(h.db);
    expect(first.processed).toBe(20);
    expect(first.more).toBe(true);
    await h.app.scheduler.drain();
    const [b] =
      await h.db`select available_stock_base,expired_base,reserved_base from inventory_balances where product_id=${p.id} and location_id=${depot}`;
    expect(Object.values(b).map(Number)).toEqual([0, 21, 0]);
    const [r] =
      await h.db`select status from inventory_reservations where id=${reserved.body.id}`;
    expect(r.status).toBe("expired");
  }, 30000);
});

describe("final stock read and valuation guards", () => {
  it("keeps default-price absence unknown in every aggregate, instead of valuing a partially priced stock pile", async () => {
    const p = await product(),
      loc = await location(`Unknown-price-${crypto.randomUUID()}`, "bin");
    unpriced.add(p.id);
    await movement(input(p, 48, null, loc));
    const result = await read(admin, `overview?locationId=${loc}`);
    expect(result.status).toBe(200);
    const row = result.body.rows.find(
      (/** @type {any} */ r) => r.productId === p.id,
    );
    expect(row.onHand.valueCentavos).toBeNull();
    expect(result.body.summary.valueCentavos).toBeNull();
    expect(result.body.locations[0].valueCentavos).toBeNull();
  });
  it("filters allowance requests to the exact requested authorized locations and returns resolved-flag history separately", async () => {
    const none = await read(admin, `negative?locationIds=${truck}`);
    expect(none.body.allowances).toHaveLength(1);
    expect(
      none.body.allowances.every(
        (/** @type {any} */ a) => a.locationId === truck,
      ),
    ).toBe(true);
    const out = await read(admin, `negative?locationIds=${foreign}`);
    expect(out.body.allowances).toEqual([]);
    const malformed = await read(admin, "negative?locationIds=NOT-A-UUID");
    expect(malformed.status).toBe(422);
    const history = await read(admin, "negative?status=resolved");
    expect(history.body.flags.items.length).toBeGreaterThan(0);
    expect(
      history.body.flags.items.every(
        (/** @type {any} */ f) => f.status === "resolved" && !f.canResolve,
      ),
    ).toBe(true);
  });
  it("accepts the full documented command-key length and refuses a reversal that would create negative book value", async () => {
    const p = await product(),
      key = "k".repeat(200);
    expect(
      (
        await command(admin, "receipts/post", {
          idempotencyKey: key,
          receivingLocationId: depot,
          lines: [{ productId: p.id, quantityBase: 1 }],
        })
      ).status,
    ).toBe(200);
    const expensive = await product();
    const first = input(expensive, 10);
    first.lines[0].unitCostMinor = 100;
    await movement(first);
    await movement(input(expensive, 9, depot, null));
    const cheap = input(expensive, 10);
    cheap.lines[0].unitCostMinor = 1;
    await movement(cheap);
    const reverse = input(expensive, 10, depot, null, { kind: "reversal" });
    reverse.lines[0].unitCostMinor = 100;
    await expect(movement(reverse)).rejects.toMatchObject({
      code: "negative_stock_value",
    });
  });
});

describe("unmapped location recovery", () => {
  it("keeps unmapped stock private but lets a national administrator assign its unit without changing stock", async () => {
    const name = `Unmapped-${crypto.randomUUID()}`,
      loc = await location(name, "bin"),
      p = await product();
    await movement(input(p, 10, null, loc));
    await h.db`update inventory_locations set org_unit_id=null where id=${loc}`;
    expect(
      (await read(viewer, "locations")).body.some(
        (/** @type {any} */ l) => l.id === loc,
      ),
    ).toBe(false);
    const mapped = await command(admin, "locations/save", {
      id: loc,
      orgUnitId: unit,
      code: name,
      name,
      type: "bin",
    });
    expect(mapped.status).toBe(200);
    expect(
      (await read(viewer, "locations")).body.some(
        (/** @type {any} */ l) => l.id === loc,
      ),
    ).toBe(true);
    const [balance] =
      await h.db`select physical_base from inventory_balances where product_id=${p.id} and location_id=${loc}`;
    expect(Number(balance.physical_base)).toBe(10);
  });
});

describe("catalog unit presentation", () => {
  it("does not call 1920 pieces 1920 cases", () => {
    expect(
      quantity(
        1920,
        { basePerCase: 48, basePerPiece: 1, baseCode: "PC" },
        1250,
      ),
    ).toMatchObject({ cases: 40, pieces: 0, display: "40 cs" });
  });
  it("shows mixed cases and pieces and preserves a zero", () => {
    expect(
      quantity(150, { basePerCase: 48, basePerPiece: 1, baseCode: "PC" }, 1250)
        .display,
    ).toBe("3 cs 6 pc");
    expect(
      quantity(0, { basePerCase: 48, basePerPiece: 1, baseCode: "PC" }, null),
    ).toMatchObject({ display: "0 pc", valueCentavos: 0 });
  });
  it("uses the catalog scale, not a hardcoded 1000, and labels missing conversion as setup", () => {
    expect(
      quantity(
        150000,
        { basePerCase: 48000, basePerPiece: 1000, baseCode: "PC" },
        1.25,
      ).display,
    ).toBe("3 cs 6 pc");
    expect(
      quantity(
        50,
        { basePerCase: null, basePerPiece: null, baseCode: "KG" },
        null,
      ),
    ).toMatchObject({ cases: null, pieces: null, valueCentavos: null });
  });
});
