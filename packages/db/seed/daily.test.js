import { afterAll, beforeAll, expect, test, setSystemTime } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createDb } from "../src/client.js";
import { migrate } from "../src/migrate.js";
import { seedDemo, resetDemo } from "./index.js";
import { advanceDemo } from "./daily.js";
import { createTrialAccounts } from "./trial-accounts.js";
import { BATCH, at, ident, plusDays, rowId, weekday } from "./store.js";

/** @type {import('../src/client.js').Db} */ let db;
/** @type {import('../src/client.js').Db} */ let admin;
let name = "",
  dir = "",
  recordPath = "";
// A stable Tuesday keeps one idle sample truck; Sunday and month openings have explicit cases below.
const today = "2026-10-20",
  anchor = plusDays(today, -3);
/** @type {any} */ let usersBefore;
/** @type {any} */ let devicesBefore;
/** @type {any} */ let sessionsBefore;
/** @type {any} */ let result;
let recordBefore = "";
const fingerprint = (/** @type {any} */ value) =>
  new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
let testerTripBefore = "",
  testerVisitBefore = "",
  testerOrderBefore = "";
const testerCashCount = crypto.randomUUID();
const testerTripId = rowId("van_trips", `${anchor}-0`);
const sentinel = crypto.randomUUID(),
  testerVisit = crypto.randomUUID(),
  testerOrder = crypto.randomUUID();

