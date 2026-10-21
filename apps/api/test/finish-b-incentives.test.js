import { test, expect } from "bun:test";
import { startHarness, createUser } from "./harness.js";
import { install as tpm } from "../src/domains/tpm/index.js";
import { install as org } from "../src/domains/org/index.js";
import { ensureRoot } from "../src/domains/org/identity.js";
import { actorFor } from "../src/core/context.js";
import { sha256Hex } from "../src/core/util.js";
import { readIncentiveMetrics } from "../src/domains/tpm/metric-sources.js";
import { computeIncentive } from "../src/domains/tpm/evaluations.js";

test("F-510 calculates canonical sales, excludes zero-weight facts, and fences earned statements to their own employee", async () => {
  const h = await startHarness({ installers: [org, tpm] });
  try {
    const unit = await ensureRoot(h.db);
    /** @param {string} name @param {string} role */
    async function person(name, role) {
      const email = `sample-incentive-${name}@example.com`,
        user = await createUser(h, email, "Test-only-incentive-fixture");
      const [p] =
        await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id)values(${user},${user},${"Sample " + name},${email},${role},'active',${unit})returning id`;
      await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason)values(${p.id},${unit},${role},'2020-01-01',${user},'Sample fixture')`;
      const token = "sps_" + crypto.randomUUID().replaceAll("-", "");
      await h.db`insert into sessions(user_id,token_hash,app,expires_at)values(${user},${sha256Hex(token)},'web',now()+interval '1 day')`;
      return {
        user,
        profileId: p.id,
        cookie: "sp_session=" + token,
        actor: await actorFor(h.db, user),
      };
    }
    const root = await person("office", "super_admin"),
      rep = await person("rep", "sales"),
      other = await person("other", "sales");
    /** @param {any} who @param {string} path @param {any} [body] */
    async function api(who, path, body) {
      const r = await h.fetch(path, {
        method: body ? "POST" : "GET",
        headers: { cookie: who.cookie, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, body: /** @type {any} */ (await r.json()) };
    }
    const [customer] =
      await h.db`insert into customers(code,name,channel,territory,credit_limit,active)values('SAMPLE-INC-C','Sample incentive account','gt','Sample',1000,true)returning id`;
    const [outlet] =
      await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,created_by)values('sunpride','SAMPLE-INC-O','Sample incentive store','active',${unit},'fixture')returning id`;
    await h.db`insert into outlet_customer_links(outlet_id,customer_id,effective_from,source,actor_subject,reason)values(${outlet.id},${customer.id},'2020-01-01','manual',${root.user},'Sample fixture')`;
    const [order] =
      await h.db`insert into orders(organization_id,client_request_id,order_number,order_type,customer_code,status,salesperson_subject,salesperson_profile_id,created_by_subject,org_unit_id,outlet_id,service_date,amount_known,total_centavos,subtotal,total)values('sunpride','sample-incentive-sale','SAMPLE-INC-0586','booking','SAMPLE-INC-C','approved',${rep.user},${rep.profileId},${rep.user},${unit},${outlet.id},'2026-10-21',true,5000,50,50)returning id`;
    await h.db`insert into order_lines(order_id,product_code,description,quantity,uom,unit_price,line_total,line_total_centavos)values(${order.id},'SAMPLE-INC-SKU','Sample incentive SKU',1,'EA',50,50,5000)`;
    const metrics = [
      "targets",
      "coverage",
      "distribution",
      "availability",
      "collection",
      "settlementVariance",
    ].map((metric) => ({
      metric,
      weightBps: metric === "targets" ? 10000 : 0,
      capBps: 10000,
      direction: metric === "settlementVariance" ? "lower" : "higher",
      ...(metric === "targets" ? { target: 10000 } : {}),
    }));
    const c = {
      db: h.db,
      actor: root.actor,
      env: h.env,
      now: Date.now(),
      url: new URL("http://local"),
    };
    const facts = await readIncentiveMetrics(c, {
      profileId: rep.profileId,
      periodFrom: "2026-10-01",
      periodTo: "2026-10-31",
      rules: metrics,
    });
    expect(facts.metrics.targets.actual).toBe(5000);
    expect(facts.sourceKey).toStartWith("incentive-canonical:v1:");
    const result = computeIncentive(metrics, facts.metrics, 1000);
    expect(result.amountCentavos).toBe(500);
    expect(result.lines[5].excluded).toBe(true);
    const plan = await api(root, "/api/v1/tpm/incentives/plan", {
      idempotencyKey: "sample-incentive-plan",
      code: "SAMPLE-INC",
      name: "Sample incentive",
      source: "sample",
      effectiveFrom: "2026-01-01T00:00:00Z",
      effectiveTo: "2027-01-01T00:00:00Z",
      baseCentavos: 1000,
      metrics,
    });
    expect(plan.status).toBe(200);
    const calc = await api(root, "/api/v1/tpm/incentives/calculate", {
      idempotencyKey: "sample-incentive-calc",
      planId: plan.body.id,
      profileId: rep.profileId,
      periodFrom: "2026-10-01",
      periodTo: "2026-10-31",
    });
    expect(calc.status).toBe(200);
    expect(calc.body.result.amountCentavos).toBe(500);
    const own = await api(rep, "/api/v1/account/incentives");
    expect(own.status).toBe(200);
    expect(own.body.rows.map((/** @type {any} */ r) => r.id)).toEqual([
      calc.body.id,
    ]);
    expect(own.body.rows[0].plan_source).toBe("sample");
    const foreign = await api(
      other,
      "/api/v1/account/incentives?profileId=" + rep.profileId,
    );
    expect(foreign.body.rows).toEqual([]);
    const all = await readIncentiveMetrics(c, {
      profileId: rep.profileId,
      periodFrom: "2026-10-01",
      periodTo: "2026-10-31",
      rules: metrics.map((r) => ({ ...r, weightBps: 1 })),
    });
    expect(Object.keys(all.metrics)).toHaveLength(6);
    expect(all.metrics.availability.actual).toBeNull();
    expect(all.metrics.settlementVariance.actual).toBeNull();
    expect(all.metrics.collection.actual).toBe(0);
    await h.db`update orders set amount_known=false where id=${order.id}`;
    const unknown = await readIncentiveMetrics(c, {
      profileId: rep.profileId,
      periodFrom: "2026-10-01",
      periodTo: "2026-10-31",
      rules: metrics,
    });
    expect(unknown.metrics.targets.actual).toBeNull();
    expect(() => computeIncentive(metrics, unknown.metrics, 1000)).toThrow(
      "governed actual",
    );
  } finally {
    await h.close();
  }
}, 60000);
