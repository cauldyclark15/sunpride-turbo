import { afterAll, beforeAll, expect, test } from "bun:test";
import { tx } from "@sunpride/db/client";
import { startHarness, createUser } from "./harness.js";
import { actorFor } from "../src/core/context.js";
import { ensureRoot } from "../src/domains/org/identity.js";
import { install as org } from "../src/domains/org/index.js";
import { commitBudget } from "../src/domains/tpm/campaigns.js";
import { reverseOrder } from "../src/domains/tpm/finance.js";
import { readEvidence } from "../src/domains/tpm/claims.js";
import {
  readTradeInputs,
  demandSignalPage,
  installPlanning,
  tradeRows,
} from "../src/domains/analytics/trade-planning.js";
import { canonicalOutletContext } from "../src/domains/analytics/canonical-context.js";
import { fraudPage } from "../src/domains/analytics/context-adapter.js";
import {
  readPromotionPerformance,
  evaluatePerformance,
  installPerformance,
} from "../src/domains/tpm/performance.js";
import { aggregatePerformance } from "../src/domains/tpm/evaluations.js";
import { manilaDate } from "../src/domains/visits/shared.js";

/** @type {any} */ let h;
/** @type {any} */ let c;
/** @type {any} */ let s;
/** @type {any} */ let d;
const id = () => crypto.randomUUID(),
  order = id(),
  version = id(),
  campaign = id(),
  product = id(),
  outlet = id(),
  visit = id(),
  audit = id(),
  location = id(),
  secondary = id();
const now = Date.now(),
  early = new Date(now - 86400000),
  day = manilaDate(now);