beforeAll(async () => {
  setSystemTime(new Date(at(today, 12 * 60)));
  const base = (
    await Bun.file(`${process.env.HOME}/.sunpride-keys/pg-lane-core-url`).text()
  ).trim();
  admin = createDb(base, { max: 1 });
  name = `sunpride_lane_core_t${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await admin.unsafe(`create database ${ident(name)}`);
  const url = new URL(base);
  url.pathname = `/${name}`;
  db = createDb(url.toString(), { max: 2 });
  await migrate(db);
  await seedDemo(db, { anchorDate: anchor, days: 7 });
  dir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "sp-daily-"));
  recordPath = join(dir, "accounts.json");
  await createTrialAccounts(db, {
    recordPath,
    outPath: join(dir, "accounts.txt"),
  });
  await db`insert into users(id,email,password_hash) values(${sentinel},'daily-tester@example.test','untouched')`;
  await db`insert into sessions(user_id,token_hash,app,expires_at) values(${sentinel},'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd','web',now()+interval '1 day')`;
  const [device] =
    await db`insert into registered_devices(profile_id,app,platform,inventory_tag,public_key_spki,key_id,status,bound_subject) values(${sentinel},'field-android','android','daily-sentinel-phone','test-only-public-key','dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd','active',${sentinel}) returning id`;
  expect(device.id).toBeTruthy();
  const person = rowId("profiles", "agent");
  const stop = rowId("outlets", "0");
  const [profile] = await db`select * from profiles where id=${person}`;
  await db`insert into visit_executions(id,organization_id,client_visit_id,assignee_profile_id,outlet_id,org_unit_id,service_date,source,state,intents,productivity,last_server_time,checked_in_at,started_at) values(${testerVisit},'sunpride','tester-preserved',${person},${stop},${profile.org_unit_id},${today},'unplanned','in-progress','{}','pending',now(),now(),now())`;
  await db`insert into orders(id,client_request_id,order_number,customer_code,salesperson_subject,status,subtotal,total,organization_id,salesperson_profile_id,outlet_id,service_date) values(${testerOrder},'tester-order-preserved','TESTER-PRESERVED','SMP-C0001',${profile.auth_subject},'draft',86,86,'sunpride',${person},${stop},${today})`;
  await db`insert into van_cash_counts(id,trip_id,expected_centavos,declared_centavos,variance_centavos,facts) values(${testerCashCount},${testerTripId},12345,12000,-345,${{ tester: true }})`;
  testerTripBefore = fingerprint(
    await db`select * from van_trips where id=${testerTripId}`,
  );
  testerVisitBefore = fingerprint(
    await db`select * from visit_executions where id=${testerVisit}`,
  );
  testerOrderBefore = fingerprint(
    await db`select * from orders where id=${testerOrder}`,
  );
  usersBefore = fingerprint(await db`select * from users order by id`);
  devicesBefore = await db`select * from registered_devices order by id`;
  sessionsBefore = await db`select * from sessions order by id`;
  recordBefore = await readFile(recordPath, "utf8");
  setSystemTime(new Date(at(today, 0.5)));
  try {
    result = await advanceDemo(db, { date: today });
  } finally {
    setSystemTime(new Date(at(today, 12 * 60)));
  }
}, 120_000);

afterAll(async () => {
  try {
    await db?.close();
  } finally {
    try {
      if (name && admin) {
        await admin.unsafe(
          `drop database if exists ${ident(name)} with(force)`,
        );
        expect(
          (await admin`select 1 from pg_database where datname=${name}`).length,
        ).toBe(0);
      }
      await admin?.close();
      if (dir) await rm(dir, { recursive: true, force: true });
    } finally {
      setSystemTime();
    }
  }
}, 120_000);

test("fills the gap with visits, orders, collections, posted stock and loaded van trips", async () => {
  expect(result.advanced).toBe(3);
  for (let day = plusDays(anchor, 1); day <= today; day = plusDays(day, 1)) {
    if (weekday(day) === 0) continue;
    const [facts] =
      await db`select (select count(*)::int from orders where service_date=${day} and status<>'draft') orders,(select count(*)::int from visit_executions where service_date=${day}) visits,(select count(*)::int from planned_visits where service_date=${day}) planned,(select count(*)::int from van_trips where service_date=${day}) trips,(select count(*)::int from field_collections where (created_at at time zone 'Asia/Manila')::date=${day}) collections,(select count(*)::int from inventory_movements where source_type='sample' and schema_version=2 and (effective_at at time zone 'Asia/Manila')::date=${day}) movements`;
    expect(facts.orders).toBeGreaterThan(0);
    expect(facts.visits).toBeGreaterThan(0);
    expect(facts.planned).toBeGreaterThan(0);
    expect(facts.trips).toBeGreaterThan(0);
    expect(facts.collections).toBeGreaterThan(0);
    expect(facts.movements).toBeGreaterThan(0);
  }
  const [sales] =
    await db`select sum(total_centavos)::text amount from orders where service_date=${today} and status not in('draft','rejected','voided')`;
  expect(Number(sales.amount)).toBeGreaterThan(10_000_000);
  const [unstarted] =
    await db`select count(*)::int n from planned_visits p where service_date=${today} and not exists(select 1 from visit_executions v where v.planned_visit_id=p.id)`;
  expect(unstarted.n).toBeGreaterThan(0);
  const [future] =
    await db`select count(*)::int n from visit_executions where checked_in_at>now()`;
  expect(future.n).toBe(0);
  const [exceptions] =
    await db`select count(*)::int n from approvals a join workflow_instances w on w.id=a.workflow_id where a.decision='pending' and (w.created_at at time zone 'Asia/Manila')::date=${today}`;
  expect(exceptions.n).toBeGreaterThan(0);
}, 30_000);

test("a run thirty seconds after Manila midnight keeps calls, receipts and stock inside that day and before its clock", async () => {
  const cutoff = new Date(at(today, 0.5));
  const [calls] =
    await db`select count(*)::int n from visit_executions v join sample_data_rows m on m.table_name='visit_executions' and m.row_id=v.id::text and m.batch=${BATCH} where v.service_date=${today} and (v.checked_in_at>${cutoff} or v.checked_out_at>${cutoff} or (v.checked_out_at is not null and v.call_duration_ms<>extract(epoch from (v.checked_out_at-v.checked_in_at))*1000))`;
  expect(calls.n).toBe(0);
  const [stock] =
    await db`select count(*)::int n from inventory_movements where idempotency_key like ${`sample:daily:${today}:%`} and (effective_at<${new Date(at(today))} or effective_at>${cutoff})`;
  expect(stock.n).toBe(0);
  const [receipts] =
    await db`select count(*)::int n from van_sales s join van_trips t on t.id=s.trip_id where t.service_date=${today} and (s.receipt->>'soldAt')::bigint>${cutoff.getTime()}`;
  expect(receipts.n).toBe(0);
});

test("second run and concurrent replays add nothing", async () => {
  const before =
    await db`select table_name,count(*)::int n from sample_data_rows where batch=${BATCH} group by table_name order by table_name`;
  expect((await advanceDemo(db, { date: today })).advanced).toBe(0);
  expect(
    (
      await Promise.all([
        advanceDemo(db, { date: today }),
        advanceDemo(db, { date: today }),
      ])
    ).every((r) => r.advanced === 0),
  ).toBe(true);
  expect(
    await db`select table_name,count(*)::int n from sample_data_rows where batch=${BATCH} group by table_name order by table_name`,
  ).toEqual(before);
});

test("all 27 trial passwords, users, sessions and registered phones remain byte-for-byte unchanged", async () => {
  expect(fingerprint(await db`select * from users order by id`)).toBe(
    usersBefore,
  );
  expect(await db`select * from registered_devices order by id`).toEqual(
    devicesBefore,
  );
  expect(await db`select * from sessions order by id`).toEqual(sessionsBefore);
  expect(await readFile(recordPath, "utf8")).toBe(recordBefore);
  const record = JSON.parse(recordBefore),
    accounts = /** @type {any[]} */ (Object.values(record.databases).flat());
  expect(accounts.length).toBe(31);
  expect(
    accounts.filter((a) => !/^(area|regional)manager/.test(a.email)),
  ).toHaveLength(27);
  expect(
    accounts.filter((a) => /^(area|regional)manager/.test(a.email)),
  ).toHaveLength(4);
  for (const a of accounts) {
    const [u] = await db`select password_hash from users where id=${a.userId}`;
    expect(await Bun.password.verify(a.password, u.password_hash)).toBe(true);
  }
}, 30_000);

test("tester-made calls and orders are untouched and never duplicated by sample work", async () => {
  expect(
    fingerprint(await db`select * from van_trips where id=${testerTripId}`),
  ).toBe(testerTripBefore);
  expect(
    fingerprint(
      await db`select * from visit_executions where id=${testerVisit}`,
    ),
  ).toBe(testerVisitBefore);
  expect(
    fingerprint(await db`select * from orders where id=${testerOrder}`),
  ).toBe(testerOrderBefore);
  const [v] = await db`select * from visit_executions where id=${testerVisit}`;
  expect(v.client_visit_id).toBe("tester-preserved");
  expect(v.state).toBe("in-progress");
  const [o] = await db`select * from orders where id=${testerOrder}`;
  expect(o.client_request_id).toBe("tester-order-preserved");
  expect(Number(o.total)).toBe(86);
  const rows =
    await db`select id from visit_executions where assignee_profile_id=${v.assignee_profile_id} and service_date=${today}`;
  expect(rows.map((/** @type {any} */ r) => r.id)).toEqual([testerVisit]);
  const markers =
    await db`select 1 from sample_data_rows where row_id in (${testerVisit},${testerOrder},${sentinel})`;
  expect(markers.length).toBe(0);
});

test("new sample stock is on the production posting path and its ledger still reconciles", async () => {
  const [n] =
    await db`select count(*)::int n from inventory_movements where schema_version=2 and source_type='sample'`;
  expect(n.n).toBeGreaterThan(0);
  const [bad] =
    await db`select count(*)::int n from inventory_balances b left join(select product_id,location_id,sum(quantity_delta_base) qty,sum(value_delta_minor) value from inventory_ledger_entries group by 1,2) l using(product_id,location_id) where b.physical_base<>coalesce(l.qty,0) or b.inventory_value_minor<>coalesce(l.value,0)`;
  expect(bad.n).toBe(0);
  for (const table of [
    "inventory_movements",
    "inventory_movement_lines",
    "inventory_allocations",
    "inventory_ledger_entries",
    "inventory_commands",
    "inventory_balances",
    "inventory_lot_balances",
    "integration_events",
    "integration_resolution_events",
  ]) {
    const rows = await db.unsafe(
      `select r.id from ${ident(table)} r where not exists(select 1 from sample_data_rows m where m.table_name=$1 and m.row_id=r.id::text and m.batch=$2)`,
      [table, BATCH],
    );
    expect(rows.length).toBe(0);
  }
});

test("daily MCP signatures use the production verifier, route stops are unique, and yesterday's sample trips remit", async () => {
  const modulePath = new URL(
    "../../../apps/api/src/domains/coverage/activation.js",
    import.meta.url,
  ).href;
  const { verifySignature } = await import(modulePath);
  const plans =
    await db`select p.* from coverage_plans p join sample_data_rows m on m.row_id=p.id::text and m.table_name='coverage_plans' where m.key like 'coverage_plans:daily-%' and m.batch=${BATCH}`;
  expect(plans.length).toBeGreaterThan(0);
  for (const plan of plans) expect(() => verifySignature(plan)).not.toThrow();
  const [duplicates] =
    await db`select count(*)::int n from(select assignee_profile_id,service_date,outlet_id,count(*) from planned_visits where service_date>${anchor} group by 1,2,3 having count(*)>1) duplicates`;
  expect(duplicates.n).toBe(0);
  const [closed] =
    await db`select count(*)::int n from van_trips t join van_cash_remittances r on r.trip_id=t.id where t.service_date<${today} and t.status='closed'`;
  expect(closed.n).toBeGreaterThan(0);
  const [pending] =
    await db`select count(*)::int n from integration_events e join inventory_movements m on m.id=e.movement_id where m.schema_version=2 and m.source_type='sample' and e.status in('pending','processing')`;
  expect(pending.n).toBe(0);
});

test("reset refuses tester dependencies, then removes every advanced sample row without deleting other users", async () => {
  await expect(resetDemo(db)).rejects.toThrow("Reset refused");
  // Only these explicit test fixtures are removed. Production automation never does this.
  await db`delete from visit_executions where id=${testerVisit}`;
  await db`delete from orders where id=${testerOrder}`;
  await db`delete from van_cash_counts where id=${testerCashCount}`;
  const advancedFeed =
    await db`select row_id from sample_data_rows where batch=${BATCH} and table_name='change_log'`;
  expect(advancedFeed.length).toBeGreaterThan(0);
  const reset = await resetDemo(db);
  expect(reset.deleted).toBeGreaterThan(0);
  expect(
    (await db`select 1 from sample_data_rows where batch=${BATCH}`).length,
  ).toBe(0);
  for (const table of [
    "orders",
    "planned_visits",
    "visit_executions",
    "van_trips",
    "inventory_movements",
    "inventory_ledger_entries",
  ]) {
    expect(
      (await db.unsafe(`select 1 from ${ident(table)} limit 1`)).length,
      table,
    ).toBe(0);
  }
  for (const row of advancedFeed)
    expect(
      (await db`select 1 from change_log where seq=${row.row_id}`).length,
    ).toBe(0);
  expect((await db`select id from users where id=${sentinel}`).length).toBe(1);
  expect(await db`select * from registered_devices order by id`).toEqual(
    devicesBefore,
  );
}, 60_000);

test("crossing a month creates reconciled positive targets and remains resumable", async () => {
  await seedDemo(db, { anchorDate: "2026-09-30", days: 7 });
  await createTrialAccounts(db, {
    recordPath,
    outPath: join(dir, "accounts.txt"),
  });
  const first = await advanceDemo(db, { date: "2026-10-01" });
  expect(first.advanced).toBe(1);
  const [copied] =
    await db`select count(*)::int n from planned_visits v join profiles p on p.id=v.assignee_profile_id where p.email='van3@trial.sunpride.test' and v.service_date='2026-10-01'`;
  expect(copied.n).toBeGreaterThan(0);
  const second = await advanceDemo(db, { date: "2026-10-03" });
  expect(second.advanced).toBe(2);
  const targets =
    await db`select level,sum(amount_centavos)::text amount from sales_targets where month='2026-10' group by level`;
  const company = Number(
    targets.find((/** @type {any} */ r) => r.level === "company")?.amount,
  );
  expect(company).toBeGreaterThan(0);
  for (const level of ["agent", "territory", "channel"])
    expect(
      Number(targets.find((/** @type {any} */ r) => r.level === level)?.amount),
    ).toBe(company);
  expect((await advanceDemo(db, { date: "2026-10-03" })).advanced).toBe(0);
  await resetDemo(db);
}, 90_000);

test("a Sunday month opening carries a positive budget without inventing Sunday selling", async () => {
  expect(weekday("2026-03-01")).toBe(0);
  await seedDemo(db, { anchorDate: "2026-02-28", days: 7 });
  await advanceDemo(db, { date: "2026-03-01" });
  const [target] =
    await db`select amount_centavos::text amount from sales_targets where month='2026-03' and level='company'`;
  expect(Number(target.amount)).toBeGreaterThan(0);
  for (const table of [
    "orders",
    "planned_visits",
    "visit_executions",
    "van_trips",
  ])
    expect(
      (
        await db.unsafe(`select 1 from ${ident(table)} where service_date=$1`, [
          "2026-03-01",
        ])
      ).length,
    ).toBe(0);
  const result = await advanceDemo(db, { date: "2026-03-02" });
  expect(result.advanced).toBe(1);
  expect(
    Number(
      (
        await db`select amount_centavos::text amount from sales_targets where month='2026-03' and level='company'`
      )[0].amount,
    ),
  ).toBe(Number(target.amount));
  await resetDemo(db);
}, 60_000);
