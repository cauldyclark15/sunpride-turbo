import { beforeAll, afterAll, test, expect } from "bun:test";
import { startHarness } from "./harness.js";
import { analyticsFixture } from "./analytics-fixture.js";
import { install } from "../src/domains/analytics/index.js";
import {
  evaluateAlerts,
  deliverAlert,
} from "../src/domains/analytics/alerts.js";
import { runDueJobs } from "../src/core/jobs.js";
/** @type {any} */ let h;
/** @type {any} */ let f;
beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  f = await analyticsFixture(h);
});
afterAll(async () => {
  await h?.close();
});
/** @param {string} path */
async function get(path) {
  const r = await f.get("/api/v1/analytics/" + path);
  expect(r.status).toBe(200);
  return r.json();
}

test("F-602 stocking is not buying and incomplete assigned MSL stays unknown", async () => {
  await h.db`insert into analytics_cockpit_policies(org_unit_id,freshness_days,effective_from,source_ref) values(${f.a},7,'2020-01-01','fixture'),(${f.b},7,'2020-01-01','fixture')`;
  const [product] = await h.db`select id from products where code='P1'`;
  const [second] = await h.db`select id from products where code='P2'`;
  const [list] =
    await h.db`insert into outlet_assortments(organization_id,outlet_id,source_ref,effective_from,actor_subject) values('fixture',${f.store},'fixture','2020-01-01','fixture') returning id`;
  await h.db`insert into outlet_assortment_products(outlet_assortment_id,ordinal,product_id) values(${list.id},0,${product.id}),(${list.id},1,${second.id})`;
  const [audit] =
    await h.db`insert into merchandising_audits(organization_id,org_unit_id,client_audit_id,visit_id,outlet_id,assignee_profile_id,service_date,device_time,server_time,payload_hash,audit_version,required_count,required_available_count,required_out_of_stock_count,actor_subject,source) values('fixture',${f.a},'tower-audit',${f.visit},${f.store},${f.agent},${f.today},now(),now(),'fixture','1',2,1,0,'fixture','web') returning id`;
  await h.db`insert into merchandising_availability(organization_id,org_unit_id,audit_id,outlet_id,product_id,service_date,required,status) values('fixture',${f.a},${audit.id},${f.store},${product.id},${f.today},true,'available')`;
  const c = await get(`coverage-availability?from=${f.today}&to=${f.today}`);
  expect(c.required).toBe(2);
  expect(c.checked).toBe(1);
  expect(c.osa).toBeNull();
  expect(c.completenessPct).toBe(50);
  const distribution = c.distribution.find(
    (/** @type {any} */ r) => r.productId === product.id,
  );
  expect(distribution.stocking).toBe(1);
  expect(distribution.unmeasured).toBe(299);
  expect(distribution.numericDistributionPct).toBeNull();
  const stock = await get(`stock?from=${f.today}&to=${f.today}`);
  expect(
    stock.rows.find((/** @type {any} */ r) => r.productId === product.id)
      .buyingReachPct,
  ).toBe(100);
  expect(
    stock.rows.find((/** @type {any} */ r) => r.productId === product.id)
      .numericDistributionPct,
  ).toBeNull();
});

test("F-603 F-607 source-grained sell-in sell-out stock and frozen planning lineage reconcile with idempotency and current scope", async () => {
  const [product] = await h.db`select id from products where code='P1'`;
  for (const [kind, quantity, amount] of [
    ["primary", 48, 48000],
    ["secondary", 24, 24000],
    ["stock", 72, null],
    ["promotion_plan", 12, 12000],
  ])
    await h.db`insert into analytics_trade_inputs(kind,source_system,source_key,source_revision,source_received_at,source_effective_at,source_type,org_unit_id,distributor_key,distributor_name,outlet_id,product_id,service_date,quantity_base,amount_centavos,lineage,campaign_ref) values(${kind},'fixture',${kind},'1',now(),now(),'sample',${f.a},'D1','Sample Distributor',${kind === "secondary" ? f.store : null},${product.id},${f.today},${quantity},${amount},${{ fixture: true }},'SAMPLE-PLAN')`;
  const page = await get(`primary-secondary?from=${f.today}&to=${f.today}`);
  expect(page.rows).toHaveLength(1);
  expect(page.rows[0].primaryBase).toBe(48);
  expect(page.rows[0].secondaryBase).toBe(24);
  expect(page.rows[0].daysInventory).toBe(3);
  expect(page.kpis[0].value).toBe(48000);
  expect(page.kpis[1].value).toBe(24000);
  expect(page.demo).toBe(true);
  const payload = {
    requestKey: "planning-cut",
    from: f.today,
    to: f.today,
    unitId: f.a,
  };
  const first = await (
    await f.post("/api/v1/planning/demand-signals/prepare", payload)
  ).json();
  expect(first.status).toBe("prepared");
  const replay = await (
    await f.post("/api/v1/planning/demand-signals/prepare", payload)
  ).json();
  expect(replay.id).toBe(first.id);
  expect(replay.duplicate).toBe(true);
  const changed = await f.post("/api/v1/planning/demand-signals/prepare", {
    ...payload,
    from: f.start,
  });
  expect(changed.status).toBe(409);
  const frozen = await (
    await f.get(`/api/v1/planning/demand-signals/snapshot?id=${first.id}`)
  ).json();
  expect(frozen.payload.lineage).toHaveLength(4);
  expect(frozen.payload.rows[0].promotionPlans).toHaveLength(1);
  const published = await f.post("/api/v1/planning/demand-signals/transition", {
    id: first.id,
    action: "publish",
    destination: "Sample Supply Chain inbox",
  });
  expect(published.status).toBe(200);
  expect(
    (
      await f.post("/api/v1/planning/demand-signals/transition", {
        id: first.id,
        action: "accept",
        reference: "fixture",
      })
    ).status,
  ).toBe(403);
  await h.db`update profiles set org_unit_id=${f.b},role='manager' where id=${f.boss}`;
  expect(
    (await f.get(`/api/v1/planning/demand-signals/snapshot?id=${first.id}`))
      .status,
  ).toBe(403);
  await h.db`update profiles set org_unit_id=${f.root},role='super_admin' where id=${f.boss}`;
});

