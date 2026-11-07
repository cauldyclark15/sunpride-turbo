import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDb } from "../src/client.js";
import { migrate } from "../src/migrate.js";
import { seedDemo } from "./index.js";
import { BATCH, ident, rowId } from "./store.js";
import {
  KickoffConflict,
  addDays,
  applyKickoffDemo,
  parseArgs,
  planKickoffDemo,
  segments,
  verifiedSample,
} from "./kickoff-demo.js";

// Disposable database only (same lane/key-file mechanism as daily.test.js); nothing here touches a shared DB.
const lane = process.env.SP_LANE ?? "seed";
if (!/^[a-z0-9_]+$/.test(lane)) throw new Error("Invalid SP_LANE");
/** @type {any} */ let db;
/** @type {any} */ let admin;
let name = "",
  dbUrl = "";
const anchor = "2026-10-27";
const now = Date.parse("2026-10-28T09:00:00+08:00");
const FREE = "2026-12-01"; // no sample plan covers December
/** Tables this helper is allowed to change (coverage domain + its own ledger/feed/audit/jobs). */
const ALLOWED = new Set([
  "coverage_plans",
  "coverage_assignments",
  "coverage_plan_outlets",
  "coverage_plan_territories",
  "coverage_plan_slots",
  "coverage_audit_events",
  "coverage_commands",
  "planned_visits",
  "change_log",
  "jobs",
]);
const GUARDED = [
  "coverage_plans",
  "coverage_plan_slots",
  "planned_visits",
  "visit_executions",
  "van_trips",
  "profiles",
  "employee_assignments",
  "outlets",
  "registered_devices",
];

async function counts() {
  const rows = await db`select table_name as t,
    (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::int as n
    from information_schema.tables where table_schema='public' and table_type='BASE TABLE'`;
  return Object.fromEntries(rows.map((/** @type {any} */ r) => [r.t, r.n]));
}
/** @param {Record<string,number>} a @param {Record<string,number>} b */
const delta = (a, b) =>
  Object.fromEntries(Object.keys(b).filter((k) => a[k] !== b[k]).map((k) => [k, b[k] - a[k]]));
/** @type {Record<string,string[]>} */ const baselineIds = {};
/** md5 of exactly the rows that existed right after seeding, so rows the helper adds never mask a change to old ones. */
async function fingerprint() {
  /** @type {Record<string,string>} */ const out = {};
  for (const table of GUARDED)
    out[table] = (await db.unsafe(`select md5(coalesce(string_agg(t::text,'|' order by t.id::text),'')) as h from ${ident(table)} t where t.id::text = any($1::text[])`, [`{${baselineIds[table].join(",")}}`]))[0].h;
  return out;
}
/** @type {Record<string,string>} */ let baseline = {};
const agentId = async () => (await db`select id from profiles where email='agent@sunpride.test'`)[0].id;

