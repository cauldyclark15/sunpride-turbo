import { test, expect } from "bun:test";
import { tx } from "@sunpride/db/client";
import { startHarness, createUser } from "./harness.js";
import { startMock } from "../../sap-mock/src/server.js";
import { install as org } from "../src/domains/org/index.js";
import { install as integration } from "../src/domains/integration/index.js";
import { install as distributors } from "../src/domains/distributors/index.js";
import { configureSap } from "../src/domains/integration/transport.js";
import { advanceCreditExceptions } from "../src/domains/integration/credit-exceptions.js";
import { actorFor } from "../src/core/context.js";
import { decideOverride } from "../src/domains/fiscal/authority.js";
import { roleHas } from "../src/core/capabilities.js";

test("F-404 distributor obtains an independently approved provider exception without any employee core capability", async () => {
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
    await h.db`insert into distributor_master_versions(distributor_id,source,source_key,version,payload_hash,payload,effective_from) values(${party},'sample','SAMPLE',1,'SAMPLE',${{ products: [{ productId: sku, uom: "EA", unitsPerUom: 1, priceCentavos: 1000, availableBase: 10 }], schemes: [], terms: { paymentTerms: "SAMPLE 30 days", deliveryLeadDays: 1 } }},'2020-01-01')`;
    await h.db`insert into distributor_policies(distributor_id,version,settings,effective_from) values(${party},1,${{ creditMaxAgeSeconds: 3600 }},'2020-01-01')`;
    await h.db`insert into fiscal_authority_rules(org_unit_id,kind,role,channel,min_centavos,max_centavos,self_limit_centavos,approver_roles,offline_allowed,effective_from,sample) values(${unit},'credit','distributor','*',0,1000000,0,${["super_admin"]},false,'2020-01-01',true)`;
    mock.db.run("insert into credit_accounts values(?,?,?)", [
      "SAMPLE-PARTNER",
      1000,
      900,
    ]);
    /** @param {string} path @param {any} body */
    async function post(path, body) {
      const res = await h.fetch("/api/v1/distributors/" + path, {
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
      const result = await res.json();
      if (res.status !== 200)
        throw Error(
          path +
            ": " +
            res.status +
            " " +
            String(result.error?.code ?? "") +
            " " +
            String(result.error?.message ?? ""),
        );
      return result;
    }
    const draft = {
      poNumber: "SAMPLE-PO",
      lines: [{ productId: sku, quantity: 2 }],
    };
    expect((await post("quote", draft)).canConfirm).toBe(false);
    const request = await post("credit/exception", {
      ...draft,
      reason: "SAMPLE partner PO exception",
      amountCentavos: 1,
    });
    expect(request.amountCentavos).toBe(2000);
    expect(request.phase).toBe("awaiting_finance");
    const actor = await actorFor(h.db, reviewer.uid);
    await tx(h.db, (db) =>
      decideOverride(db, actor, {
        id: request.fiscalRequestId,
        decision: "approved",
        reason: "SAMPLE independent partner review",
      }),
    );
    expect(await advanceCreditExceptions({ db: h.db, env: h.env })).toBe(1);
    expect(await post("credit/refresh", { id: request.id })).toMatchObject({
      phase: "approved",
      source: "sample",
    });
    const priced = await post("quote", {
      ...draft,
      sapCreditExceptionId: request.id,
    });
    expect(priced.canConfirm).toBe(true);
    expect(priced.creditException.id).toBe(request.id);
    const placed = await post("orders", {
      ...draft,
      sapCreditExceptionId: request.id,
    });
    const [stored] =
      await h.db`select sap_credit_decision_id,org_unit_id from orders where id=${placed.id}`;
    expect(stored.org_unit_id).toBe(unit);
    expect(stored.sap_credit_decision_id).not.toBeNull();
    await h.db`update distributor_users set effective_to=now() where distributor_id=${party} and profile_id=${buyer.profileId}`;
    const denied = await h.fetch(
      "/api/v1/distributors/credit/requests?distributorId=" + party,
      { headers: { cookie: buyer.cookie ?? "" } },
    );
    expect(denied.status).toBe(403);
  } finally {
    mock.stop();
    await h.close();
  }
}, 30000);
