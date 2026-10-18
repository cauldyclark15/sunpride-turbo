import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { startHarness, profileStore, createUser } from "./harness.js";
import {
  HEADERS,
  checkInput,
  chunkHashOf,
  countChunks,
  quantity,
  dateOnly,
} from "../src/domains/imports/format.js";
import { commitImport, install } from "../src/domains/imports/index.js";

/** @type {any[]} */
const movements = [];
mock.module("../src/domains/inventory/posting.js", () => ({
  postMovement: async (/** @type {any} */ db, /** @type {any} */ input) => {
    movements.push(input);
    const id = crypto.randomUUID();
    await db`insert into inventory_movements(id,organization_id,movement_number,movement_type,source_type,status,effective_at,posted_at,posted_by,idempotency_key,schema_version) values(${id},'sunpride',${id},'opening_balance','cutover','posted',now(),now(),${input.actor.userId},${input.idempotencyKey},1)`;
    return { movementId: id, duplicate: false };
  },
}));
mock.module("../src/domains/org/scope.js", () => ({
  outletOwnerUnit: async (/** @type {any} */ db, /** @type {string} */ id) => {
    const [row] =
      await db`select custodian_org_unit_id from outlets where id=${id}`;
    return row?.custodian_org_unit_id ?? null;
  },
}));
/** @type {import('./harness.js').Harness} */
let h;
/** @type {any} */
let actor;
let cookie = "",
  unit = "",
  location = "",
  product = "";
/** @type {any} */
let store;
/** @param {string} code */
const productRow = (code) => ({
  rowNumber: 2,
  values: {
    product_code: code,
    name: "Example product",
    category: "Example",
    base_uom: "PC",
    selling_uoms: "PC",
    barcode: "",
    tracking_mode: "none",
    allocation_policy: "fifo",
    shelf_life_days: "",
    expiry_required: "N",
    manufacture_date_required: "N",
    minimum_remaining_shelf_life_days: "",
    external_id: "",
  },
});
/** @param {string} kind @param {any[]} rows @param {string} key */
const input = (kind, rows, key) => ({
  header: HEADERS[/** @type {keyof typeof HEADERS} */ (kind)].split(","),
  rows,
  runKey: key,
  fileHash: key,
  chunkIndex: 0,
  rowCount: rows.length,
  idempotencyKey: `${kind}:${key}:0`,
});
/** @param {string} kind @param {any} body */
async function send(kind, body) {
  const response = await h.fetch(`/api/v1/imports/${kind}/commit`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: /** @type {any} */ (await response.json()),
  };
}
const platform = { recordChange: async () => {} };
/** Complete effective-dated route fixture. */
async function routeFixture() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [person] =
    await h.db`insert into profiles(name,email,role,status,org_unit_id,employee_code) values('Example salesperson',${`${suffix}@example.com`},'sales','active',${unit},${suffix}) returning *`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${person.id},${unit},'sales','2020-01-01','fixture','test')`;
  const [territory] =
    await h.db`insert into territories(organization_id,code,name,status,effective_from,created_by) values('sunpride',${suffix},'Example territory','active','2020-01-01','fixture') returning *`;
  await h.db`insert into territory_ownerships(territory_id,org_unit_id,effective_from,actor_subject,reason) values(${territory.id},${unit},'2020-01-01','fixture','test')`;
  await h.db`insert into territory_salespeople(territory_id,profile_id,effective_from,actor_subject,reason) values(${territory.id},${person.id},'2020-01-01','fixture','test')`;
  const [outlet] =
    await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,created_by) values('sunpride',${suffix},'Example outlet','active',${unit},'fixture') returning *`;
  await h.db`insert into outlet_assignments(outlet_id,territory_id,effective_from,actor_subject,reason) values(${outlet.id},${territory.id},'2020-01-01','fixture','test')`;
  const [plan] =
    await h.db`insert into coverage_plans(organization_id,assignee_profile_id,local_month,version,cycle_type,org_unit_id,requested_from,requested_to,effective_from,effective_to,status,prepared_by,prepared_at,content_revision,created_by,updated_by) values('sunpride',${person.id},'2027-01',1,'monthly',${unit},'2027-01-01','2027-02-01','2027-01-01','2027-02-01','draft','fixture',now(),0,'fixture','fixture') returning *`;
  const row = {
    rowNumber: 2,
    values: {
      employee_code: suffix.toUpperCase(),
      territory_code: suffix.toUpperCase(),
      route_code: "",
      outlet_code: suffix.toUpperCase(),
      customer_code: "",
      service_date: "2027-01-15",
      frequency: "weekly",
      sequence: "1",
      duration_minutes: "30",
      objectives: "Visit",
    },
  };
  // Local codes are canonical uppercase.
  await h.db`update territories set code=${suffix.toUpperCase()} where id=${territory.id}`;
  await h.db`update outlets set code=${suffix.toUpperCase()} where id=${outlet.id}`;
  const body = {
    ...input("mcp_visits", [row], suffix),
    header: HEADERS.mcp_visits.split(","),
    format: "mcp_visits",
    planId: plan.id,
    idempotencyKey: `mcp:${suffix}:0`,
  };
  return { plan, person, outlet, body };
}
beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  store = profileStore(h);
  const user = await createUser(
    h,
    "importer@example.com",
    "test-import-password",
  );
  const [u] =
    await h.db`insert into org_units(organization_id,code,name,type_code,status,effective_from) values('sunpride','ROOT','National','NATIONAL','active','2020-01-01') returning id`;
  unit = u.id;
  const p = store.set(user, { role: "super_admin", orgUnitId: unit });
  actor = {
    userId: user,
    profileId: p.id,
    role: "super_admin",
    orgUnitId: unit,
    capabilities: new Set(),
    subject: user,
    name: "Importer",
    scopeEpoch: null,
  };
  h.setHooks({ rootUnitId: async () => unit });
  await h.db`insert into units_of_measure(organization_id,code,name,dimension,decimal_places,active) values('sunpride','PC','Piece','count',0,true)`;
  const [l] =
    await h.db`insert into inventory_locations(organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values('sunpride',${unit},'CEB','WH','Warehouse','warehouse',true,true,true,true,false) returning id`;
  location = l.id;
  const login = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "importer@example.com",
      password: "test-import-password",
    }),
  });
  cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  expect(cookie).toContain("sp_session=");
  const r = await send(
    "products",
    input("products", [productRow("STOCK")], "setup-stock"),
  );
  expect(r.status).toBe(200);
  const [prod] = await h.db`select id from products where code='STOCK'`;
  product = prod.id;
}, 30000);
afterAll(async () => {
  await h?.close();
});