beforeAll(async () => {
  const base = (await Bun.file(`${process.env.HOME}/.sunpride-keys/pg-lane-${lane}-url`).text()).trim();
  admin = createDb(base, { max: 1 });
  name = `sunpride_lane_${lane}_t${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await admin.unsafe(`create database ${ident(name)}`);
  const url = new URL(base);
  url.pathname = `/${name}`;
  dbUrl = url.toString();
  db = createDb(dbUrl, { max: 4 });
  await migrate(db);
  await seedDemo(db, { anchorDate: anchor, days: 7 });
  for (const table of GUARDED)
    baselineIds[table] = (await db.unsafe(`select id::text as id from ${ident(table)}`)).map((/** @type {any} */ r) => r.id);
  baseline = await fingerprint();
}, 120_000);
afterAll(async () => {
  await db?.close();
  if (name.startsWith(`sunpride_lane_${lane}_t`))
    await admin.unsafe(`drop database if exists ${ident(name)} with (force)`);
  await admin?.close();
});

test("segments never cross a month and cover exactly the window", () => {
  expect(segments("2026-12-29", 7).map((s) => [s.month, s.from, s.to, s.dates.length])).toEqual([
    ["2026-12", "2026-12-29", "2027-01-01", 3],
    ["2027-01", "2027-01-01", "2027-01-05", 4],
  ]);
  expect(addDays("2026-02-27", 3)).toBe("2026-03-02");
  expect(parseArgs(["--apply", "--days", "7", "--stores", "A,B"]).stores).toEqual(["A", "B"]);
  expect(() => parseArgs(["--bogus"])).toThrow("Unknown option");
});

test("traced facts: seeded state the corrected report relies on", async () => {
  const id = await agentId();
  // Oct plan is active through month end; the sample Nov plan is only SUBMITTED (not approved/active).
  const plans = await db`select local_month,status,(approval_signature is not null) as signed from coverage_plans where assignee_profile_id=${id} order by local_month`;
  expect(plans.map((/** @type {any} */ p) => [p.local_month, p.status])).toEqual([["2026-10", "active"], ["2026-11", "submitted"]]);
  // "Done" calls are executions on a planned day; they are not a lease or a day-closure record.
  const [x] = await db`select count(*)::int n from visit_executions where assignee_profile_id=${id} and service_date=${anchor} and state='completed'`;
  expect(x.n).toBe(25);
  expect((await db`select count(*)::int n from registered_devices`)[0].n).toBe(0);
});

test("dry run is the default, reads only, and finds the five stores", async () => {
  const before = await counts();
  const fp = await fingerprint();
  const r = await planKickoffDemo(db, { from: FREE, now });
  expect(r.dryRun).toBe(true);
  expect(r.ok).toBe(true);
  expect(r.conflicts).toEqual([]);
  expect(r.stores).toHaveLength(5);
  expect(r.window.dates).toHaveLength(7);
  expect(r.approver?.email).toBe("supervisor@sunpride.test");
  expect(r.mode).toBe("submit-only");
  expect(delta(before, await counts())).toEqual({});
  expect(await fingerprint()).toEqual(fp);
});

test("fails closed on every unowned overlap and writes nothing", async () => {
  const before = await counts();
  const fp = await fingerprint();
  /** @type {[string, string][]} */
  const cases = [
    ["2026-10-29", "unowned_plan_overlaps_window"], // active sample Oct plan runs to month end
    ["2026-11-04", "unowned_plan_overlaps_window"], // sample Nov plan is submitted and would block its approval
    ["2026-10-20", "window_in_past"],
  ];
  for (const [from, code] of cases) {
    const r = await planKickoffDemo(db, { from, now });
    expect(r.ok).toBe(false);
    expect(r.conflicts.map((/** @type {any} */ c) => c.code)).toContain(code);
    const err = await applyKickoffDemo(db, { from, now, approve: true }).catch((e) => e);
    expect(err).toBeInstanceOf(KickoffConflict);
    expect(err.report.applied).toBe(false);
  }
  // Sample Nov plan has slots on 2026-11-02; a window on that date also reports the unowned slots.
  const r = await planKickoffDemo(db, { from: "2026-11-02", days: 1, now });
  expect(r.conflicts.map((/** @type {any} */ c) => c.code)).toContain("unowned_slots_on_window");
  expect(delta(before, await counts())).toEqual({});
  expect(await fingerprint()).toEqual(fp);
});

test("exact profile ids select the assignee/seller; unknown or non-sales ids fail closed", async () => {
  const id = await agentId();
  const byId = await planKickoffDemo(db, { from: FREE, now, assigneeProfileId: id, assigneeEmail: "nobody@x.test" });
  expect(byId.ok).toBe(true);
  expect(byId.assignee.profileId).toBe(id);
  const [other] = await db`select id from profiles where email='field2@sunpride.test'`;
  const o2 = await planKickoffDemo(db, { from: "2026-12-01", now, assigneeProfileId: other.id });
  // a sample field person without a login user cannot be a demo assignee: fail closed
  expect(o2.conflicts.map((/** @type {any} */ c) => c.code)).toContain("assignee_unavailable");
  const [mgr] = await db`select id from profiles where email='manager@sunpride.test'`;
  const bad = await planKickoffDemo(db, { from: FREE, now, assigneeProfileId: mgr.id });
  expect(bad.conflicts.map((/** @type {any} */ c) => c.code)).toContain("assignee_unavailable");
  const [seller] = await db`select id from profiles where email='van@sunpride.test'`;
  expect((await planKickoffDemo(db, { from: FREE, now, vanSellerProfileId: seller.id })).van.seller).toBe("van@sunpride.test");
  expect(() => parseArgs(["--assignee-id", "x"]).assigneeProfileId).not.toThrow();
  await expect(planKickoffDemo(db, { assigneeProfileId: "not-a-uuid", now })).rejects.toThrow("UUIDs");
  expect(parseArgs(["--assignee-id", id, "--van-seller-id", seller.id])).toMatchObject({ assigneeProfileId: id, vanSellerProfileId: seller.id });
});

/** Temporarily remove the sample ownership marker(s) of rows, run `fn`, then restore them byte-for-byte.
 * @param {[string,string][]} rows [table,id] pairs @param {() => Promise<any>} fn */
async function withoutMarkers(rows, fn) {
  /** @type {any[]} */ const saved = [];
  for (const [table, id] of rows)
    saved.push(...(await db`delete from sample_data_rows where batch=${BATCH} and table_name=${table} and row_id=${id} returning *`));
  try {
    return await fn();
  } finally {
    for (const m of saved)
      await db`insert into sample_data_rows(id,batch,table_name,row_id,key,created_at,updated_at) values(${m.id},${m.batch},${m.table_name},${m.row_id},${m.key},${m.created_at},${m.updated_at})`;
  }
}
const codes = (/** @type {any} */ r) => r.conflicts.map((/** @type {any} */ c) => c.code);
/** Run a dry run and an approving apply; both must refuse with `code`, write nothing and never reach the domain. */
async function expectRefused(/** @type {any} */ opts, /** @type {string} */ code) {
  const before = await counts();
  const fp = await fingerprint();
  const dry = await planKickoffDemo(db, { from: FREE, now, ...opts });
  expect(dry.ok).toBe(false);
  expect(codes(dry)).toContain(code);
  /** @type {string[]} */ const called = [];
  const spy = {
    command: async () => { called.push("command"); },
    recordChange: async () => {},
    actorFor: () => { called.push("actorFor"); return {}; },
    withScopeHooks: (/** @type {any} */ fn) => fn(),
  };
  const err = await applyKickoffDemo(db, { from: FREE, now, approve: true, ...opts }, { coverage: spy }).catch((e) => e);
  expect(err).toBeInstanceOf(KickoffConflict);
  expect(err.report.applied).toBe(false);
  expect(codes(err.report)).toContain(code);
  expect(called).toEqual([]); // no actor was built and no public command issued
  expect(delta(before, await counts())).toEqual({});
  expect(await fingerprint()).toEqual(fp);
}
/** An unrelated REAL-looking account: sales role, a sunpride.test email, but no sample ownership marker. */
async function foreignSales(/** @type {string} */ tag) {
  const [unit] = await db`select org_unit_id as u from profiles where email='agent@sunpride.test'`;
  const [u] = await db`insert into users(email,password_hash) values(${`${tag}@sunpride.test`},'not-a-login') returning id`;
  const [p] = await db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id) values(${u.id},${u.id},${`Foreign ${tag}`},${`${tag}@sunpride.test`},'sales','active',${unit.u}) returning id`;
  return { userId: u.id, profileId: p.id };
}
const rowHash = async (/** @type {string} */ table, /** @type {string[]} */ ids) =>
  (await db.unsafe(`select md5(coalesce(string_agg(t::text,'|' order by t.id::text),'')) as h from ${ident(table)} t where t.id::text = any($1::text[])`, [`{${ids.join(",")}}`]))[0].h;

test("verifiedSample re-derives markers: wrong batch, key or marker id is not sample", async () => {
  const f = await foreignSales("verify-sample");
  try {
    expect((await verifiedSample(db, "profiles", [f.profileId])).size).toBe(0);
    const forged = [
      ["other-batch", `profiles:forged`, rowId("sample_data_rows", "profiles:forged")], // wrong batch
      [BATCH, `profiles:forged`, "11111111-1111-1111-1111-111111111111"], // marker id not derivable
      [BATCH, `outlets:forged`, rowId("sample_data_rows", "outlets:forged")], // key prefix names another table
      [BATCH, `profiles:forged`, rowId("sample_data_rows", "profiles:forged")], // key does not derive this row id
    ];
    for (const [batch, key, id] of forged) {
      await db`insert into sample_data_rows(id,batch,table_name,row_id,key) values(${id},${batch},'profiles',${f.profileId},${key})`;
      expect((await verifiedSample(db, "profiles", [f.profileId])).size).toBe(0);
      await db`delete from sample_data_rows where id=${id}`;
    }
    // the genuine derivation is accepted
    const key = "profiles:verify-sample";
    await db`insert into sample_data_rows(id,batch,table_name,row_id,key) values(${rowId("sample_data_rows", key)},${BATCH},'profiles',${rowId("profiles", "verify-sample")},${key})`;
    expect((await verifiedSample(db, "profiles", [rowId("profiles", "verify-sample")])).size).toBe(1);
    expect((await verifiedSample(db, "profiles", [f.profileId])).size).toBe(0);
  } finally {
    await db`delete from sample_data_rows where key in ('profiles:forged','outlets:forged','profiles:verify-sample')`;
    await db`delete from profiles where id=${f.profileId}`;
    await db`delete from users where id=${f.userId}`;
  }
});

test("non-sample assignee fails closed even with a sunpride.test email or a forged marker", async () => {
  const f = await foreignSales("foreign-assignee");
  try {
    await expectRefused({ assigneeProfileId: f.profileId }, "assignee_not_sample");
    // a marker in the wrong batch / with a non-derivable id does not make it sample
    await db`insert into sample_data_rows(id,batch,table_name,row_id,key) values(${rowId("sample_data_rows", "profiles:forged-a")},'not-the-seed-batch','profiles',${f.profileId},'profiles:forged-a')`;
    await expectRefused({ assigneeProfileId: f.profileId }, "assignee_not_sample");
    // the real sample agent loses its marker -> refused by id and by email alike
    const id = await agentId();
    await withoutMarkers([["profiles", id]], async () => {
      await expectRefused({}, "assignee_not_sample");
      await expectRefused({ assigneeProfileId: id }, "assignee_not_sample");
    });
    // a sample profile whose LOGIN USER is not sample is also refused
    const [{ user_id: uid }] = await db`select user_id from profiles where id=${id}`;
    await withoutMarkers([["users", uid]], () => expectRefused({}, "assignee_not_sample"));
    expect((await planKickoffDemo(db, { from: FREE, now })).ok).toBe(true); // markers restored
  } finally {
    await db`delete from sample_data_rows where key='profiles:forged-a'`;
    await db`delete from profiles where id=${f.profileId}`;
    await db`delete from users where id=${f.userId}`;
  }
});

test("non-sample supervisor, assignment and org unit are refused: it must not approve real plans", async () => {
  const ok = await planKickoffDemo(db, { from: FREE, now });
  const supId = ok.approver.profileId;
  const [{ user_id: supUser }] = await db`select user_id from profiles where id=${supId}`;
  await withoutMarkers([["profiles", supId]], () => expectRefused({}, "approver_not_sample"));
  await withoutMarkers([["users", supUser]], () => expectRefused({}, "approver_not_sample"));
  const [emp] = await db`select id,org_unit_id from employee_assignments where profile_id=${ok.assignee.profileId} and deleted_at is null order by effective_from desc limit 1`;
  await withoutMarkers([["employee_assignments", emp.id]], () => expectRefused({}, "assignee_assignment_not_sample"));
  await withoutMarkers([["org_units", emp.org_unit_id]], () => expectRefused({}, "assignee_assignment_not_sample"));
  expect((await planKickoffDemo(db, { from: FREE, now })).ok).toBe(true);
});

test("non-sample outlets are never planned; requesting one is refused", async () => {
  const ok = await planKickoffDemo(db, { from: FREE, now, approve: true });
  const five = ok.stores;
  expect(five).toHaveLength(5);
  // strip one default store: the plan silently moves to another SAMPLE store, never the unmarked one
  await withoutMarkers([["outlets", five[0].outletId]], async () => {
    const r = await planKickoffDemo(db, { from: FREE, now });
    expect(r.ok).toBe(true);
    expect(r.stores.map((/** @type {any} */ s) => s.code)).not.toContain(five[0].code);
    // asking for it by code is refused with the real reason
    await expectRefused({ stores: five.map((/** @type {any} */ s) => s.code) }, "store_not_sample");
  });
  // no verified store at all: refuse rather than plan an unmarked one
  const all = (await db`select o.id from outlets o`).map((/** @type {any} */ r) => /** @type {[string,string]} */ (["outlets", r.id]));
  await withoutMarkers(all, () => expectRefused({}, "not_enough_eligible_stores"));
});

test("non-sample van target is a conflict, not a quiet skip", async () => {
  const f = await foreignSales("foreign-van");
  try {
    await expectRefused({ vanSellerProfileId: f.profileId }, "van_seller_not_sample");
    const [seller] = await db`select id,user_id from profiles where email='van@sunpride.test'`;
    await withoutMarkers([["profiles", seller.id]], () => expectRefused({}, "van_seller_not_sample"));
    await withoutMarkers([["users", seller.user_id]], () => expectRefused({ vanSellerProfileId: seller.id }, "van_seller_not_sample"));
    // unmarked trucks are not reported as the demo truck
    const ok = await planKickoffDemo(db, { from: FREE, now });
    expect(ok.van.vehicles.length).toBeGreaterThan(0);
    const [veh] = await db`select id from vehicles where vehicle_code=${ok.van.vehicles[0].code}`;
    await withoutMarkers([["vehicles", veh.id]], async () => {
      const r = await planKickoffDemo(db, { from: FREE, now });
      expect(r.van.vehicles.map((/** @type {any} */ v) => v.code)).not.toContain(ok.van.vehicles[0].code);
    });
  } finally {
    await db`delete from profiles where id=${f.profileId}`;
    await db`delete from users where id=${f.userId}`;
  }
});

test("unrelated non-sample records are retained untouched by refusals and by a real apply", async () => {
  const f = await foreignSales("unrelated");
  const mark = await db`select id from sample_data_rows where batch=${BATCH} and table_name='profiles' limit 3`;
  const profileHash = await rowHash("profiles", [f.profileId]);
  const userHash = await rowHash("users", [f.userId]);
  const markersHash = await rowHash("sample_data_rows", mark.map((/** @type {any} */ m) => m.id));
  try {
    await expectRefused({ assigneeProfileId: f.profileId }, "assignee_not_sample");
    const applied = await applyKickoffDemo(db, { from: "2027-06-07", now });
    expect(applied.applied).toBe(true);
    expect(await rowHash("profiles", [f.profileId])).toBe(profileHash);
    expect(await rowHash("users", [f.userId])).toBe(userHash);
    expect(await rowHash("sample_data_rows", mark.map((/** @type {any} */ m) => m.id))).toBe(markersHash);
    expect((await db`select count(*)::int n from coverage_plans where assignee_profile_id=${f.profileId}`)[0].n).toBe(0);
    expect(await fingerprint()).toEqual(baseline);
  } finally {
    await db`delete from profiles where id=${f.profileId}`;
    await db`delete from users where id=${f.userId}`;
  }
});

test("device restriction fails closed, then clears", async () => {
  const id = await agentId();
  const [{ n: unit }] = await db`select org_unit_id as n from profiles where id=${id}`;
  const [d] = await db`insert into registered_devices(profile_id,app,platform,inventory_tag,public_key_spki,key_id,status,bound_subject,org_unit_id)
    values(${id},'field-android','android','kickoff-test-phone','test-only-key',${"a".repeat(64)},'suspended',null,${unit}) returning id`;
  try {
    const before = await counts();
    const r = await planKickoffDemo(db, { from: FREE, now });
    expect(r.conflicts.map((/** @type {any} */ c) => c.code)).toContain("device_not_active");
    expect(await applyKickoffDemo(db, { from: FREE, now }).catch((e) => e)).toBeInstanceOf(KickoffConflict);
    expect(delta(before, await counts())).toEqual({});
    // Bound to a different subject while active is also refused.
    await db`update registered_devices set status='active',bound_subject='someone-else' where id=${d.id}`;
    const r2 = await planKickoffDemo(db, { from: FREE, now });
    expect(r2.conflicts.map((/** @type {any} */ c) => c.code)).toContain("device_bound_to_other_subject");
  } finally {
    await db`delete from registered_devices where id=${d.id}`;
  }
  expect((await planKickoffDemo(db, { from: FREE, now })).ok).toBe(true);
});

test("inactive devices are ignored only with the explicit opt-in; active foreign-bound ones still refuse", async () => {
  const id = await agentId();
  const [{ n: unit }] = await db`select org_unit_id as n from profiles where id=${id}`;
  const [d] = await db`insert into registered_devices(profile_id,app,platform,inventory_tag,public_key_spki,key_id,status,bound_subject,org_unit_id)
    values(${id},'field-android','android','kickoff-test-old-phone','test-only-key',${"b".repeat(64)},'revoked',null,${unit}) returning id`;
  try {
    expect(parseArgs(["--allow-inactive-devices"]).allowInactiveDevices).toBe(true);
    expect((await planKickoffDemo(db, { from: FREE, now })).conflicts.map((/** @type {any} */ c) => c.code)).toContain("device_not_active");
    expect((await planKickoffDemo(db, { from: FREE, now, allowInactiveDevices: true })).ok).toBe(true);
    await db`update registered_devices set status='active',bound_subject='someone-else' where id=${d.id}`;
    expect((await planKickoffDemo(db, { from: FREE, now, allowInactiveDevices: true })).conflicts.map((/** @type {any} */ c) => c.code)).toContain("device_bound_to_other_subject");
  } finally {
    await db`delete from registered_devices where id=${d.id}`;
  }
});

test("apply submit-only: additive, only coverage tables change, supervisor must still approve", async () => {
  const before = await counts();
  const fp = await fingerprint();
  const r = await applyKickoffDemo(db, { from: FREE, now });
  expect(r.applied).toBe(true);
  expect(r.replayed).toBe(false);
  expect(r.verify.plans).toEqual([{ id: r.plans[0], month: "2026-12", status: "submitted", signed: false, capacity: null }]);
  expect(r.verify.slots).toBe(35);
  expect(r.verify.plannedVisitsPerDay).toEqual({});
  const d = delta(before, await counts());
  expect(Object.keys(d).filter((k) => !ALLOWED.has(k))).toEqual([]);
  expect(d.coverage_plans).toBe(1);
  expect(d.coverage_plan_slots).toBe(35);
  expect(d.planned_visits ?? 0).toBe(0);
  // every pre-existing row of the guarded tables is byte-identical, and no row of ours is in sample_data_rows
  expect(await fingerprint()).toEqual(fp);
  expect(fp).toEqual(baseline);
  expect(d.sample_data_rows ?? 0).toBe(0);
});

test("rerun is a no-op (idempotent replay from the real command ledger)", async () => {
  const before = await counts();
  const r = await applyKickoffDemo(db, { from: FREE, now });
  expect(r.replayed).toBe(true);
  expect(r.commandsAdded).toBe(0);
  expect(delta(before, await counts())).toEqual({});
  // our own plan is not reported as an unowned conflict
  const dry = await planKickoffDemo(db, { from: FREE, now });
  expect(dry.ok).toBe(true);
  expect(dry.ownedPlans).toHaveLength(1);
});

test("a different store set under the same window is refused and rolls everything back", async () => {
  const pool = await planKickoffDemo(db, { from: FREE, now, storesPerDay: 8 });
  const other = pool.stores.slice(3, 8).map((/** @type {any} */ s) => s.code);
  const before = await counts();
  const err = await applyKickoffDemo(db, { from: FREE, now, stores: other }).catch((e) => e);
  expect(String(err?.message ?? err)).toMatch(/already used for different content|idempotency/i);
  expect(delta(before, await counts())).toEqual({});
});

test("apply with approval: real supervisor approval; activation waits for the effective date", async () => {
  const before = await counts();
  const r = await applyKickoffDemo(db, { from: FREE, now, approve: true });
  expect(r.commandsAdded).toBe(1); // approve only; create..submit replayed
  expect(r.activation).toEqual(["pending_effective_date_scheduler"]);
  expect(r.verify.plans[0]).toMatchObject({ month: "2026-12", status: "approved", signed: true, capacity: "supervisor" });
  expect(r.verify.plannedVisitsPerDay).toEqual({});
  const d = delta(before, await counts());
  expect(Object.keys(d).filter((k) => !ALLOWED.has(k))).toEqual([]);
  expect(d.planned_visits ?? 0).toBe(0);

  // the real signature binds the real approver and hash
  const [p] = await db`select approval_signature,approved_by,content_hash,approver_profile_id,prepared_by,submitted_by from coverage_plans where id=${r.plans[0]}`;
  const sup = (await db`select id,user_id from profiles where email='supervisor@sunpride.test'`)[0];
  expect(p.approved_by).toBe(sup.user_id);
  expect(p.approver_profile_id).toBe(sup.id);
  expect(p.approved_by).not.toBe(p.prepared_by);
  expect(p.approved_by).not.toBe(p.submitted_by);
  expect(p.approval_signature.endsWith(`:${p.content_hash}`)).toBe(true);
  expect(p.approval_signature.startsWith("sample-trial-sql")).toBe(false);

  // Window start: rerun the helper (replays create..approve) and the domain's own activate command now succeeds.
  const dayOne = Date.parse(`${FREE}T09:00:00+08:00`);
  const fp = await fingerprint();
  const before2 = await counts();
  const act = await applyKickoffDemo(db, { from: FREE, now: dayOne, approve: true });
  expect(act.commandsAdded).toBe(1); // activate only
  expect(act.activation).toEqual(["activated"]);
  expect(act.verify.plans[0]).toMatchObject({ status: "active", signed: true, capacity: "supervisor" });
  expect(Object.values(act.verify.plannedVisitsPerDay)).toEqual([5, 5, 5, 5, 5, 5, 5]);
  expect(Object.keys(act.verify.plannedVisitsPerDay)).toEqual(Array.from({ length: 7 }, (_, i) => addDays(FREE, i)));
  const d2 = delta(before2, await counts());
  expect(Object.keys(d2).filter((k) => !ALLOWED.has(k))).toEqual([]);
  expect(d2.planned_visits).toBe(35);
  expect(d2.coverage_plans ?? 0).toBe(0);
  expect(await fingerprint()).toEqual(fp);
  expect(fp).toEqual(baseline);

  // the same preconditions visits/commands.js enforces for check-in hold for every generated call
  const bad = await db`select v.id from planned_visits v join coverage_plan_slots s on s.id=v.plan_slot_id join coverage_plans c on c.id=v.plan_id
    where v.plan_id=${r.plans[0]} and not (v.status='planned' and v.plan_version=c.version and c.status='active' and c.approval_signature is not null
      and c.active_through is null and v.approved_snapshot=s.approved_snapshot and s.assignee_profile_id=v.assignee_profile_id
      and v.assignee_profile_id=c.assignee_profile_id and (v.approved_snapshot->>'orgUnitId')=c.org_unit_id::text)`;
  expect(bad).toEqual([]);

  // rerun: nothing changes at all
  const before3 = await counts();
  const again = await applyKickoffDemo(db, { from: FREE, now: dayOne, approve: true });
  expect(again.replayed).toBe(true);
  expect(again.commandsAdded).toBe(0);
  expect(delta(before3, await counts())).toEqual({});
  expect((await planKickoffDemo(db, { from: FREE, now: dayOne, approve: true })).ok).toBe(true);
});

test("a window that crosses a month boundary produces one plan per month", async () => {
  const start = Date.parse("2027-03-29T09:00:00+08:00"); // demo day one: both plans are approved, the first can activate
  const r = await applyKickoffDemo(db, { from: "2027-03-29", now: start, approve: true });
  expect(r.plans).toHaveLength(2);
  expect(r.activation).toEqual(["activated", "pending_effective_date_scheduler"]);
  expect(r.verify.plans.map((/** @type {any} */ p) => [p.month, p.status])).toEqual([["2027-03", "active"], ["2027-04", "approved"]]);
  expect(Object.values(r.verify.plannedVisitsPerDay)).toEqual([5, 5, 5]); // Mar 29-31; April waits for its own date
});

test("van/truck leg is read-only and reports the real blocker", async () => {
  const r = await planKickoffDemo(db, { from: FREE, now });
  expect(r.van.createdByHelper).toBe(false);
  expect(r.van.seller).toBe("van@sunpride.test");
  expect(r.van.trips).toEqual([]); // seeded trips end at the anchor date
  expect(r.van.blockers.some((/** @type {string} */ b) => b.startsWith("truck_holds_stock:"))).toBe(true);
  expect(r.van.blockers.some((/** @type {string} */ b) => b.startsWith("no_trip_for:"))).toBe(true);
});

test("CLI: dry run by default; apply needs --confirm-database; URL never printed", async () => {
  const run = async (/** @type {string[]} */ args) => {
    const p = Bun.spawn(["bun", `${import.meta.dir}/kickoff-demo.js`, ...args], {
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, out, err };
  };
  const before = await counts();
  const dry = await run(["--from", addDays(FREE, 40)]);
  expect(dry.code).toBe(0);
  const json = JSON.parse(dry.out);
  expect(json.dryRun).toBe(true);
  expect(json.database).toBe(name);
  expect(dry.out + dry.err).not.toContain(dbUrl);
  const refused = await run(["--apply", "--from", addDays(FREE, 40)]);
  expect(refused.code).toBe(2);
  expect(refused.err).toContain("--confirm-database");
  const wrong = await run(["--apply", "--confirm-database", "other_db", "--from", addDays(FREE, 40)]);
  expect(wrong.code).toBe(2);
  expect(delta(before, await counts())).toEqual({});
}, 60_000);