beforeAll(async () => {
  h = await startHarness({ installers: [org] });
  const unit = await ensureRoot(h.db);
  const user = await createUser(
    h,
    "finish-b-finance@example.com",
    "Test-only-finance-fixture",
  );
  const [person] =
    await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id) values(${user},${user},'Sample controller','finish-b-finance@example.com','super_admin','active',${unit}) returning id`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${person.id},${unit},'super_admin',${early},${user},'Sample fixture')`;
  c = {
    db: h.db,
    actor: await actorFor(h.db, user),
    now,
    change: async () => 1,
    publish: () => {},
    url: new URL("http://127.0.0.1/analytics"),
  };
  s = { ids: [unit], ownProfileId: null };
  await h.db`insert into campaigns(id,code) values(${campaign},'SAMPLE-FINISH-B')`;
  await h.db`insert into campaign_versions(id,campaign_id,version,name,mechanic,status,effective_from,effective_to,budget_centavos,expected_volume_base,expected_roi_bps,source,created_by) values(${version},${campaign},1,'Sample campaign','Sample rebate','active',${early},${new Date(now + 86400000)},100,10,1000,'sample',${user})`;
  await h.db`insert into products(id,code,name,category,uom,unit_price,active,organization_id) values(${product},'SAMPLE-FINISH-B','Sample product','Sample','PC',0,true,'sunpride')`;
  await h.db`insert into outlets(id,organization_id,code,name,status,custodian_org_unit_id,classification,created_by) values(${outlet},'sunpride','SAMPLE-FINISH-B','Sample retailer','active',${unit},'A','fixture')`;
  await h.db`insert into visit_executions(id,organization_id,client_visit_id,assignee_profile_id,outlet_id,org_unit_id,service_date,source,intents,state,productivity,last_server_time,checked_in_at,started_at) values(${visit},'sunpride',${id()},${person.id},${outlet},${unit},${day},'unplanned',array['merchandise'],'checked-in','pending',now(),${early},${early})`;
  await h.db`insert into retail_execution_audits(id,visit_id,outlet_id,profile_id,org_unit_id,kind,request_key,payload_hash,captured_at,component_score,facts,actor_subject) values(${audit},${visit},${outlet},${person.id},${unit},'promotion',${id()},'canonical-fixture',now(),100,${{ campaignVersionId: version }},${user})`;
  await h.db`insert into retail_action_cases(audit_id,outlet_id,kind,due_at,facts) values(${audit},${outlet},'incident',now(),${{ category: "Sample incident" }})`;
  [d] =
    await h.db`insert into distributors(code,name,org_unit_id,status,source,partner_kind,effective_from) values('SAMPLE-FINISH-B','Sample distributor',${unit},'accredited','sample','distributor',${early}) returning *`;
  const [master] =
    await h.db`insert into distributor_master_versions(distributor_id,source,source_key,version,payload_hash,payload,effective_from) values(${d.id},'sample','fixture',1,'fixture',${{}},${early}) returning id`;
  await h.db`insert into distributor_outlets(distributor_id,outlet_id,master_version_id,effective_from) values(${d.id},${outlet},${master.id},${early})`;
  await h.db`insert into distributor_locations(id,distributor_id,code,name,kind,effective_from) values(${location},${d.id},'SAMPLE-DEPOT','Sample depot','warehouse',${early})`;
  await h.db`insert into distributor_secondary_lines(id,distributor_id,invoice_number,line_key,revision,source_key,payload_hash,sale_date,kind,outlet_id,product_id,location_id,batch,uom,quantity_base,amount_centavos,quantity_units,units_per_uom) values(${secondary},${d.id},'SAMPLE-0580','1',1,'fixture','fixture',${day},'sale',${outlet},${product},${location},'Sample batch','PC',4,800,4,1)`;
  await h.db`insert into distributor_ingest_runs(distributor_id,source_key,payload_hash,adapter,submitted_by,complete,period_from,period_to) values(${d.id},'SAMPLE-COVERAGE','fixture','api',${person.id},true,${day},${day})`;
  await h.db`insert into distributor_primary_feed_receipts(distributor_id,source_key,version,payload_hash,period_from,period_to,source) values(${d.id},'SAMPLE-COVERAGE',1,'fixture',${day},${day},'sample')`;
  await h.db`insert into distributor_primary_movements(distributor_id,source_key,version,movement_date,product_id,quantity_base,kind,source,received_at) values(${d.id},'SAMPLE-SHIPMENT',1,${day},${product},10,'shipment','sample',now())`;
  const [stock] =
    await h.db`insert into distributor_stock_declarations(distributor_id,stock_date,revision,request_key,payload_hash,source,submitted_by) values(${d.id},${day},1,'fixture','fixture','portal',${person.id}) returning id`;
  await h.db`insert into distributor_stock_lines(declaration_id,product_id,location_id,batch,expiry,uom,quantity_base) values(${stock.id},${product},${location},'Sample batch','2027-01-01','PC',6)`;
}, 60000);
afterAll(async () => {
  await h?.close();
});
test("F-501 a void releases original spend once without deleting its reservation", async () => {
  const first = await tx(h.db, (db) =>
    commitBudget(
      { ...c, db },
      {
        campaignVersionId: version,
        amountCentavos: 100,
        sourceKey: `earned:order:${order}:promotion:sample`,
      },
    ),
  );
  await expect(
    tx(h.db, (db) =>
      commitBudget(
        { ...c, db },
        { campaignVersionId: version, amountCentavos: 1, sourceKey: "extra" },
      ),
    ),
  ).rejects.toThrow("budget");
  await tx(h.db, (db) => reverseOrder({ ...c, db }, order));
  await tx(h.db, (db) => reverseOrder({ ...c, db }, order));
  const [balance] =
    await h.db`select amount_centavos from campaign_commitment_balances where id=${first.id}`;
  expect(Number(balance.amount_centavos)).toBe(0);
  const [releases] =
    await h.db`select count(*)::int n from campaign_commitment_releases where commitment_id=${first.id}`;
  expect(releases.n).toBe(1);
  expect(
    (
      await tx(h.db, (db) =>
        commitBudget(
          { ...c, db },
          {
            campaignVersionId: version,
            amountCentavos: 100,
            sourceKey: "replacement",
          },
        ),
      )
    ).id,
  ).toBeTruthy();
});
test("F-506 canonical campaign checklist and corrected secondary sources support evidence validation", async () => {
  const checklist = await readEvidence(c, "checklist", audit);
  expect(checklist.campaignVersionId).toBe(version);
  expect(checklist.fingerprint).toContain("canonical-fixture");
  const sale = await readEvidence(c, "secondary_sale", secondary);
  expect(sale.amountCentavos).toBe(800);
  expect(sale.quantityBase).toBe("4");
  expect(sale.partyId).toBe(d.id);
});
test("F-603 F-607 canonical shipments declarations and secondary invoices feed tower directly", async () => {
  const facts = await readTradeInputs(
    h.db,
    { from: day, to: day, channel: null },
    s,
  );
  expect(facts.map((/** @type {any} */ f) => f.kind).sort()).toEqual([
    "primary",
    "secondary",
    "stock",
  ]);
  const rows = tradeRows(facts, 1);
  expect(rows[0].primaryBase).toBe(10);
  expect(rows[0].secondaryBase).toBe(4);
  expect(rows[0].stockBase).toBe(6);
  expect(rows[0].daysInventory).toBe(1.5);
  expect(rows[0].primaryCentavos).toBeNull();
  expect(
    await readTradeInputs(
      h.db,
      { from: day, to: day, channel: null },
      { ids: [id()], ownProfileId: null },
    ),
  ).toEqual([]);
});
test("F-607 planning consumes current governed campaign eligibility without multiplying its volume target", async () => {
  const [scheme] =
    await h.db`insert into promotions(organization_id,code,name,rule_kind,rule,status,source,effective_from,effective_to,campaign_version_id,eligibility) values('sunpride','SAMPLE-PLAN','Sample planned offer','value_off',${{ kind: "value_off", item: { productId: product, uom: "PC", quantity: 1 }, valueCentavos: 1 }},'active','sample',${early},${new Date(now + 86400000)},${version},${{ outletId: { include: [outlet] } }}) returning id`;
  const period = { from: day, to: day, channel: null, days: 1 };
  const page = await demandSignalPage(c, period, s);
  expect(page.rows[0].promotionPlans).toHaveLength(1);
  expect(page.rows[0].promotionPlans[0]).toMatchObject({
    sourceId: version,
    campaignExpectedBase: 10,
    plannedBase: null,
    source: "campaign_versions",
    sample: true,
  });
  expect(page.completeness.promotionPlans).toBe(true);
  const [snapshot] =
    await h.db`insert into demand_signal_snapshots(org_unit_id,created_by,period_from,period_to,cutoff_at,definition_version,request_key,request_hash,content_hash,payload,status) values(${s.ids[0]},${c.actor.profileId},${day},${day},now(),'commercial/v1','sample-plan','sample','sample',${page},'prepared') returning id`;
  const handlers = new Map();
  installPlanning(
    {
      get: (/** @type {string} */ path, /** @type {any} */ fn) =>
        handlers.set(path, fn),
      post: () => {},
    },
    {},
  );
  const read = () =>
    handlers.get("/api/v1/planning/demand-signals/snapshot")({
      ...c,
      url: new URL("http://127.0.0.1/snapshot?id=" + snapshot.id),
    });
  expect((await read()).payload.rows[0].promotionPlans).toHaveLength(1);
  await h.db`update promotions set eligibility=${{ outletId: { exclude: [outlet] } }} where id=${scheme.id}`;
  await expect(read()).rejects.toThrow("Campaign access changed");
  expect((await demandSignalPage(c, period, s)).rows[0].promotionPlans).toEqual(
    [],
  );
  await h.db`update promotions set eligibility=${{}} where id=${scheme.id}`;
  await h.db`update distributor_outlets set effective_to=now() where distributor_id=${d.id}`;
  expect((await demandSignalPage(c, period, s)).rows[0].promotionPlans).toEqual(
    [],
  );
});
test("F-508 governed margins join complete canonical secondary periods and weighted ROI without inventing missing feeds", async () => {
  const endpoints = new Map(),
    jobs = new Map();
  /** @type {any[][]} */ const schedules = [];
  installPerformance(
    {
      get: (/** @type {string} */ path, /** @type {any} */ fn) =>
        endpoints.set(path, fn),
      post: (/** @type {string} */ path, /** @type {any} */ fn) =>
        endpoints.set(path, fn),
    },
    {
      registerJob: (/** @type {string} */ name, /** @type {any} */ fn) =>
        jobs.set(name, fn),
      scheduler: {
        daily: (/** @type {any[]} */ ...args) => schedules.push(args),
      },
      publish: async () => {},
    },
  );
  const input = {
    campaignVersionId: version,
    distributorId: d.id,
    productId: product,
    unitMarginCentavos: 50,
    otherCostCentavos: 100,
    marginReference: "SAMPLE margin per base unit",
    costReference: "SAMPLE allocated cost",
    source: "sample",
    idempotencyKey: id(),
  };
  const saved = await endpoints.get("/api/v1/tpm/roi/policy")({
    ...c,
    body: input,
  });
  expect(saved.accountKey).toBe(d.code);
  const q = { campaignVersionId: version, accountKey: d.code };
  await h.db`update campaign_versions set effective_to=${new Date(now)} where id=${version}`;
  await expect(readPromotionPerformance(c, q)).rejects.toThrow("feeds");
  const before = manilaDate(now - 3 * 86400000);
  await h.db`insert into distributor_ingest_runs(distributor_id,source_key,payload_hash,adapter,submitted_by,complete,period_from,period_to) values(${d.id},'SAMPLE-ROI-COVERAGE','roi-fixture','api',${c.actor.profileId},true,${before},${day})`;
  await h.db`insert into distributor_secondary_lines(distributor_id,invoice_number,line_key,revision,source_key,payload_hash,sale_date,kind,outlet_id,product_id,location_id,batch,uom,quantity_base,amount_centavos,quantity_units,units_per_uom) values(${d.id},'SAMPLE-BASELINE','1',1,'roi-fixture','roi-fixture',${before},'sale',${outlet},${product},${location},'Sample batch','PC',2,400,2,1)`;
  const facts = await readPromotionPerformance(c, q);
  expect(facts).toMatchObject({
    baselineVolumeBase: 2,
    promotedVolumeBase: 4,
    incrementalMarginCentavos: 100,
    otherCostCentavos: 100,
    sample: true,
    spendCompleteness: "complete",
  });
  const result = await tx(h.db, (db) => evaluatePerformance({ ...c, db }, q));
  expect(result.result).toMatchObject({
    incrementalVolumeBase: 2,
    grossRoiBps: 10000,
    netRoiBps: 0,
    spendCentavos: 100,
  });
  expect(
    (await tx(h.db, (db) => evaluatePerformance({ ...c, db }, q))).id,
  ).toBe(result.id);
  const row = (
    await h.db`select e.*,v.name as campaign_name from promotion_evaluations e join campaign_versions v on v.id=e.campaign_version_id where e.id=${result.id}`
  )[0];
  expect(
    aggregatePerformance([row])
      .map((r) => r.dimension)
      .sort(),
  ).toEqual(["account", "campaign", "mechanic"]);
  expect(schedules[0].slice(0, 3)).toEqual([
    "04:00",
    "Asia/Manila",
    "tpm.roi.closed",
  ]);
  await schedules[0][3]({ db: h.db });
  const queued = (
    await h.db`select payload from jobs where kind='tpm.roi.queue'`
  )[0];
  expect(queued.payload.day).toBe(day);
  await h.db`update campaign_versions set effective_from=${new Date(now - 33 * 86400000)},effective_to=${new Date(now - 31 * 86400000)} where id=${version}`;
  await jobs.get("tpm.roi.queue")({ db: h.db, payload: queued.payload });
  const evaluationJob = (
    await h.db`select payload from jobs where kind='tpm.roi.evaluate'`
  )[0];
  expect(evaluationJob.payload).toEqual(q);
  await h.db`update distributors set status='suspended' where id=${d.id}`;
  await expect(readPromotionPerformance(c, q)).rejects.toThrow("access");
});
test("F-604 Outlet 360 reads actual retail actions and canonical classification", async () => {
  const context = await canonicalOutletContext(
    h.db,
    { from: day, to: day },
    s,
    { id: outlet },
  );
  expect(context.classification?.label).toBe("Class A");
  expect(context.issues[0].label).toBe("incident");
  expect(context.issues[0].status).toBe("open");
});
test("F-606 tower shows canonical findings and the owner's current disposition", async () => {
  const [policy] =
    await h.db`select id from integrity_policy_versions where code='field-integrity' order by effective_from desc limit 1`;
  const [finding] =
    await h.db`insert into integrity_findings(rule,source_key,policy_id,profile_id,org_unit_id,outlet_id,evidence,severity,occurred_at) values('impossible_travel','SAMPLE-FINISH-B',${policy.id},${c.actor.profileId},${c.actor.orgUnitId},${outlet},${{ sample: true }},'high',now()) returning id`;
  await h.db`insert into integrity_dispositions(finding_id,decided_by,outcome,reason_code) values(${finding.id},${c.actor.userId},'false_positive','sample_review')`;
  const page = await fraudPage(c, { from: day, to: day, channel: null }, s);
  expect(page.rows.find((r) => r.id === finding.id)?.status).toBe("dismissed");
  expect(page.rows.find((r) => r.id === finding.id)?.reviewHref).toBe(
    "/field-integrity",
  );
});