describe("import primitives", () => {
  test("canonical server hash ignores object key ordering but binds every value", () => {
    expect(chunkHashOf({ b: 2, a: 1 })).toBe(chunkHashOf({ a: 1, b: 2 }));
    expect(chunkHashOf({ rows: [1] })).not.toBe(chunkHashOf({ rows: [2] }));
  });
  test("decimal base quantities use catalog scale without rounding", () => {
    expect(quantity("1.25", 1000)).toBe(1250);
    expect(quantity("1.2", 1)).toBeNull();
    expect(quantity("-2", 1)).toBe(-2);
    expect(quantity("9007199254740992", 1)).toBeNull();
  });
  test("rejects impossible calendar dates", () => {
    expect(dateOnly("2026-02-30")).toBeNull();
    expect(dateOnly("2024-02-29")).toBe("2024-02-29");
  });
  test("count sessions stay whole despite interleaved rows", () => {
    const rows = [
      { rowNumber: 2, values: { count_reference: "A" } },
      { rowNumber: 3, values: { count_reference: "B" } },
      { rowNumber: 4, values: { count_reference: "A" } },
    ];
    expect(countChunks(rows).map((g) => g.map((r) => r.rowNumber))).toEqual([
      [2, 4],
      [3],
    ]);
  });
  test("refuses oversized count instead of splitting it", () => {
    expect(() =>
      countChunks(
        Array.from({ length: 101 }, (_, i) => ({
          rowNumber: i + 2,
          values: { count_reference: "A" },
        })),
      ),
    ).toThrow("cannot exceed");
  });
  test("missing or reordered header is invalid_format", () => {
    const body = input("products", [productRow("ABC")], "a");
    expect(() =>
      checkInput(
        "products",
        { ...body, header: [...body.header].reverse() },
        true,
      ),
    ).toThrow("Columns must match");
    expect(() =>
      checkInput("products", { ...body, header: undefined }, true),
    ).toThrow("Columns must match");
  });
});

