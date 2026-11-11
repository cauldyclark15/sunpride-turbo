import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startHarness, profileStore, createUser } from "./harness.js";
import { install } from "../src/domains/imports/index.js";
import {
  runtime,
  startRun,
  sweepStaleRuns,
} from "../src/domains/imports/stores.js";
import {
  CUSTOMER_HEADERS,
  CUSTOMER_TEMPLATE_SPEC,
} from "@sunpride/import-templates/customers";

/** @type {import('./harness.js').Harness} */
let h;
/** @type {Record<string,string>} */
const cookies = {};
/** @type {Record<string,string>} */
const ids = {};

/** @param {string} email */
async function signIn(email) {
  const login = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "test-upload-password" }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  expect(cookie).toContain("sp_session=");
  return cookie;
}
/** @param {string} who @param {string} path @param {any} [body] */
async function call(who, path, body) {
  const response = await h.fetch(`/api/v1/imports/store-upload${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie: cookies[who], "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: /** @type {any} */ (await response.json()),
  };
}
/** @param {number} rowNumber @param {Record<string,string>} [over] */
function row(rowNumber, over = {}) {
  const values = Object.fromEntries(
    CUSTOMER_TEMPLATE_SPEC.map((c) => [c.column, c.example]),
  );
  Object.assign(values, {
    customer_code: `ST-${rowNumber}`,
    customer_name: `Store ${rowNumber}`,
    billing_account_code: "",
    area: "CEB-N",
    ...over,
  });
  return { rowNumber, values };
}
/** @param {any[]} rows @param {string} [fileName] */
const file = (rows, fileName = "stores.csv") => ({
  fileName,
  header: [...CUSTOMER_HEADERS],
  rows,
});
/** @param {string} prefix @param {number} n @param {Record<string,string>} [over] */
const many = (prefix, n, over = {}) =>
  Array.from({ length: n }, (_, i) =>
    row(i + 2, { customer_code: `${prefix}-${i + 2}`, ...over }),
  );
/** @param {string} id */
async function finish(id) {
  await runtime.workers.get(id);
  const [run] = await h.db`select * from customer_upload_runs where id=${id}`;
  return run;
}

beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  const store = profileStore(h);
  const [root] =
    await h.db`insert into org_units(organization_id,code,name,type_code,status,effective_from) values('sunpride','SUNPRIDE','National','NATIONAL','active','2020-01-01') returning id`;
  const [cebu] =
    await h.db`insert into org_units(organization_id,code,name,type_code,status,effective_from,parent_id) values('sunpride','CEB-N','Cebu City North','BRANCH','active','2020-01-01',${root.id}) returning id`;
  const [davao] =
    await h.db`insert into org_units(organization_id,code,name,type_code,status,effective_from,parent_id) values('sunpride','DVO','Davao','BRANCH','active','2020-01-01',${root.id}) returning id`;
  Object.assign(ids, { root: root.id, cebu: cebu.id, davao: davao.id });
  h.setHooks({ rootUnitId: async () => root.id });
  /** @param {string} kind @param {string} code @param {string} label @param {any} data */
  const master = async (kind, code, label, data = {}) => {
    const [d] =
      await h.db`insert into master_definitions(kind,code) values(${kind},${code}) returning id`;
    await h.db`insert into master_versions(master_id,version,label,status,data,effective_from,reason) values(${d.id},1,${label},'active',${data},'2020-01-01','fixture')`;
    return d.id;
  };
  ids.gt = await master("channel", "GT", "General Trade");
  ids.mt = await master("channel", "MT", "Modern Trade");
  ids.sari = await master("subchannel", "SARI", "Sari-sari", {
    channelId: ids.gt,
  });
  ids.superm = await master("subchannel", "SUPER", "Supermarket", {
    channelId: ids.mt,
  });
  await h.db`insert into master_channel_aliases(legacy_key,channel_id) values('gentrade',${ids.gt})`;
  for (const [who, role, unit] of [
    ["boss", "super_admin", root.id],
    ["ops", "operations", cebu.id],
    ["viewer", "viewer", cebu.id],
  ]) {
    const user = await createUser(
      h,
      `${who}@example.com`,
      "test-upload-password",
    );
    store.set(user, { role, orgUnitId: unit, name: `${who} person` });
    cookies[who] = await signIn(`${who}@example.com`);
  }
}, 60000);
afterAll(async () => {
  await Promise.all(runtime.workers.values());
  await h?.close();
});

describe("SP-0169 store upload — validation", () => {
  test("preview returns new/update per row and DB lookup errors tied to row, column and value", async () => {
    const r = await call(
      "boss",
      "/preview",
      file([
        row(2, { channel: "general trade", sub_channel: "sari-sari" }),
        row(3, { channel: "GT", sub_channel: "SARI", area: "cebu city north" }),
        row(4, { channel: "gentrade", sub_channel: "" }),
        row(5, { channel: "Retail Giant" }),
        row(6, { channel: "General Trade", sub_channel: "Supermarket" }),
        row(7, { area: "Atlantis" }),
        row(8, { latitude: "200", customer_code: "ST-2" }),
      ]),
    );
    expect(r.status).toBe(200);
    expect(r.body.rowCount).toBe(7);
    expect(r.body.validCount).toBe(3);
    expect(r.body.newCount).toBe(3);
    const by = (/** @type {number} */ n) =>
      r.body.errors.filter((/** @type {any} */ e) => e.rowNumber === n);
    expect(by(5)[0]).toMatchObject({
      column: "channel",
      code: "unknown_channel",
      value: "Retail Giant",
    });
    expect(by(6)[0]).toMatchObject({
      column: "sub_channel",
      code: "sub_channel_mismatch",
    });
    expect(by(7)[0]).toMatchObject({ column: "area", code: "unknown_area" });
    expect(
      by(8)
        .map((/** @type {any} */ e) => e.code)
        .sort(),
    ).toEqual(["duplicate_in_file", "invalid_coordinates"]);
    expect(
      r.body.rows.find((/** @type {any} */ x) => x.rowNumber === 5).valid,
    ).toBe(false);
  });
  test("a header that differs from the template is refused with a stable code", async () => {
    const headers = [...CUSTOMER_HEADERS].reverse();
    const r = await call("boss", "/preview", {
      ...file([row(2)]),
      header: headers,
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain("header_mismatch");
  });
  test("viewer without masterdata.manage is denied", async () => {
    const r = await call("viewer", "/preview", file([row(2)]));
    expect(r.status).toBe(403);
  });
});

describe("SP-0169 store upload — import", () => {
  test("chunks run in parallel with bounded concurrency and every row is written through the store writers", async () => {
    runtime.chunkSize = 100;
    runtime.concurrency = 3;
    let active = 0,
      peak = 0;
    runtime.hooks.beforeChunk = async () => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(40);
      active--;
    };
    const rows = many("PAR", 250, {
      billing_account_code: "",
      owner_phone: "0917 123 4567",
    });
    rows[0].values.billing_account_code = "SHARED-1";
    rows[1].values.billing_account_code = "SHARED-1";
    rows[2].values.status = "inactive";
    const r = await call("boss", "/runs", file(rows, "parallel.csv"));
    expect(r.status).toBe(200);
    expect(r.body.duplicate).toBe(false);
    const run = await finish(r.body.id);
    runtime.hooks = {};
    expect(run.status).toBe("completed");
    expect(run.succeeded_count).toBe(250);
    expect(run.created_count).toBe(250);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
    const [{ n }] =
      await h.db`select count(*)::int n from outlets where code like 'PAR-%'`;
    expect(n).toBe(250);
    const [o] =
      await h.db`select o.*,c.code billing from outlets o join outlet_customer_links l on l.outlet_id=o.id and l.effective_to is null join customers c on c.id=l.customer_id where o.code='PAR-5'`;
    expect(o).toMatchObject({
      status: "active",
      name: "Store 5",
      channel_id: ids.gt,
      subchannel_id: ids.sari,
      custodian_org_unit_id: ids.cebu,
      visit_frequency_days: 7,
      billing: "PAR-5",
      address: "123 P. del Rosario St., Brgy. Kamputhaw, Cebu City, Cebu",
    });
    const [pin] =
      await h.db`select status,source from outlet_pins where outlet_id=${o.id}`;
    expect(pin).toEqual({ status: "pending", source: "customer_upload" });
    const [contact] =
      await h.db`select name,phone from outlet_contacts where outlet_id=${o.id}`;
    expect(contact).toEqual({ name: "Elena Cruz", phone: "09171234567" });
    const shared =
      await h.db`select o.code from outlets o join outlet_customer_links l on l.outlet_id=o.id join customers c on c.id=l.customer_id where c.code='SHARED-1' order by o.code`;
    expect(shared.length).toBe(2);
    const [inactive] =
      await h.db`select status from outlets where code='PAR-4'`;
    expect(inactive.status).toBe("inactive");
    const [audit] =
      await h.db`select count(*)::int n from audit_logs where action='SP-0169.store.upload_new'`;
    expect(audit.n).toBe(250);
  }, 60000);

  test("existing codes upsert: preview says update, commit edits the same store", async () => {
    const pre = await call(
      "boss",
      "/preview",
      file([row(2, { customer_code: "par-6", customer_name: "Renamed" })]),
    );
    expect(pre.body.rows[0].action).toBe("update");
    expect(pre.body.updateCount).toBe(1);
    const r = await call(
      "boss",
      "/runs",
      file(
        [
          row(2, {
            customer_code: "PAR-6",
            customer_name: "Renamed",
            channel: "MT",
            sub_channel: "Supermarket",
            billing_account_code: "SHARED-1",
          }),
        ],
        "update.csv",
      ),
    );
    const run = await finish(r.body.id);
    expect(run.status).toBe("completed");
    expect(run.updated_count).toBe(1);
    const outlets =
      await h.db`select id,name,channel_id,subchannel_id from outlets where code='PAR-6'`;
    expect(outlets.length).toBe(1);
    expect(outlets[0]).toMatchObject({
      name: "Renamed",
      channel_id: ids.mt,
      subchannel_id: ids.superm,
    });
    const links =
      await h.db`select c.code,l.effective_to from outlet_customer_links l join customers c on c.id=l.customer_id where l.outlet_id=${outlets[0].id} order by l.effective_from`;
    expect(links.map((/** @type {any} */ l) => l.code)).toEqual([
      "PAR-6",
      "SHARED-1",
    ]);
    expect(links[0].effective_to).not.toBeNull();
    // Same coordinates as before: no second pending pin.
    const pins =
      await h.db`select id from outlet_pins where outlet_id=${outlets[0].id}`;
    expect(pins.length).toBe(1);
  }, 30000);

  test("re-uploading the identical file returns the same run and writes nothing", async () => {
    const rows = many("IDEM", 3);
    const first = await call("boss", "/runs", file(rows, "idem.csv"));
    await finish(first.body.id);
    const [before] =
      await h.db`select max(change_seq)::text seq, (select count(*)::int from audit_logs) audits from outlets`;
    const again = await call("boss", "/runs", file(rows, "idem-copy.csv"));
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(again.body.id).toBe(first.body.id);
    expect(runtime.workers.has(first.body.id)).toBe(false);
    const [after] =
      await h.db`select max(change_seq)::text seq, (select count(*)::int from audit_logs) audits from outlets`;
    expect(after).toEqual(before);
    const [{ runs }] =
      await h.db`select count(*)::int runs from customer_upload_runs where file_hash=(select file_hash from customer_upload_runs where id=${first.body.id})`;
    expect(runs).toBe(1);
  }, 30000);
});

describe("SP-0169 store upload — interruption and resume", () => {
  test("a crash mid-run leaves an exact per-row report and resume processes only unprocessed rows", async () => {
    runtime.concurrency = 1;
    runtime.autoStart = false;
    const r = await call(
      "boss",
      "/runs",
      file(many("CRASH", 250), "crash.csv"),
    );
    expect(r.body.status).toBe("queued");
    let seen = 0;
    runtime.hooks.beforeChunk = () => {
      if (++seen === 2) throw new Error("simulated crash");
    };
    await startRun(r.body.id);
    runtime.hooks = {};
    const detail = await call("boss", `/runs/${r.body.id}`);
    expect(detail.body.run.status).toBe("interrupted");
    expect(detail.body.run.succeeded).toBe(100);
    expect(detail.body.run.pending).toBe(150);
    const statuses = detail.body.rows.map((/** @type {any} */ x) => x.status);
    expect(
      statuses.filter((/** @type {string} */ s) => s === "pending").length,
    ).toBe(150);
    expect(detail.body.rows[0]).toMatchObject({
      rowNumber: 2,
      status: "succeeded",
      action: "new",
    });
    runtime.autoStart = true;
    runtime.concurrency = 4;
    const resumed = await call("boss", `/runs/${r.body.id}/resume`, {});
    expect(resumed.body.resumed).toBe(true);
    const run = await finish(r.body.id);
    expect(run.status).toBe("completed");
    expect(run.succeeded_count).toBe(250);
    expect(run.attempt).toBe(2);
    const [{ n }] =
      await h.db`select count(*)::int n from outlets where code like 'CRASH-%'`;
    expect(n).toBe(250);
    // Rows done before the crash were not reprocessed.
    const [{ twice }] =
      await h.db`select count(*)::int twice from customer_upload_rows where run_id=${r.body.id} and attempts>1`;
    expect(twice).toBe(0);
  }, 60000);

  test("a run whose worker stopped heart-beating is detected as interrupted", async () => {
    runtime.autoStart = false;
    const r = await call("boss", "/runs", file(many("STALE", 2), "stale.csv"));
    runtime.autoStart = true;
    await h.db`update customer_upload_runs set status='running', lease_owner='dead-process', lease_expires_at=now()-interval '1 minute' where id=${r.body.id}`;
    const list = await call("boss", "/runs");
    const listed = list.body.rows.find(
      (/** @type {any} */ x) => x.id === r.body.id,
    );
    expect(listed.status).toBe("interrupted");
    expect(listed.pending).toBe(2);
    expect(await sweepStaleRuns(h.db)).toEqual([]);
    await call("boss", `/runs/${r.body.id}/resume`, {});
    expect((await finish(r.body.id)).status).toBe("completed");
  }, 30000);

  test("retry failed rows after fixing the reference data", async () => {
    const r = await call(
      "boss",
      "/runs",
      file(
        [
          row(2, { customer_code: "LATE-1", area: "LATE" }),
          row(3, { customer_code: "LATE-2" }),
        ],
        "late.csv",
      ),
    );
    const run = await finish(r.body.id);
    expect(run.status).toBe("completed_with_errors");
    expect(run.failed_count).toBe(1);
    const detail = await call("boss", `/runs/${r.body.id}`);
    expect(detail.body.rows[0].errors[0]).toMatchObject({
      column: "area",
      code: "unknown_area",
      value: "LATE",
    });
    await h.db`insert into org_units(organization_id,code,name,type_code,status,effective_from,parent_id) values('sunpride','LATE','Late Branch','BRANCH','active','2020-01-01',${ids.root})`;
    const retry = await call("boss", `/runs/${r.body.id}/resume`, {
      retryFailed: true,
    });
    expect(retry.body.resumed).toBe(true);
    const done = await finish(r.body.id);
    expect(done.status).toBe("completed");
    expect(done.succeeded_count).toBe(2);
  }, 30000);
});

describe("SP-0169 store upload — scope", () => {
  test("a scoped user cannot import into, or update stores in, areas outside their scope", async () => {
    await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,created_by) values('sunpride','DVO-1','Davao store','active',${ids.davao},'fixture')`;
    const pre = await call(
      "ops",
      "/preview",
      file([
        row(2, { customer_code: "OPS-1" }),
        row(3, { customer_code: "OPS-2", area: "Davao" }),
        row(4, { customer_code: "DVO-1", area: "CEB-N" }),
      ]),
    );
    expect(pre.status).toBe(200);
    const codes = pre.body.errors.map(
      (/** @type {any} */ e) => `${e.rowNumber}:${e.code}`,
    );
    expect(codes).toEqual(["3:area_out_of_scope", "4:store_out_of_scope"]);
    const r = await call(
      "ops",
      "/runs",
      file(
        [
          row(2, { customer_code: "OPS-1" }),
          row(3, { customer_code: "OPS-2", area: "Davao" }),
        ],
        "ops.csv",
      ),
    );
    const run = await finish(r.body.id);
    expect(run.succeeded_count).toBe(1);
    expect(run.failed_count).toBe(1);
    const [{ n }] =
      await h.db`select count(*)::int n from outlets where code='OPS-2'`;
    expect(n).toBe(0);
    // The scoped user's history holds only their own / in-scope runs.
    const mine = await call("ops", "/runs");
    expect(mine.body.rows.map((/** @type {any} */ x) => x.fileName)).toEqual([
      "ops.csv",
    ]);
    const other = await call(
      "ops",
      `/runs/${(await call("boss", "/runs")).body.rows.at(-1).id}`,
    );
    expect(other.status).toBe(404);
  }, 30000);
});