test("F-606 surface consumes versioned signals and refuses foreign current owners without implementing detectors", async () => {
  await h.db`insert into analytics_integrity_findings(org_unit_id,outlet_id,source_system,source_key,source_revision,source_type,rule_code,rule_version,severity,title,detail,status,occurred_at,evidence,review_href) values(${f.a},${f.store},'fixture','signal','1','sample','fixture','1','high','Sample signal','Not guilt','open',now(),${{ source: "sample" }},'/decide')`;
  const page = await get(`fraud?from=${f.today}&to=${f.today}&unitId=${f.a}`);
  expect(page.rows).toHaveLength(1);
  expect(page.rows[0].sample).toBe(true);
  await h.db`update territory_ownerships set effective_to=now() where territory_id in(select territory_id from outlet_assignments where outlet_id=${f.store}) and effective_to is null`;
  // Custodian remains A; explicitly transfer both persisted ownership and fallback.
  const [assignment] =
    await h.db`select territory_id from outlet_assignments where outlet_id=${f.store}`;
  await h.db`insert into territory_ownerships(territory_id,org_unit_id,effective_from,actor_subject,reason) values(${assignment.territory_id},${f.b},now(),'fixture','transfer')`;
  expect(
    (await get(`fraud?from=${f.today}&to=${f.today}&unitId=${f.a}`)).rows,
  ).toHaveLength(0);
});

test("F-608 concurrent evaluation deduplicates; cooldown retries and permission withdrawal protect both app and email sink", async () => {
  const sub = await f.post("/api/v1/alerts/subscribe", {
    unitId: f.root,
    metric: "integrity_open",
    threshold: 0,
    cooldownMinutes: 60,
    inApp: true,
    email: true,
    enabled: true,
  });
  expect(sub.status).toBe(200);
  const results = await Promise.all([
    evaluateAlerts(h.db),
    evaluateAlerts(h.db),
    evaluateAlerts(h.db),
  ]);
  expect(results.reduce((n, r) => n + r.queued, 0)).toBe(1);
  await runDueJobs(h.db);
  const inbox = await (await f.get("/api/v1/alerts")).json();
  expect(inbox.rows).toHaveLength(1);
  const mail = await (await f.get("/api/v1/alerts/mail-sink")).json();
  expect(mail.rows).toHaveLength(1);
  await deliverAlert(h.db, inbox.rows[0].id);
  expect((await h.db`select id from analytics_mail_sink`).length).toBe(1);
  expect((await evaluateAlerts(h.db)).queued).toBe(0);
  expect(
    (await f.post("/api/v1/alerts/read", { id: inbox.rows[0].id })).status,
  ).toBe(200);
  expect((await (await f.get("/api/v1/alerts")).json()).rows[0].read).toBe(
    true,
  );
  const later = Date.now() + 61 * 60000;
  expect((await evaluateAlerts(h.db, later)).queued).toBe(1);
  const [pending] =
    await h.db`select id from analytics_alert_instances where status='pending'`;
  await h.db`update profiles set status='disabled' where id=${f.boss}`;
  await deliverAlert(h.db, pending.id, undefined, later);
  expect(
    (
      await h.db`select status from analytics_alert_instances where id=${pending.id}`
    )[0].status,
  ).toBe("suppressed");
  expect((await h.db`select id from analytics_mail_sink`).length).toBe(1);
  await h.db`update profiles set status='active' where id=${f.boss}`;
});