describe("Postgres imports and HTTP", () => {
  test("draft route import writes roster, slots, territories and audit atomically and replays", async () => {
    const { plan, body } = await routeFixture();
    const listed = await h.fetch("/api/v1/imports/plans", {
      headers: { cookie },
    });
    expect(listed.status).toBe(200);
    expect(
      /** @type {any} */ (await listed.json()).rows.some(
        (/** @type {any} */ p) => p.id === plan.id,
      ),
    ).toBe(true);
    const result = await send("mcp", body);
    expect(result.status).toBe(200);
    expect(result.body.errors).toEqual([]);
    expect(result.body.accepted).toBe(1);
    expect(
      (await h.db`select id from coverage_plan_slots where plan_id=${plan.id}`)
        .length,
    ).toBe(1);
    expect(
      (
        await h.db`select id from coverage_plan_outlets where plan_id=${plan.id}`
      ).length,
    ).toBe(1);
    expect(
      (
        await h.db`select id from coverage_plan_territories where coverage_plan_id=${plan.id}`
      ).length,
    ).toBe(1);
    expect(
      (
        await h.db`select id from coverage_audit_events where plan_id=${plan.id}`
      ).length,
    ).toBe(1);
    expect((await send("mcp", body)).body.duplicate).toBe(true);
  });
  test("a failed route row rolls back the whole chunk", async () => {
    const { plan, body } = await routeFixture();
    const mixed = {
      ...body,
      rowCount: 2,
      rows: [
        body.rows[0],
        {
          ...body.rows[0],
          rowNumber: 3,
          values: { ...body.rows[0].values, outlet_code: "NO-OUTLET" },
        },
      ],
    };
    const result = await send("mcp", mixed);
    expect(result.body.accepted).toBe(0);
    expect(
      result.body.errors.some(
        (/** @type {any} */ e) => e.code === "unknown_reference",
      ),
    ).toBe(true);
    expect(
      (await h.db`select id from coverage_plan_slots where plan_id=${plan.id}`)
        .length,
    ).toBe(0);
  });
  test("route imports refuse approved plans before replay", async () => {
    const { plan, body } = await routeFixture();
    await send("mcp", body);
    await h.db`update coverage_plans set status='approved' where id=${plan.id}`;
    expect((await send("mcp", body)).status).toBe(409);
  });
  test("counts require every frozen line and never expose expected stock", async () => {
    const [session] =
      await h.db`insert into stock_count_sessions(organization_id,count_number,count_type,location_id,status,blind_count,snapshot_at,created_by) values('sunpride','COUNT-TEST','cycle',${location},'counting',true,now(),${actor.userId}) returning id`;
    await h.db`insert into stock_count_lines(organization_id,session_id,product_id,stock_status,system_base,snapshot_balance_version) values('sunpride',${session.id},${product},'available',0,0)`;
    const body = {
      header: HEADERS.cycle_count.split(","),
      rows: [
        {
          rowNumber: 2,
          values: {
            count_reference: "COUNT-TEST",
            location_code: "WH",
            product_code: "STOCK",
            stock_status: "available",
            counted_quantity: "3",
          },
        },
      ],
    };
    const response = await h.fetch("/api/v1/imports/cycle_count/preview", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = /** @type {any} */ (await response.json());
    expect(response.status).toBe(200);
    expect(result.accepted).toBe(1);
    expect(result.lines).toEqual([
      { rowNumber: 2, countedBase: 3, status: "valid" },
    ]);
    expect(JSON.stringify(result)).not.toContain("999");
    await h.db`insert into stock_count_lines(organization_id,session_id,product_id,stock_status,system_base,snapshot_balance_version) values('sunpride',${session.id},${product},'damaged',10,0)`;
    const incomplete = await h.fetch("/api/v1/imports/cycle_count/preview", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const denied = /** @type {any} */ (await incomplete.json());
    expect(denied.accepted).toBe(0);
    expect(
      denied.errors.some(
        (/** @type {any} */ e) => e.code === "count_incomplete",
      ),
    ).toBe(true);
  });
  test("identical file replay is a no-op including audit and product changes", async () => {
    const body = input("products", [productRow("AAA")], "same");
    const first = await send("products", body);
    expect(first.status).toBe(200);
    expect(first.body.accepted).toBe(1);
    const before = await h.db`select change_seq from products where code='AAA'`;
    const second = await send("products", body);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.runId).toBe(first.body.runId);
    expect(
      await h.db`select change_seq from products where code='AAA'`,
    ).toEqual(before);
    const [audits] =
      await h.db`select count(*) as n from import_audit_events where run_id=${first.body.runId}`;
    expect(Number(audits.n)).toBe(1);
  });
  test("changed file hash under the same key is rejected", async () => {
    const body = input("products", [productRow("BBB")], "key");
    expect((await send("products", body)).status).toBe(200);
    const result = await send("products", { ...body, fileHash: "changed" });
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("idempotency_conflict");
  });
  test("changed rows with unchanged client hash are rejected", async () => {
    const body = input("products", [productRow("CCC")], "payload");
    await send("products", body);
    expect(
      (await send("products", { ...body, rows: [productRow("DDD")] })).status,
    ).toBe(409);
  });
  test("same file with a different run key reuses exact receipt", async () => {
    const body = input("products", [productRow("EEE")], "identity");
    const a = await send("products", body);
    const b = await send("products", {
      ...body,
      runKey: "new-key",
      idempotencyKey: "products:new-key:0",
    });
    expect(b.body.duplicate).toBe(true);
    expect(b.body.runId).toBe(a.body.runId);
  });
  test("all-or-nothing product chunk records errors without writing valid neighbors", async () => {
    const bad = {
      ...productRow("BAD"),
      rowNumber: 3,
      values: { ...productRow("BAD").values, base_uom: "UNKNOWN" },
    };
    const result = await send(
      "products",
      input("products", [productRow("GOOD"), bad], "rollback"),
    );
    expect(result.body.accepted).toBe(0);
    expect(result.body.errors[0].code).toBe("unknown_reference");
    expect((await h.db`select id from products where code='GOOD'`).length).toBe(
      0,
    );
  });
  test("bad header refuses before replay", async () => {
    const body = input("products", [productRow("FFF")], "head");
    await send("products", body);
    const result = await send("products", { ...body, header: [] });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("invalid_format");
  });
  test("concurrent identical submissions write exactly once", async () => {
    const body = input("products", [productRow("RACE")], "race");
    const results = await Promise.all([
      send("products", body),
      send("products", body),
    ]);
    expect(results.map((x) => x.body.duplicate).sort()).toEqual([false, true]);
  });
  test("transaction error rolls back catalog and receipt", async () => {
    const body = input("products", [productRow("ROLLBACK")], "txfail");
    await expect(
      commitImport(
        { db: h.db, actor, now: Date.now(), publish: async () => {} },
        "products",
        body,
        {
          recordChange: async () => {
            throw new Error("injected failure");
          },
        },
      ),
    ).rejects.toThrow("injected failure");
    expect(
      (await h.db`select id from products where code='ROLLBACK'`).length,
    ).toBe(0);
    expect(
      (await h.db`select id from import_runs where run_key='txfail'`).length,
    ).toBe(0);
  });
  test("opening stock goes only through posting seam with catalog-scale quantities", async () => {
    const rows = [
      {
        rowNumber: 2,
        values: {
          product_code: "STOCK",
          location_code: "WH",
          lot_number: "",
          manufactured_at: "",
          expires_at: "",
          quantity: "4",
          unit_cost_minor: "",
          source_reference: "CUT",
        },
      },
    ];
    const body = {
      ...input("opening_stock", rows, "opening"),
      sourceReference: "CUT",
    };
    const result = await send("opening_stock", body);
    expect(result.status).toBe(200);
    expect(result.body.accepted).toBe(1);
    expect(movements.at(-1).lines[0].quantityBase).toBe(4);
    const count = movements.length;
    expect((await send("opening_stock", body)).body.duplicate).toBe(true);
    expect(movements.length).toBe(count);
  });
  test("opening-stock duplicates in any physical status are refused", async () => {
    await h.db`insert into inventory_balances(product_code,warehouse_code,on_hand,reserved,available,as_of,organization_id,product_id,location_id,physical_base,damaged_base,version) values('STOCK','WH',2,0,0,now(),'sunpride',${product},${location},2,2,1)`;
    const rows = [
      {
        rowNumber: 2,
        values: {
          product_code: "STOCK",
          location_code: "WH",
          quantity: "4",
          source_reference: "CUT",
        },
      },
    ];
    const before = movements.length;
    const result = await send("opening_stock", {
      ...input("opening_stock", rows, "different-file"),
      sourceReference: "CUT",
    });
    expect(result.body.accepted).toBe(0);
    expect(
      result.body.errors.some(
        (/** @type {any} */ e) => e.code === "duplicate_stock",
      ),
    ).toBe(true);
    expect(movements.length).toBe(before);
  });
  test("regional manager cannot load national products or read their history", async () => {
    store.set(actor.userId, { role: "manager", orgUnitId: unit });
    expect(
      (
        await send(
          "products",
          input("products", [productRow("DENIED")], "denied"),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await h.fetch("/api/v1/imports/runs?kind=products", {
          headers: { cookie },
        })
      ).status,
    ).toBe(403);
    store.set(actor.userId, { role: "super_admin", orgUnitId: unit });
  });
  test("run history reads persisted row errors without raw payloads", async () => {
    const response = await h.fetch("/api/v1/imports/runs?kind=products", {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    const body = /** @type {any} */ (await response.json());
    expect(body.rows.some((/** @type {any} */ r) => r.errors.length)).toBe(
      true,
    );
    expect(JSON.stringify(body)).not.toContain("raw_row");
  });
  test("operational submission fails closed rather than bypassing owner approval", async () => {
    const rows = [
      {
        rowNumber: 2,
        values: {
          source_reference: "A",
          line_key: "1",
          adjustment_type: "CORRECTION",
          reason_code: "COUNT",
          product_code: "STOCK",
          location_code: "WH",
          stock_status: "available",
          quantity_delta: "1",
        },
      },
    ];
    const result = await send(
      "stock_adjustment",
      input("stock_adjustment", rows, "operational"),
    );
    expect(result.status).toBe(503);
    expect(result.body.error.code).toBe("owner_seam_required");
    expect((await h.db`select id from inventory_adjustments`).length).toBe(0);
  });
});
