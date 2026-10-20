import { beforeAll, afterAll, expect, test } from "bun:test";
import { tx } from "@sunpride/db/client";
import { startHarness } from "./harness.js";
import { install as org } from "../src/domains/org/index.js";
import { install as masters } from "../src/domains/masters/index.js";
import { install as imports } from "../src/domains/imports/index.js";
import { MIGRATION_HEADERS } from "../src/domains/imports/migration-headers.js";
import { seedDemo } from "../../../packages/db/seed/index.js";
import { seedSpecMasters } from "../../../packages/db/seed/spec-masters.js";
import { rowId, todayManila, plusDays } from "../../../packages/db/seed/store.js";
/** @type {import('./harness.js').Harness} */ let h;
let cookie = "",
  unit = "",
  customer = "",
  territory = "";
/** @param {string} path @param {any} [body] */
async function request(path, body) {
  const response = await h.fetch(`/api/v1/imports/${path}`, {
    method: body ? "POST" : "GET",
    headers: { cookie, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: response.status,
    body: /** @type {any} */ (await response.json()),
  };
}
/** @param {string} kind @param {Record<string,string>} values */
async function stage(kind, values) {
  const hash = new Bun.CryptoHasher("sha256")
      .update(JSON.stringify(values))
      .digest("hex"),
    key = `${kind}:${hash}:0`,
    body = {
      header: /** @type {any} */ (MIGRATION_HEADERS)[kind].split(","),
      rows: [{ rowNumber: 2, values }],
      sourceReference: "F-022-CUTOVER",
      runKey: hash,
      fileHash: hash,
      chunkIndex: 0,
      idempotencyKey: key,
      rowCount: 1,
    };
  const result = await request(`${kind}/commit`, body);
  expect(result.status).toBe(200);
  expect(result.body.accepted).toBe(1);
  expect(result.body.failed).toBe(0);
  const [row] =
    await h.db`select * from migration_staging_rows where legacy_id=${values.legacy_id}`;
  expect(row.status).toBe("staged");
  return { row, body, result };
}
/** @param {any} row @param {string} action @param {any} [more] */
const review = (row, action, more = {}) =>
  request("migration/review", {
    stagingId: row.id,
    payloadHash: row.payload_hash,
    action,
    reason: "F-022 reviewed source mapping",
    ...more,
  });
beforeAll(async () => {
  h = await startHarness({ installers: [org, masters, imports] });
  // F-020 F-013/F-022: generate the future fixture through its writer, never
  // mutate the now-immutable audit log to simulate a future manifest.
  await seedDemo(h.db, { days: 2, anchorDate: plusDays(todayManila(), 1) });
  const [futureManifest] = await h.db`select created_at from audit_logs where id=${rowId("audit_logs", "manifest")}`;
  expect(new Date(futureManifest.created_at).getTime()).toBeGreaterThan(Date.now());
  await tx(h.db, seedSpecMasters);
  const password = (
    await Bun.file(`${process.env.HOME}/.sunpride-keys/v2-test-password`).text()
  ).trim();
  const response = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@sunpride.test", password }),
  });
  expect(response.status).toBe(200);
  cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  const [u] =
    await h.db`select code from org_units where id=${rowId("org_units", "territory-0")}`;
  unit = u.code;
  const [c] =
    await h.db`select code from customers where active and deleted_at is null order by code limit 1`;
  customer = c.code;
  const [t] =
    await h.db`select t.code from territories t join territory_ownerships o on o.territory_id=t.id where o.org_unit_id=${rowId("org_units", "territory-0")} and o.effective_to is null and o.deleted_at is null order by t.code limit 1`;
  territory = t.code;
}, 120000);
afterAll(async () => {
  await h?.close();
});
test("F-022 customer cutover stages without business writes, preserves zero-prefixed identities and replays exactly", async () => {
  const [before] = await h.db`select count(*)::int n from customers`;
  const values = {
    legacy_id: "000001",
    sap_id: "000009001",
    code: "CUT-CUSTOMER",
    name: "Distinct cutover customer",
    channel_code: "GT",
    org_unit_code: unit,
  };
  const { row, body } = await stage("customers", values);
  expect((await h.db`select count(*)::int n from customers`)[0].n).toBe(
    before.n,
  );
  const replay = await request("customers/commit", body);
  expect(replay.body.duplicate).toBe(true);
  expect(
    (
      await h.db`select count(*)::int n from migration_staging_rows where legacy_id='000001'`
    )[0].n,
  ).toBe(1);
  const applied = await review(row, "create");
  expect(applied.status).toBe(200);
  const [created] =
    await h.db`select * from customers where id=${applied.body.targetId}`;
  expect(created.external_id).toBe("000009001");
  const [source] =
    await h.db`select legacy_id,sap_id from migration_source_maps where target_id=${created.id}`;
  expect(source.legacy_id).toBe("000001");
  expect(source.sap_id).toBe("000009001");
  expect((await review(row, "create")).body.duplicate).toBe(true);
  expect((await review(row, "reject")).status).toBe(409);
  expect((await h.db`select count(*)::int n from customers`)[0].n).toBe(
    before.n + 1,
  );
});
test("F-022 duplicate master mapping leaves original identity and content untouched", async () => {
  const [existing] = await h.db`select * from customers where code=${customer}`;
  const { row } = await stage("customers", {
    legacy_id: "000002",
    sap_id: "000009002",
    code: customer,
    name: existing.name,
    channel_code: "GT",
    org_unit_code: unit,
  });
  expect((await review(row, "create")).status).toBe(422);
  const mapped = await review(row, "map", { targetId: existing.id });
  expect(mapped.status).toBe(200);
  expect(
    JSON.stringify(await h.db`select * from customers where id=${existing.id}`),
  ).toBe(JSON.stringify([existing]));
  const [link] =
    await h.db`select * from migration_source_maps where legacy_id='000002'`;
  expect(link.target_id).toBe(existing.id);
});
test("F-022 malformed, duplicate and unresolved source rows cannot enter staging", async () => {
  const values = {
    legacy_id: "000003",
    sap_id: "000009003",
    code: "lowercase-invalid",
    name: "Bad source",
    channel_code: "UNKNOWN",
    org_unit_code: unit,
  };
  const preview = await request("customers/preview", {
    header: MIGRATION_HEADERS.customers.split(","),
    rows: [
      { rowNumber: 2, values },
      { rowNumber: 3, values },
    ],
    sourceReference: "F-022",
  });
  expect(preview.status).toBe(200);
  expect(
    preview.body.errors.some((/** @type {any} */ e) => e.column === "code"),
  ).toBe(true);
  expect(
    preview.body.errors.some(
      (/** @type {any} */ e) => e.code === "duplicate_in_file",
    ),
  ).toBe(true);
  expect(
    preview.body.errors.some(
      (/** @type {any} */ e) => e.column === "channel_code",
    ),
  ).toBe(true);
  expect(
    (
      await h.db`select count(*)::int n from migration_staging_rows where legacy_id='000003'`
    )[0].n,
  ).toBe(0);
});
test("F-022 physical outlet and route review creates linked identities without treating a pin as verified", async () => {
  const { row } = await stage("outlet_universe", {
    legacy_id: "000004",
    sap_id: "000009004",
    code: "CUT-OUTLET",
    name: "Distinct cutover store",
    address: "Sample cutover address",
    owner_name: "Sample owner",
    owner_phone: "09170001004",
    channel_code: "GT",
    subchannel_code: "SARI_SARI",
    org_unit_code: unit,
    customer_code: customer,
    latitude: "10.35",
    longitude: "123.94",
    accuracy_meters: "12",
  });
  const r = await review(row, "create");
  expect(r.status).toBe(200);
  expect(
    (
      await h.db`select customer_id from outlet_customer_links where outlet_id=${r.body.targetId}`
    )[0].customer_id,
  ).toBeTruthy();
  expect(
    (
      await h.db`select status from outlet_pins where outlet_id=${r.body.targetId}`
    )[0].status,
  ).toBe("pending");
  const route = await stage("route_master", {
    legacy_id: "000005",
    sap_id: "000009005",
    code: "CUT-ROUTE",
    name: "Distinct cutover route",
    org_unit_code: unit,
    territory_code: territory,
    weekdays: "1;3;5",
    cycle_days: "7",
  });
  const applied = await review(route.row, "create");
  expect(applied.status).toBe(200);
  expect(
    (
      await h.db`select weekday_template from routes where id=${applied.body.targetId}`
    )[0].weekday_template,
  ).toEqual(new Int32Array([1, 3, 5]));
});
test("F-022 open AR is an exact provenance-bearing replica, never a cash or ledger posting", async () => {
  const [before] =
    await h.db`select (select count(*)::int from inventory_ledger_entries) ledger,(select count(*)::int from field_collections) receipts`;
  const { row } = await stage("open_ar", {
    legacy_id: "000006",
    sap_id: "000009006",
    customer_code: customer,
    document_number: "SRC-INV-0006",
    document_date: todayManila(),
    due_date: todayManila(),
    currency: "PHP",
    original_centavos: "125050",
    open_centavos: "75025",
    as_of: todayManila(),
  });
  const applied = await review(row, "create");
  expect(applied.status).toBe(200);
  const [ar] =
    await h.db`select * from sap_open_ar_projection where id=${applied.body.targetId}`;
  expect(Number(ar.open_centavos)).toBe(75025);
  expect(ar.sap_id).toBe("000009006");
  expect(ar.source_reference).toBe("F-022-CUTOVER");
  expect(
    (
      await h.db`select (select count(*)::int from inventory_ledger_entries) ledger,(select count(*)::int from field_collections) receipts`
    )[0],
  ).toEqual(before);
});
