import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb } from "../src/client.js";
import { migrate } from "../src/migrate.js";
import { generateDemo, seedDemo, resetDemo } from "./index.js";
import {
  BATCH,
  Dataset,
  at,
  foreignKeys,
  ident,
  plusDays,
  rowId,
  weekday,
} from "./store.js";

const ANCHOR = "2026-10-19";
// F-023 honor the caller lane for isolated migration/seed verification.
const LANE = (process.env.SP_LANE ?? "seed").replace(/[^a-z0-9_]/g, "");
/** @type {import('../src/client.js').Db} */
let db;
/** @type {import('../src/client.js').Db} */
let admin;
let dbUrl = "",
  dbName = "";
/** @type {any} */
let first;
let seedMs = 0;
const sentinel = crypto.randomUUID();

beforeAll(async () => {
  const base = (
    await Bun.file(
      `${process.env.HOME}/.sunpride-keys/pg-lane-${LANE}-url`,
    ).text()
  ).trim();
  dbName = `sunpride_lane_${LANE}_t${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  admin = createDb(base, { max: 1 });
  await admin.unsafe(`create database ${ident(dbName)}`);
  const url = new URL(base);
  url.pathname = `/${dbName}`;
  dbUrl = url.toString();
  db = createDb(dbUrl, { max: 2 });
  await migrate(db);
  await db`insert into users (id,email,password_hash) values (${sentinel},'not-sample@example.test','not-a-login-hash')`;
  await db`insert into sample_data_rows(batch,table_name,row_id,key) values('other-sample-batch','users',${sentinel},'other-user')`;
  const started = performance.now();
  first = await seedDemo(db, { anchorDate: ANCHOR });
  seedMs = performance.now() - started;
  console.log(
    `Seed database proof: ${Math.round(seedMs)}ms, ${Object.values(first.rows).reduce((a, b) => Number(a) + Number(b), 0)} owned rows`,
  );
}, 120_000);

afterAll(async () => {
  try {
    if (db) await db.close();
  } finally {
    if (dbName && admin)
      await admin.unsafe(
        `drop database if exists ${ident(dbName)} with (force)`,
      );
    if (admin) await admin.close();
  }
}, 120_000);

/** @param {string} sql @param {any[]} [params] */
async function number(sql, params = []) {
  return Number((await db.unsafe(sql, params))[0].n);
}
/** Business fingerprint read from Postgres, not from the manifest or generator.
 * @returns {Promise<any>} */
async function fingerprint() {
  const counts =
    await db`select table_name,count(*)::integer as n from sample_data_rows where batch=${BATCH} group by table_name order by table_name`;
  const [sums] = await db`select
    (select sum(round(total*100))::text from orders) as sales,
    (select sum(round(line_total*100))::text from order_lines) as lines,
    (select sum(quantity_delta_base)::text from inventory_ledger_entries) as ledger,
    (select sum(value_delta_minor)::text from inventory_ledger_entries) as value,
    (select sum(amount_minor)::text from field_collections) as collections,
    (select sum(round(value*100))::text from sales_targets) as targets,
    (select count(*)::text from users) as users`;
  return { counts: [...counts], sums };
}

// F-023 every write lives in the caller lane's uniquely named throwaway DB,
// dropped in afterAll; the default remains seed for the historical seed-only harness.
describe("90-day Sunpride demo", () => {
  test("F-020 F-310 additive retail seeding never rewrites the immutable audit manifest", async () => {
    const [before] = await db`select details,updated_at from audit_logs where id=${rowId("audit_logs", "manifest")}`;
    const repeated = await seedDemo(db, { anchorDate: ANCHOR });
    const [after] = await db`select details,updated_at from audit_logs where id=${rowId("audit_logs", "manifest")}`;
    expect(after).toEqual(before);
    expect(repeated.duplicate).toBe(true);
    const counts = await db`select table_name,count(*)::int as n from sample_data_rows where batch=${BATCH} group by table_name`;
    expect(repeated.rows).toEqual(Object.fromEntries(counts.map((r) => [r.table_name, r.n])));
  });
  test("fresh fully migrated database seeds in under sixty seconds", () => {
    expect(seedMs).toBeLessThan(60_000);
    expect(first.products).toBe(40);
    expect(first.agents).toBe(12);
    expect(first.supervisors).toBe(2);
    expect(first.stores).toBe(300);
    expect(first.days).toBe(90);
  });
  test("every generated row is marked and every marker resolves", async () => {
    let total = 0;
    for (const [table, count] of Object.entries(first.rows)) {
      const n = await number(
        `select count(*) as n from ${ident(table)} t join sample_data_rows m on m.row_id=t.id::text and m.table_name=$1 where m.batch=$2`,
        [table, BATCH],
      );
      expect(n).toBe(Number(count));
      total += n;
    }
    expect(
      await number(
        "select count(*) as n from sample_data_rows where batch=$1",
        [BATCH],
      ),
    ).toBe(total);
    expect(
      await number(
        "select count(*) as n from product_barcodes where source <> 'sample'",
      ),
    ).toBe(0);
    expect(
      await number(
        "select count(*) as n from price_lists where source <> 'sample'",
      ),
    ).toBe(0);
    expect(
      await number(
        "select count(*) as n from admin_pack_records where source <> 'sample'",
      ),
    ).toBe(0);
  }, 60_000);
  test("all actual PostgreSQL foreign keys resolve, including nullable and self references", async () => {
    const fks = await foreignKeys(db);
    expect(fks.length).toBeGreaterThan(100);
    for (const f of fks) {
      expect(
        await number(
          `select count(*) as n from ${ident(f.child)} c left join ${ident(f.parent)} p on c.${ident(f.column_name)}=p.${ident(f.parent_column)} where c.${ident(f.column_name)} is not null and p.${ident(f.parent_column)} is null`,
        ),
      ).toBe(0);
    }
  }, 60_000);
  test("balances, lot balances, costs and versions exactly reconcile to ledger", async () => {
    expect(
      await number(`with l as (select product_id,location_id,sum(quantity_delta_base) qty,sum(reserved_delta_base) reserved,sum(value_delta_minor) value,count(*) entries from inventory_ledger_entries group by 1,2)
      select count(*) as n from inventory_balances b full join l using(product_id,location_id)
      where b.id is null or b.physical_base<>coalesce(l.qty,0) or b.available_base<>coalesce(l.qty,0)-coalesce(l.reserved,0) or b.inventory_value_minor<>coalesce(l.value,0) or b.version<>coalesce(l.entries,0)`),
    ).toBe(0);
    expect(
      await number(`with l as (select product_id,location_id,lot_id,stock_status,sum(quantity_delta_base) qty from inventory_ledger_entries group by 1,2,3,4)
      select count(*) as n from inventory_lot_balances b full join l using(product_id,location_id,lot_id,stock_status) where b.id is null or b.physical_base<>l.qty`),
    ).toBe(0);
    expect(
      await number(
        "select count(*) as n from inventory_ledger_entries where quantity_after_base<0 or quantity_before_base+quantity_delta_base<>quantity_after_base",
      ),
    ).toBe(0);
    expect(
      await number(
        `with chain as (select *,lag(quantity_after_base,1,0::bigint) over(partition by product_id,location_id order by balance_version) prior from inventory_ledger_entries) select count(*) as n from chain where prior<>quantity_before_base`,
      ),
    ).toBe(0);
    expect(
      await number(
        `select count(*) as n from inventory_movements m left join inventory_commands c on c.movement_id=m.id where c.id is null`,
      ),
    ).toBe(0);
  }, 60_000);
  test("every order line resolves its product and UOM; totals reconcile to centavos", async () => {
    expect(
      await number(
        `select count(*) as n from order_lines l left join products p on p.code=l.product_code left join units_of_measure u on u.id=p.base_uom_id where p.id is null or u.id is null`,
      ),
    ).toBe(0);
    expect(
      await number(
        `select count(*) as n from field_order_pricing_lines l left join products p on p.id=l.product_id left join units_of_measure u on u.code=l.uom where p.id is null or u.id is null`,
      ),
    ).toBe(0);
    expect(
      await number(
        `select count(*) as n from orders o left join (select order_id,sum(line_total) total from order_lines group by 1) l on l.order_id=o.id where o.total<>l.total or o.subtotal<>l.total`,
      ),
    ).toBe(0);
    expect(
      await number(
        `select count(*) as n from orders o join (select order_id,count(*) n from order_lines group by 1) l on l.order_id=o.id where o.order_type<>'return' and (l.n<2 or l.n>6)`,
      ),
    ).toBe(0);
    expect(
      await number(
        `select count(*) as n from orders where status in ('approved','pending_approval','rejected') and inventory_movement_id is not null`,
      ),
    ).toBe(0);
  });
  test("every visit is on plan or explicitly off-plan; no future completions or overlapping calls", async () => {
    expect(
      await number(
        `select count(*) as n from visit_executions where planned_visit_id is null and (source<>'unplanned' or unplanned_reason is null)`,
      ),
    ).toBe(0);
    expect(
      await number(
        `select count(*) as n from visit_executions v join planned_visits p on p.id=v.planned_visit_id where v.outlet_id<>p.outlet_id or v.assignee_profile_id<>p.assignee_profile_id or v.service_date<>p.service_date`,
      ),
    ).toBe(0);
    expect(
      await number(
        `select count(*) as n from visit_executions where checked_out_at<checked_in_at or checked_out_at>$1`,
        [new Date(at(ANCHOR, 12 * 60))],
      ),
    ).toBe(0);
    expect(
      await number(
        `with calls as (select *,lag(checked_out_at) over(partition by assignee_profile_id,service_date order by checked_in_at) prior_end from visit_executions) select count(*) as n from calls where prior_end>checked_in_at`,
      ),
    ).toBe(0);
    expect(
      await number(
        `select count(*) as n from planned_visits where extract(dow from service_date)=0`,
      ),
    ).toBe(0);
    expect(
      await number(
        `select count(*) as n from coverage_plans where status='active' and (approved_at is null or content_hash is null or approval_signature is null)`,
      ),
    ).toBe(0);
  });
  test("compliance, productivity, weak territory and channel mix meet the headline bounds", async () => {
    const [r] =
      await db`select (select count(*)::numeric from visit_executions where service_date<${ANCHOR})*100/(select count(*) from planned_visits where service_date<${ANCHOR}) as compliance,
      (select count(*)::numeric from visit_executions where service_date<${ANCHOR} and productivity='verified')*100/(select count(*) from visit_executions where service_date<${ANCHOR}) as productive`;
    expect(Math.abs(Number(r.compliance) - 85)).toBeLessThanOrEqual(2);
    expect(Math.abs(Number(r.productive) - 70)).toBeLessThanOrEqual(2);
    const [weak] =
      await db`select (select count(*)::numeric from visit_executions where service_date<${ANCHOR} and org_unit_id=${rowId("org_units", "territory-3")})*100/(select count(*) from planned_visits p join profiles a on a.id=p.assignee_profile_id where p.service_date<${ANCHOR} and a.org_unit_id=${rowId("org_units", "territory-3")}) as pct`;
    expect(Math.abs(Number(weak.pct) - 70)).toBeLessThanOrEqual(2);
    for (const [channel, pct] of [
      ["gt", 60],
      ["pmot", 15],
      ["supermarket", 15],
      ["kas", 10],
    ])
      expect(
        Math.abs(
          (await number(
            "select count(*)*100.0/300 as n from outlets where status='active' and channel=$1",
            [channel],
          )) - Number(pct),
        ),
      ).toBeLessThanOrEqual(2);
    const [agents] =
      await db`select min(compliance) low,max(compliance) high from (select a.id,count(v.id)*100.0/count(p.id) compliance from profiles a join planned_visits p on p.assignee_profile_id=a.id and p.service_date<${ANCHOR} left join visit_executions v on v.planned_visit_id=p.id group by a.id) x`;
    expect(Number(agents.low)).toBeLessThan(77);
    expect(Number(agents.high)).toBeGreaterThan(96);
  });
  test("all four target levels reconcile and company MTD is 92%, Talisay 75%", async () => {
    const month = ANCHOR.slice(0, 7);
    const targets =
      await db`select details::jsonb as d from audit_logs where action='sample.sales_target' and details::jsonb->>'month'=${month}`;
    const totals = ["company", "territory", "channel", "agent"].map((level) =>
      targets
        .filter((/** @type {any} */ r) => r.d.level === level)
        .reduce(
          (/** @type {number} */ n, /** @type {any} */ r) =>
            n + r.d.amountCentavos,
          0,
        ),
    );
    expect(new Set(totals).size).toBe(1);
    const [actual] =
      await db`select sum(round(total*100))::text n from orders where status not in ('draft','rejected','voided') and (created_at at time zone 'Asia/Manila')::date between ${`${month}-01`} and ${ANCHOR}`;
    const days = Array.from({ length: 31 }, (_, i) =>
      plusDays(`${month}-01`, i),
    ).filter((x) => x.startsWith(month) && weekday(x) !== 0);
    const elapsed = days.filter((x) => x <= ANCHOR).length;
    expect(
      Math.abs(
        (Number(actual.n) / ((totals[0] * elapsed) / days.length)) * 100 - 92,
      ),
    ).toBeLessThanOrEqual(2);
    const [weakSales] =
      await db`select sum(round(o.total*100)) n from orders o join profiles p on p.auth_subject=o.salesperson_subject where p.org_unit_id=${rowId("org_units", "territory-3")} and o.status not in ('draft','rejected','voided') and (o.created_at at time zone 'Asia/Manila')::date between ${`${month}-01`} and ${ANCHOR}`;
    const weakTarget = targets.find(
      (/** @type {any} */ r) =>
        r.d.level === "territory" && r.d.key === rowId("territories", "3"),
    ).d.amountCentavos;
    expect(
      Math.abs(
        (Number(weakSales.n) / ((weakTarget * elapsed) / days.length)) * 100 -
          75,
      ),
    ).toBeLessThanOrEqual(2);
  });
  test("owner exceptions: 3 out, 5 low, 2 near expiry, cash short, yesterday unclosed, today active", async () => {
    expect(
      await number(
        `select count(*) as n from inventory_balances b join inventory_locations l on l.id=b.location_id where l.type='warehouse' and b.physical_base=0`,
      ),
    ).toBe(3);
    expect(
      await number(
        `select count(*) as n from inventory_balances b join replenishment_policies r using(product_id,location_id) where b.physical_base>0 and b.physical_base<r.reorder_point_base`,
      ),
    ).toBe(5);
    expect(
      await number(
        `select count(*) as n from inventory_lots where expires_at between $1 and $2`,
        [new Date(at(ANCHOR)), new Date(at(plusDays(ANCHOR, 30)))],
      ),
    ).toBe(2);
    const [short] =
      await db`select details::jsonb d from audit_logs where action='sample.van_settlement' and (details::jsonb->>'cashVarianceMinor')::bigint=-125000`;
    expect(short.d.serviceDate).toBe(plusDays(ANCHOR, -3));
    expect(
      await number(
        "select count(*) as n from van_trips where service_date=$1 and closed_at is null",
        [plusDays(ANCHOR, -1)],
      ),
    ).toBe(1);
    expect(
      await number(
        "select count(*) as n from van_trips where service_date=$1 and status='active'",
        [ANCHOR],
      ),
    ).toBe(2);
    expect(
      await number(
        "select count(*) as n from orders where status='pending_approval'",
      ),
    ).toBe(2);
    expect(
      await number(
        "select count(*) as n from coverage_plans where status='submitted'",
      ),
    ).toBe(1);
    expect(
      await number(
        "select count(*) as n from outlet_enrolments where status='pending'",
      ),
    ).toBe(1);
    expect(
      await number(
        "select count(*) as n from talk_sheet_items where status='overdue'",
      ),
    ).toBeGreaterThan(0);
    expect(
      await number(
        "select count(*) as n from audit_logs where action='sample.per_diem_pending'",
      ),
    ).toBe(3);
    expect(
      await number(
        "select count(*) as n from visit_executions where service_date=$1 and state='in-progress'",
        [ANCHOR],
      ),
    ).toBeGreaterThan(0);
  });
  test("AR snapshots reconcile to source orders, returns and collections", async () => {
    const rows =
      await db`select details from admin_pack_records where period=${ANCHOR.slice(0, 7)} and kind='ar_balance'`;
    let overdue = 0;
    for (const r of rows) {
      const d = r.details;
      const total =
        d.currentMinor +
        d.days1to30Minor +
        d.days31to60Minor +
        d.days61to90Minor +
        d.over90Minor;
      const [raw] =
        await db`select coalesce((select sum(round(o.total*100)) from orders o where o.customer_code=${d.customerCode} and (o.status='posted' or o.order_type='return')),0) - coalesce((select sum(amount_minor) from field_collections where customer_id=${d.customerId}),0) as n`;
      expect(total).toBe(Number(raw.n));
      expect(total).toBe(
        d.invoices.reduce(
          (/** @type {number} */ n, /** @type {any} */ i) =>
            n + i.remainingMinor,
          0,
        ),
      );
      expect(
        d.invoices.every((/** @type {any} */ i) => i.remainingMinor >= 0),
      ).toBe(true);
      overdue += d.days31to60Minor + d.days61to90Minor;
    }
    expect(overdue).toBeGreaterThan(0);
  }, 60_000);
  test("seven real role accounts use Argon2id; owner invitation is pending, not a fake user", async () => {
    const password = (
      await Bun.file(
        `${process.env.HOME}/.sunpride-keys/v2-test-password`,
      ).text()
    ).trim();
    const users =
      await db`select u.password_hash,p.role,u.email from users u join profiles p on p.user_id=u.id order by u.email`;
    expect(users.length).toBe(7);
    for (const user of users) {
      expect(user.password_hash.startsWith("$argon2id$")).toBe(true);
      expect(await Bun.password.verify(password, user.password_hash)).toBe(
        true,
      );
    }
    expect(
      await number(
        "select count(*) as n from users where email='jcing.jc@gmail.com'",
      ),
    ).toBe(0);
    expect(
      await number(
        "select count(*) as n from access_invitations where email='jcing.jc@gmail.com' and status='pending' and role='super_admin'",
      ),
    ).toBe(1);
  }, 30_000);
  test("productive flags are backed by qualifying activities and the truck no-sale marker", async () => {
    expect(
      await number(`with facts as (select v.*,p.code position_code, exists(select 1 from visit_activities a where a.visit_id=v.id and (a.activity_kind in ('order_intent','inventory_check') or a.activity_kind='merchandising' and (p.code not in ('PMOT','PMOT_EXTRUCK') or v.reason_code='no_sales_due_to_inventory'))) qualifies from visit_executions v join profiles f on f.id=v.assignee_profile_id join positions p on p.id=f.position_id where v.state='completed')
      select count(*) as n from facts where (productivity='verified')<>qualifies`),
    ).toBe(0);
    expect(
      await number(
        `select count(*) as n from visit_executions v join profiles p on p.id=v.assignee_profile_id join positions pos on pos.id=p.position_id where pos.code in ('PMOT','PMOT_EXTRUCK') and v.reason_code='no_sales_due_to_inventory' and v.productivity='verified'`,
      ),
    ).toBeGreaterThan(0);
  });
  test("a Sunday cash-short recording uses a real selling trip and never a negative remittance", () => {
    const { data } = generateDemo(
      { anchorDate: "2026-10-21", days: 14 },
      Array(7).fill("unused-pure-fixture-hash"),
    );
    const settlements = data
      .rows("audit_logs")
      .filter((r) => r.action === "sample.van_settlement")
      .map((r) => JSON.parse(r.details));
    const short = settlements.find((r) => r.cashVarianceMinor === -125000);
    expect(short.settlementDate).toBe("2026-10-18");
    expect(short.serviceDate).toBe("2026-10-17");
    expect(settlements.every((r) => r.cashRemittedMinor >= 0)).toBe(true);
    expect(
      data.rows("planned_visits").every((v) => weekday(v.service_date) !== 0),
    ).toBe(true);
  });
  test("company, standards, catalog and priced UOMs retain the source contracts", async () => {
    expect(
      await number(
        "select count(*) as n from org_units where parent_id is null",
      ),
    ).toBe(1);
    expect(await number("select count(*) as n from routes")).toBe(12);
    expect(
      await number("select count(*) as n from profiles where role='sales'"),
    ).toBe(12);
    for (const [code, weekly, monthly] of [
      ["DS", 4, 16],
      ["CDS", 3, 12],
      ["SR_CDS", 1, 4],
    ]) {
      const [r] =
        await db`select s.* from position_standards s join positions p on p.id=s.position_id where p.code=${code}`;
      expect(r.work_with_weekly_min).toBe(weekly);
      expect(r.work_with_monthly_min).toBe(monthly);
      expect(r.productive_call_rule).toBe("any_listed_activity");
    }
    expect(
      await number(
        `select count(*) as n from price_list_lines l join uom_conversions u on u.product_id=l.product_id join price_list_lines pc on pc.price_list_id=l.price_list_id and pc.product_id=l.product_id and pc.uom='PC' where l.uom='CASE' and l.unit_price_minor<>pc.unit_price_minor*u.numerator/u.denominator`,
      ),
    ).toBe(0);
    const promos =
      await db`select rule_kind,rule from promotions where campaign_version_id is null`;
    expect(promos.length).toBe(3);
    for (const p of promos) {
      expect(p.rule.kind).toBe(p.rule_kind);
      expect(p.rule.percentOffBasisPoints).toBe(500);
      expect(
        await number("select count(*) as n from products where id=$1", [
          p.rule.item.productId,
        ]),
      ).toBe(1);
    }
    const campaigns =
      await db`select p.*,v.source as campaign_source from promotions p join campaign_versions v on v.id=p.campaign_version_id`;
    expect(campaigns).toHaveLength(3);
    for (const p of campaigns) {
      expect(p.rule_kind).toBe("basket");
      expect(p.rule.kind).toBe("basket");
      expect(p.status).toBe("inactive");
      expect(p.campaign_source).toBe("sample");
      expect(p.benefit_timing).toBe("claimable");
    }
    expect(await number("select count(*) n from claims")).toBe(3);
    expect(await number("select count(*) n from incentive_statements")).toBe(1);
    for (const r of await db`select barcode from product_barcodes`) {
      const digits = [...r.barcode].map(Number);
      expect(digits.length).toBe(13);
      expect(
        digits.reduce((sum, i, index) => sum + i * (index % 2 ? 3 : 1), 0) % 10,
      ).toBe(0);
    }
    expect(
      await number(
        `select count(*) as n from coverage_plans p where p.status='submitted' and exists(select 1 from coverage_plan_slots s where s.plan_id=p.id)`,
      ),
    ).toBe(1);
  });
  test("canonical order scope and money fields reconcile to their legacy mirrors", async () => {
    expect(
      await number(
        `select count(*) n from orders where org_unit_id is null or salesperson_profile_id is null or outlet_id is null or territory_id is null or channel_key is null or service_date is null or total_centavos<>round(total*100) or total_centavos is null`,
      ),
    ).toBe(0);
  });
  test("field captures do not invent a national warehouse source", async () => {
    expect(
      await number(
        `select count(*) n from orders where order_type in ('field','return') and source_location_id is not null`,
      ),
    ).toBe(0);
    const [supervisor] =
      await db`select p.org_unit_id from profiles p where p.email='supervisor@sunpride.test'`;
    const [agent] =
      await db`select p.org_unit_id from profiles p where p.email='agent@sunpride.test'`;
    expect(supervisor.org_unit_id).toBe(agent.org_unit_id);
  });
  test("stored agent/day money and return metrics reconcile to their source rows", async () => {
    expect(
      await number(`with source as (select p.id profile_id,(o.created_at at time zone 'Asia/Manila')::date date,sum(o.total) sales,count(*) filter(where o.order_type='return') returns from orders o join profiles p on p.auth_subject=o.salesperson_subject where o.status not in ('draft','rejected','voided') group by 1,2)
      select count(*) as n from agent_daily_metrics m left join source s on s.profile_id=m.profile_id and s.date=m.service_date where m.sales_value<>coalesce(s.sales,0) or m.return_orders<>coalesce(s.returns,0)`),
    ).toBe(0);
    expect(
      await number(
        `select count(*) as n from field_collections c join audit_logs a on a.action='sample.collection_allocation' and a.details::jsonb->>'collectionId'=c.id::text cross join lateral jsonb_array_elements(a.details::jsonb->'allocations') alloc join orders o on o.id=(alloc->>'orderId')::uuid where o.created_at>c.created_at`,
      ),
    ).toBe(0);
    const [cadence] =
      await db`select min(n) low,max(n) high from (select trainer_profile_id,count(*) n from work_with_sessions group by 1) s`;
    expect(Number(cadence.high)).toBeGreaterThan(Number(cadence.low) * 3);
    expect(
      await number("select count(*) as n from field_day_reports"),
    ).toBeGreaterThan(100);
  });
  test("Today read-back matches CLI sums and the four requested field states", async () => {
    const [sales] =
      await db`select sum(round(total*100)) filter(where (created_at at time zone 'Asia/Manila')::date=${ANCHOR}) today,sum(round(total*100)) filter(where (created_at at time zone 'Asia/Manila')::date between ${`${ANCHOR.slice(0, 7)}-01`} and ${ANCHOR}) mtd from orders where status not in ('draft','rejected','voided')`;
    expect(Number(sales.today)).toBe(first.salesTodayCentavos);
    expect(Number(sales.mtd)).toBe(first.salesMtdCentavos);
    const board =
      await db`with field as (select p.assignee_profile_id,count(distinct p.id) planned,count(v.id) filter(where v.state='completed') done,count(v.id) filter(where v.state='in-progress') open from planned_visits p left join visit_executions v on v.planned_visit_id=p.id where p.service_date=${ANCHOR} group by 1)
      select case when open>0 then 'in_call' when done=0 then 'not_started' when done=planned then 'done' else 'idle' end status,count(*)::integer n from field group by 1 order by 1`;
    expect(
      Object.fromEntries(board.map((/** @type {any} */ r) => [r.status, r.n])),
    ).toEqual({ not_started: 2, in_call: 5, done: 4, idle: 1 });
    console.log(
      "Verified owner headlines:",
      JSON.stringify({
        anchorDate: ANCHOR,
        seedMs: Math.round(seedMs),
        salesTodayCentavos: Number(sales.today),
        salesMtdCentavos: Number(sales.mtd),
        collectionsTodayCentavos: first.collectionsTodayCentavos,
        field: [...board],
        ownedRows: Object.values(first.rows).reduce(
          (n, v) => Number(n) + Number(v),
          0,
        ),
      }),
    );
  });
  test("repeat invocation is a no-op and changed options fail without modifying anything", async () => {
    const before = await fingerprint();
    expect((await seedDemo(db, { anchorDate: ANCHOR })).duplicate).toBe(true);
    await expect(
      seedDemo(db, { anchorDate: ANCHOR, days: 30 }),
    ).rejects.toThrow("Demo options changed");
    expect(await fingerprint()).toEqual(before);
  }, 30_000);
  test("reset refuses external cascade dependents and rolls the whole reset back", async () => {
    const session = crypto.randomUUID(),
      uid = rowId("users", "agent");
    await db`insert into sessions(id,user_id,token_hash,app,expires_at) values(${session},${uid},${"a".repeat(64)},'web',${new Date(at(plusDays(ANCHOR, 1)))})`;
    const before = await fingerprint();
    await expect(resetDemo(db)).rejects.toThrow(
      "Reset refused: non-sample sessions",
    );
    expect(await fingerprint()).toEqual(before);
    expect(
      await number("select count(*) as n from sessions where id=$1", [session]),
    ).toBe(1);
    await db`delete from sessions where id=${session}`;
  }, 60_000);
  test("reset also preserves legacy outside references that have no declared foreign key", async () => {
    const orderId = crypto.randomUUID(),
      lineId = crypto.randomUUID();
    await db`insert into orders(id,client_request_id,order_number,customer_code,salesperson_subject,status,subtotal,total) values(${orderId},'outside-fixture','OUTSIDE-FIXTURE','OUTSIDE-CUSTOMER','outside-person','approved',0,0)`;
    await db`insert into order_lines(id,order_id,product_code,description,quantity,unit_price,line_total) values(${lineId},${orderId},'SMP-PCH-227','Outside order using a sample product',1,0,0)`;
    const before = await fingerprint();
    await expect(resetDemo(db)).rejects.toThrow(
      "Reset refused: non-sample order_lines references sample products",
    );
    expect(await fingerprint()).toEqual(before);
    expect(
      await number("select count(*) as n from order_lines where id=$1", [
        lineId,
      ]),
    ).toBe(1);
    await db`delete from order_lines where id=${lineId}`;
    await db`delete from orders where id=${orderId}`;
  }, 60_000);
  test("CLI --reset removes exactly owned rows; second fresh run has identical database counts and sums", async () => {
    const before = await fingerprint();
    const proc = Bun.spawn(
      [process.execPath, `${import.meta.dir}/run.js`, "--reset"],
      {
        env: { ...process.env, DATABASE_URL: dbUrl },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = await new Response(proc.stdout).text(),
      stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout).deleted).toBe(
      before.counts.reduce(
        (/** @type {number} */ n, /** @type {any} */ r) => n + r.n,
        0,
      ),
    );
    expect(
      await number(
        "select count(*) as n from sample_data_rows where batch=$1",
        [BATCH],
      ),
    ).toBe(0);
    for (const table of Object.keys(first.rows))
      expect(await number(`select count(*) as n from ${ident(table)}`)).toBe(
        table === "users" ? 1 : 0,
      );
    expect(
      await number("select count(*) as n from users where id=$1", [sentinel]),
    ).toBe(1);
    expect(
      await number(
        "select count(*) as n from sample_data_rows where batch='other-sample-batch' and row_id=$1",
        [sentinel],
      ),
    ).toBe(1);
    const after = await seedDemo(db, { anchorDate: ANCHOR });
    expect(after.rows).toEqual(first.rows);
    expect(await fingerprint()).toEqual(before);
    // Exercise the seed CLI as well, with fixed options and safe machine-readable output.
    const repeat = Bun.spawn(
      [
        process.execPath,
        `${import.meta.dir}/run.js`,
        "--anchor-date",
        ANCHOR,
        "--days",
        "90",
      ],
      {
        env: { ...process.env, DATABASE_URL: dbUrl },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const result = await new Response(repeat.stdout).json();
    expect(await repeat.exited).toBe(0);
    expect(result.duplicate).toBe(true);
    // F-402: the base company CLI cannot silently add a separately owned partner universe.
    expect(await number("select count(*) as n from distributors")).toBe(0);
    expect((await resetDemo(db)).deleted).toBeGreaterThan(100_000);
    // Cold databases must not depend on an autovacuum tick before safe reset joins are planned.
    expect(
      await number(
        "select count(*) as n from pg_stat_user_tables where relname in ('orders','order_lines','execution_events') and last_analyze is null",
      ),
    ).toBe(0);
    expect((await resetDemo(db)).deleted).toBe(0);
  }, 180_000);
});

test("calendar options reject malformed dates, impossible dates and unbounded history", () => {
  for (const date of ["2026-02-30", "2026-13-01", "2026-1-01", "not-a-date"])
    expect(() => new Dataset(date, 90)).toThrow();
  for (const days of [0, -1, 367, 1.5, NaN])
    expect(() => new Dataset(ANCHOR, days)).toThrow();
});