test("F-601 Excel HTTP export is a real ZIP workbook for every existing and new cockpit, never a renamed CSV", async () => {
  for (const page of [
    "today",
    "sales",
    "coverage",
    "stores",
    "stock",
    "vans",
    "money",
    "exceptions",
    "primary-secondary",
    "coverage-availability",
    "fraud",
    "demand-signals",
  ]) {
    const r = await f.get(
      `/api/v1/analytics/${page}?format=xlsx&from=${f.today}&to=${f.today}`,
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("spreadsheetml");
    const bytes = Buffer.from(await r.arrayBuffer());
    expect(bytes.subarray(0, 4).toString("hex")).toBe("504b0304");
    expect(bytes.toString()).toContain("xl/workbook.xml");
  }
});

test("F-608 failed mail delivery is retried without duplicate app/mail delivery or retained provider diagnostics", async () => {
  const [sub] =
    await h.db`select id from analytics_alert_subscriptions where profile_id=${f.boss} and metric='integrity_open'`;
  const [alert] =
    await h.db`insert into analytics_alert_instances(subscription_id,fingerprint,title,payload,status) values(${sub.id},'retry-fixture','Sample retry',${{}},'pending') returning id`;
  await expect(
    deliverAlert(h.db, alert.id, async () => {
      throw new Error("Private provider diagnostic");
    }),
  ).rejects.toMatchObject({ code: "delivery_retry" });
  expect(
    (
      await h.db`select outcome from analytics_alert_attempts where alert_id=${alert.id}`
    )[0].outcome,
  ).toBe("retry");
  expect(
    (await h.db`select id from analytics_mail_sink where alert_id=${alert.id}`)
      .length,
  ).toBe(0);
  await deliverAlert(h.db, alert.id);
  await deliverAlert(h.db, alert.id);
  expect(
    (await h.db`select id from analytics_mail_sink where alert_id=${alert.id}`)
      .length,
  ).toBe(1);
  expect(
    (
      await h.db`select status from analytics_alert_instances where id=${alert.id}`
    )[0].status,
  ).toBe("delivered");
});

test("F-607 F-608 malformed commands and identifiers fail before SQL without partial writes", async () => {
  for (const path of [
    "/api/v1/planning/demand-signals/prepare",
    "/api/v1/planning/demand-signals/transition",
    "/api/v1/analytics/policies/set",
    "/api/v1/analytics/turnover/set",
    "/api/v1/alerts/subscribe",
    "/api/v1/alerts/read",
  ]) {
    const response = await f.post(path, null);
    expect(response.status, path).toBe(400);
  }
  expect(
    (
      await f.post("/api/v1/planning/demand-signals/transition", {
        id: "not-a-uuid",
        action: "publish",
      })
    ).status,
  ).toBe(400);
  expect(
    (await f.post("/api/v1/alerts/read", { id: "not-a-uuid" })).status,
  ).toBe(400);
  expect(
    (await f.get("/api/v1/planning/demand-signals/snapshot?id=not-a-uuid"))
      .status,
  ).toBe(400);
});

test("F-603 F-607 source corrections replace current measures while frozen cuts retain lineage and recheck current source grants", async () => {
  const page = await get(
      `primary-secondary?from=${f.today}&to=${f.today}&unitId=${f.a}`,
    ),
    before = page.kpis.find(
      (/** @type {any} */ k) => k.key === "primary",
    ).value;
  const [source] =
    await h.db`select id from analytics_trade_inputs where kind='primary' and org_unit_id=${f.a} limit 1`;
  const prepared = await (
    await f.post("/api/v1/planning/demand-signals/prepare", {
      requestKey: "revision-cut",
      from: f.today,
      to: f.today,
      unitId: f.a,
    })
  ).json();
  const read = () =>
    f.get(
      `/api/v1/planning/demand-signals/snapshot?id=${prepared.id}&unitId=${f.a}`,
    );
  const frozen = await (await read()).json();
  expect(
    frozen.payload.lineage.some((/** @type {any} */ r) => r.id === source.id),
  ).toBe(true);
  const [newer] =
    await h.db`update analytics_trade_inputs set source_revision='2',source_received_at=now(),updated_at=now(),amount_centavos=amount_centavos+100 where id=${source.id} returning id`;
  const current = await get(
    `primary-secondary?from=${f.today}&to=${f.today}&unitId=${f.a}`,
  );
  expect(
    current.kpis.find((/** @type {any} */ k) => k.key === "primary").value,
  ).toBe(before + 100);
  const stillAllowed = await read();
  expect(stillAllowed.status).toBe(200);
  const retained = await stillAllowed.json();
  expect(retained.contentHash).toBe(frozen.contentHash);
  expect(retained.payload).toEqual(frozen.payload);
  await h.db`update analytics_trade_inputs set source_revision='3',source_received_at=now(),updated_at=now(),org_unit_id=${f.b} where id=${newer.id}`;
  const withdrawn = await get(
    `primary-secondary?from=${f.today}&to=${f.today}&unitId=${f.a}`,
  );
  expect(
    withdrawn.kpis.find((/** @type {any} */ k) => k.key === "primary").value,
  ).toBeNull();
  expect((await read()).status).toBe(403);
  expect(
    (await f.get(`/api/v1/planning/demand-signals/snapshot?id=${prepared.id}`))
      .status,
  ).toBe(200);
});
