import { test, expect } from "bun:test";
import { tx } from "@sunpride/db/client";
import { startHarness, createUser } from "./harness.js";
import { startMock } from "../../sap-mock/src/server.js";
import { install as org } from "../src/domains/org/index.js";
import { install as integration } from "../src/domains/integration/index.js";
import { install as distributors } from "../src/domains/distributors/index.js";
import { configureSap } from "../src/domains/integration/transport.js";
import { actorFor } from "../src/core/context.js";
import { decideOverride } from "../src/domains/fiscal/authority.js";
import { roleHas } from "../src/core/capabilities.js";
import { seedFiscal } from "../../../packages/db/seed/fiscal.js";
test("F-511 distributor published benefit needs independent value-band review before canonical confirmation", async () => {
  const h = await startHarness({
      installers: [org, integration, distributors],
    }),
    mock = startMock({
      path: h.filesDir + "/partner-credit.sqlite",
      port: 0,
      seed: false,
    });
  try {
    h.env.SAP_MODE = "mock";
    h.env.SAP_ORIGIN = mock.origin;
    configureSap(h.db, h.env);
    const unit = crypto.randomUUID(),
      deviceUnit = crypto.randomUUID(),
      party = crypto.randomUUID(),
      sku = crypto.randomUUID();
    await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SUNPRIDE','SAMPLE company','national','active','2020-01-01'),(${deviceUnit},'sunpride','SAMPLE-PARTNER','SAMPLE partner devices','region','active','2020-01-01')`;
    await h.db`update org_units set parent_id=${unit} where id=${deviceUnit}`;
    await h.db`insert into distributors(id,code,name,org_unit_id,device_org_unit_id,status,sap_customer_code,source,effective_from) values(${party},'SAMPLE-P','SAMPLE distributor',${unit},${deviceUnit},'accredited','SAMPLE-PARTNER','sample','2020-01-01')`;
    /** @param {string} email @param {string} role @param {string} org */
    async function user(email, role, org) {
      const password = "test-only-partner-password";
      const uid = await createUser(h, email, password);
      const [p] =
        await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id) values(${uid},${uid},${email},${email},${role},'active',${org}) returning id`;
      if (role !== "distributor")
        await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${org},${role},'2020-01-01','SAMPLE','SAMPLE')`;
      const res = await h.fetch("/api/auth/sign-in", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      expect(res.status).toBe(200);
      return {
        uid,
        profileId: p.id,
        cookie: res.headers.get("set-cookie")?.split(";")[0],
      };
    }
    const buyer = await user(
        "sample-buyer@example.test",
        "distributor",
        deviceUnit,
      ),
      reviewer = await user("sample-finance@example.test", "super_admin", unit);
    await h.db`insert into distributor_users(distributor_id,profile_id,grants,effective_from) values(${party},${buyer.profileId},ARRAY['read','order','finance']::text[],'2020-01-01')`;
    expect(roleHas("distributor", "order.create")).toBe(false);
    await h.db`insert into products(id,organization_id,code,name,category,uom,unit_price,quantity_scale,active) values(${sku},'sunpride','SAMPLE-PRODUCT','SAMPLE product','SAMPLE','EA',10,1,true)`;
    const [promotion] =
      await h.db`insert into promotions(organization_id,code,name,rule_kind,rule,status,source,effective_from) values('sunpride','SAMPLE-FIN','SAMPLE published five percent','percent_off',${{ kind: "percent_off", item: { productId: sku, uom: "EA", quantity: 1 }, percentOffBasisPoints: 500 }},'active','sample','2020-01-01') returning id`;
    await h.db`insert into distributor_master_versions(distributor_id,source,source_key,version,payload_hash,payload,effective_from) values(${party},'sample','SAMPLE',1,'SAMPLE',${{ products: [{ productId: sku, uom: "EA", unitsPerUom: 1, priceCentavos: 1000, availableBase: 10 }], schemes: [{ promotionId: promotion.id, distributorIds: [party], channelKeys: ["distributor"] }], terms: { paymentTerms: "SAMPLE 30 days", deliveryLeadDays: 1 } }},'2020-01-01')`;
    await h.db`insert into distributor_policies(distributor_id,version,settings,effective_from) values(${party},1,${{ creditMaxAgeSeconds: 3600 }},'2020-01-01')`;
    for (const [table, row] of [
      ["org_units", unit],
      ["profiles", reviewer.profileId],
      ["distributors", party],
    ])
      await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values('SAMPLE-FIN',${table},${row},${table + ":" + row})`;
    await seedFiscal(h.db);
    await h.db`insert into fiscal_authority_rules(org_unit_id,kind,role,channel,min_centavos,max_centavos,self_limit_centavos,approver_roles,offline_allowed,effective_from,sample) values(${unit},'discount','distributor','distributor',0,1000000,0,${["super_admin"]},false,'2020-01-01',true)`;
    mock.db.run("insert into credit_accounts values(?,?,?)", [
      "SAMPLE-PARTNER",
      1000000,
      0,
    ]);
    /** @param {string} path @param {any} body */
    async function post(path, body) {
      const r = await h.fetch("/api/v1/distributors/" + path, {
        method: "POST",
        headers: {
          cookie: buyer.cookie ?? "",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          distributorId: party,
          requestKey: crypto.randomUUID(),
          ...body,
        }),
      });
      return { status: r.status, body: await r.json() };
    }
    const cart = {
      poNumber: "SAMPLE-PO-FIN",
      lines: [{ productId: sku, quantity: 2 }],
    };
    const q = await post("quote", cart);
    expect(q.status).toBe(200);
    expect(q.body.totalCentavos).toBe(1900);
    const request = await post("financial/request", {
      ...cart,
      amountCentavos: 0,
      channel: "fake",
    });
    expect(request.status).toBe(200);
    expect(request.body.requiresSecond).toBe(true);
    const blocked = await post("orders", cart);
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.message).toContain("second approver");
    const [source] =
      await h.db`select * from fiscal_override_requests where id=${request.body.id}`;
    expect(String(source.amount_centavos)).toBe("100");
    expect(source.channel).toBe("distributor");
    const reviewerActor = await actorFor(h.db, reviewer.uid);
    await tx(h.db, (db) =>
      decideOverride(db, reviewerActor, {
        id: source.id,
        decision: "approved",
        reason: "SAMPLE independent partner discount review",
      }),
    );
    const accepted = await post("orders", cart);
    if (accepted.status !== 200) throw Error(JSON.stringify(accepted.body));
    expect(accepted.status).toBe(200);
    const [used] =
      await h.db`select operation_id from fiscal_override_events where request_id=${source.id} and kind='consumed'`;
    expect(used.operation_id).toBe(accepted.body.id);
  } finally {
    mock.stop();
    await h.close();
  }
}, 30000);
