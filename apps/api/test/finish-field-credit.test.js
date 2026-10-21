import { test, expect } from "bun:test";
import { tx } from "@sunpride/db/client";
import { startHarness, createUser } from "./harness.js";
import { startMock } from "../../sap-mock/src/server.js";
import { install as org } from "../src/domains/org/index.js";
import { install as integration } from "../src/domains/integration/index.js";
import { configureSap } from "../src/domains/integration/transport.js";
import { actorFor } from "../src/core/context.js";
import { decideOverride } from "../src/domains/fiscal/authority.js";
import { advanceCreditExceptions } from "../src/domains/integration/credit-exceptions.js";
import { transition } from "../src/domains/orders/service.js";

test("F-404 field own-order control and ordinary office confirmation consume the matching SAP exception automatically", async () => {
  const h = await startHarness({ installers: [org, integration] }),
    mock = startMock({
      path: h.filesDir + "/field-credit.sqlite",
      seed: false,
      port: 0,
    });
  try {
    h.env.SAP_MODE = "mock";
    h.env.SAP_ORIGIN = mock.origin;
    configureSap(h.db, h.env);
    const unit = crypto.randomUUID(),
      orderId = crypto.randomUUID(),
      sku = crypto.randomUUID();
    await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SUNPRIDE','SAMPLE','national','active','2020-01-01')`;
    /** @param {string} name @param {string} role */
    async function person(name, role) {
      const email = name + "@example.test",
        password = "test-only-order-credit-password",
        uid = await createUser(h, email, password);
      const [p] =
        await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id) values(${uid},${uid},${name},${email},${role},'active',${unit}) returning id`;
      await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},${role},'2020-01-01','SAMPLE','SAMPLE')`;
      const login = await h.fetch("/api/auth/sign-in", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      expect(login.status).toBe(200);
      return {
        uid,
        id: p.id,
        cookie: login.headers.get("set-cookie")?.split(";")[0] ?? "",
      };
    }
    const seller = await person("SAMPLE-field", "sales"),
      reviewer = await person("SAMPLE-finance", "super_admin");
    await h.db`insert into customers(code,name,channel,territory,credit_limit,active) values('SAMPLE-CREDIT','SAMPLE account','general_trade','SAMPLE',10,true)`;
    await h.db`insert into sales_assignments(customer_code,territory,salesperson_subject,active) values('SAMPLE-CREDIT','SAMPLE',${seller.uid},true)`;
    await h.db`insert into products(id,organization_id,code,name,category,uom,unit_price,quantity_scale,active) values(${sku},'sunpride','SAMPLE-SKU','SAMPLE product','SAMPLE','EA',10,1,true)`;
    await h.db`insert into orders(id,organization_id,client_request_id,order_number,customer_code,salesperson_subject,salesperson_profile_id,created_by_subject,org_unit_id,status,subtotal,total,subtotal_centavos,total_centavos,amount_known,channel_key,service_date,pricing_snapshot) values(${orderId},'sunpride','SAMPLE-field','SAMPLE-ORDER','SAMPLE-CREDIT',${seller.uid},${seller.id},${seller.uid},${unit},'pending_approval',20,20,2000,2000,true,'general_trade',current_date,${{ lines: [{ productId: sku, productCode: "SAMPLE-SKU", uom: "EA", quantity: 2, quantityBase: 2, unitPriceCentavos: 1000, lineTotalCentavos: 2000 }], promotionsApplied: [], currency: "PHP", subtotalCentavos: 2000, totalCentavos: 2000 }})`;
    await h.db`insert into order_lines(order_id,ordinal,product_id,product_code,description,uom,quantity,quantity_base,unit_price,line_total,unit_price_centavos,line_total_centavos) values(${orderId},0,${sku},'SAMPLE-SKU','SAMPLE product','EA',2,2,10,20,1000,2000)`;
    const [w] =
      await h.db`insert into workflow_instances(entity_type,entity_id,workflow_type,status,current_step,requested_by) values('order',${orderId},'sales-order-approval','pending',1,${seller.uid}) returning id`;
    await h.db`insert into approvals(workflow_id,decision) values(${w.id},'pending')`;
    await h.db`insert into fiscal_authority_rules(org_unit_id,kind,role,channel,min_centavos,max_centavos,self_limit_centavos,approver_roles,offline_allowed,effective_from,sample) values(${unit},'credit','sales','*',0,1000000,0,'["super_admin"]'::jsonb,false,'2020-01-01',true)`;
    mock.db.run("insert into credit_accounts values(?,?,?)", [
      "SAMPLE-CREDIT",
      1000,
      900,
    ]);
    /** @param {string} path @param {any} [body] */
    async function api(path, body) {
      const res = await h.fetch("/api/v1/credit/" + path, {
        method: body ? "POST" : "GET",
        headers: { cookie: seller.cookie, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const result = await res.json();
      if (res.status !== 200)
        throw Error(String(result.error?.message ?? res.status));
      return result;
    }
    expect((await api("control")).orders).toHaveLength(1);
    const request = await api("request-override", {
      customerCode: "SAMPLE-CREDIT",
      sourceType: "order",
      sourceId: orderId,
      amountCentavos: 2000,
      reason: "SAMPLE delivery order exception",
      idempotencyKey: crypto.randomUUID(),
    });
    const exposure = await api(
      "exposure?customerCode=SAMPLE-CREDIT&orderId=" + orderId,
    );
    expect(exposure).toMatchObject({ source: "sample", exposureCentavos: 900 });
    const approver = await actorFor(h.db, reviewer.uid);
    await tx(h.db, (db) =>
      decideOverride(db, approver, {
        id: request.fiscalRequestId,
        decision: "approved",
        reason: "SAMPLE independent review",
      }),
    );
    expect(await advanceCreditExceptions({ db: h.db, env: h.env })).toBe(1);
    const approved = await api("exception/status", { id: request.id });
    expect(approved.phase).toBe("approved");
    await tx(h.db, (db) =>
      transition(
        {
          db,
          actor: approver,
          env: h.env,
          now: Date.now(),
          publish: async () => {},
          enqueue: async () => {},
        },
        orderId,
        "approved",
        "SAMPLE approve the financed order",
      ),
    );
    const [stored] =
      await h.db`select status,sap_credit_decision_id from orders where id=${orderId}`;
    expect(stored.status).toBe("approved");
    expect(stored.sap_credit_decision_id).not.toBeNull();
    expect((await api("control")).orders).toHaveLength(0);
  } finally {
    mock.stop();
    await h.close();
  }
}, 30000);
