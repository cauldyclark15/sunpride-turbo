import { test, expect } from "bun:test";
import { tx } from "@sunpride/db/client";
import { startHarness, createUser } from "./harness.js";
import { install as org } from "../src/domains/org/index.js";
import { install as fiscal } from "../src/domains/fiscal/index.js";
import { actorFor } from "../src/core/context.js";
import { enforceCompanyDiscount } from "../src/domains/fiscal/commercial.js";
import { seedFiscal } from "../../../packages/db/seed/fiscal.js";

test("F-511 source-derived company/field/MT financial review uses current role/channel/value and refuses self approval or withdrawn reviewers", async () => {
  const h = await startHarness({ installers: [org, fiscal] });
  try {
    const unit = crypto.randomUUID(),
      id = crypto.randomUUID(),
      sku = crypto.randomUUID();
    await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SUNPRIDE','SAMPLE','national','active','2020-01-01')`;
    /** @param {string} name @param {string} role */
    async function user(name, role) {
      const email = name + "@example.test",
        password = "test-only-financial-password",
        uid = await createUser(h, email, password);
      const [p] =
        await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id) values(${uid},${uid},${name},${email},${role},'active',${unit}) returning id`;
      await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},${role},'2020-01-01','SAMPLE','SAMPLE')`;
      const r = await h.fetch("/api/auth/sign-in", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      expect(r.status).toBe(200);
      return {
        uid,
        id: p.id,
        cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "",
      };
    }
    const seller = await user("SAMPLE-capture", "sales"),
      reviewer = await user("SAMPLE-reviewer", "super_admin");
    await h.db`insert into customers(code,name,channel,territory,credit_limit,active) values('SAMPLE-C','SAMPLE buyer','modern_trade','SAMPLE',10000,true)`;
    await h.db`insert into sales_assignments(customer_code,territory,salesperson_subject,active) values('SAMPLE-C','SAMPLE',${seller.uid},true)`;
    const snapshot = {
      lines: [
        {
          productId: sku,
          description: "SAMPLE published item",
          uom: "EA",
          quantity: 1,
          unitPriceCentavos: 10000,
          grossLineTotalCentavos: 10000,
          lineTotalCentavos: 9800,
        },
      ],
      subtotalCentavos: 10000,
      totalCentavos: 9800,
    };
    await h.db`insert into orders(id,organization_id,client_request_id,order_number,customer_code,salesperson_subject,salesperson_profile_id,created_by_subject,org_unit_id,status,subtotal,total,subtotal_centavos,total_centavos,amount_known,channel_key,service_date,pricing_snapshot) values(${id},'sunpride','SAMPLE-capture','SAMPLE-MT','SAMPLE-C',${seller.uid},${seller.id},${seller.uid},${unit},'pending_approval',100,98,10000,9800,true,'modern_trade',current_date,${snapshot})`;
    for (const [table, row] of [
      ["org_units", unit],
      ["profiles", seller.id],
      ["profiles", reviewer.id],
    ])
      await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values('SAMPLE-FIN',${table},${row},${table + ":" + row})`;
    await seedFiscal(h.db);
    await seedFiscal(h.db);
    const [defaults] =
      await h.db`select count(*)::int as n from fiscal_authority_rules where org_unit_id=${unit} and role='sales' and kind='discount' and channel='*'`;
    expect(defaults.n).toBe(1);
    await h.db`insert into fiscal_authority_rules(org_unit_id,kind,role,channel,min_centavos,max_centavos,self_limit_centavos,approver_roles,offline_allowed,effective_from,sample) values(${unit},'discount','sales','modern_trade',0,100000,100,'["super_admin"]'::jsonb,false,'2020-01-01',true)`;
    const response = await h.fetch("/api/v1/fiscal/commercial/request", {
      method: "POST",
      headers: { cookie: seller.cookie, "content-type": "application/json" },
      body: JSON.stringify({
        orderId: id,
        amountCentavos: 0,
        channel: "fake",
        role: "super_admin",
      }),
    });
    expect(response.status).toBe(200);
    const request = await response.json();
    expect(request.requiresSecond).toBe(true);
    const [facts] =
      await h.db`select * from fiscal_override_requests where id=${request.id}`;
    expect(String(facts.amount_centavos)).toBe("200");
    expect(facts.channel).toBe("modern_trade");
    expect(facts.facts.sourceId).toBe(id);
    const [row] = await h.db`select * from orders where id=${id}`,
      actor = await actorFor(h.db, seller.uid),
      approver = await actorFor(h.db, reviewer.uid);
    await expect(
      tx(h.db, (db) =>
        enforceCompanyDiscount(
          { db, actor, env: h.env },
          row,
          "SAMPLE self decision",
        ),
      ),
    ).rejects.toBeDefined();
    await tx(h.db, (db) =>
      enforceCompanyDiscount(
        { db, actor: approver, env: h.env },
        row,
        "SAMPLE independent exact review",
      ),
    );
    const [total] =
      await h.db`select count(*)::int as n from fiscal_override_events where request_id=${request.id} and kind='consumed'`;
    expect(total.n).toBe(1);
    await h.db`update profiles set status='disabled' where id=${reviewer.id}`;
    await expect(
      tx(h.db, (db) =>
        enforceCompanyDiscount(
          { db, actor: approver, env: h.env },
          row,
          "SAMPLE replay after withdrawal",
        ),
      ),
    ).rejects.toBeDefined();
  } finally {
    await h.close();
  }
}, 30000);
