import { expect, test } from "bun:test";
import { tx } from "@sunpride/db/client";
import { startHarness, createUser } from "./harness.js";
import { domainInstallers } from "../src/domains/index.js";
import { startMock } from "../../sap-mock/src/server.js";
import { ensureRoot } from "../src/domains/org/identity.js";
import { ensurePartnerDeviceScope } from "../src/domains/distributors/identity-seam.js";
import { actorFor } from "../src/core/context.js";
import {
  quote,
  placeOrder,
  requestQuoteApproval,
} from "../src/domains/distributors/ordering.js";
import { decideOverride } from "../src/domains/fiscal/authority.js";
import { runOutbox } from "../src/domains/integration/outbox.js";

test("F-410 F-511 partner rebates use exact independent authority and shared budget before SAP; SAP acceptance accrues once", async () => {
  const h = await startHarness({
      installers: domainInstallers,
      env: { SAP_MODE: "mock" },
    }),
    mock = startMock({ path: h.filesDir + "/partner-sap.sqlite", port: 0 });
  h.env.SAP_ORIGIN = mock.origin;
  try {
    const unit = await ensureRoot(h.db),
      early = new Date(Date.now() - 86400000),
      now = Date.now();
    const [d] =
      await h.db`insert into distributors(code,name,org_unit_id,status,sap_customer_code,source)values('SAMPLE-F410','Sample promotion partner',${unit},'accredited','MOCK-C1','sample')returning *`;
    await ensurePartnerDeviceScope({ db: h.db }, d);
    /** @param {string} role @param {string} area */
    async function person(role, area) {
      const email = `sample-discount-${role}@example.com`,
        user = await createUser(h, email, "Test-only-discount-fixture");
      const [p] =
        await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id)values(${user},${user},${"Sample " + role},${email},${role},'active',${area})returning id`;
      if (role === "distributor")
        await h.db`insert into distributor_users(distributor_id,profile_id,grants)values(${d.id},${p.id},'{read,order}'::text[])`;
      else
        await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason)values(${p.id},${area},${role},${early},${user},'Sample fixture')`;
      const actor = await actorFor(h.db, user);
      if (!actor) throw new Error("Sample principal was not provisioned");
      return actor;
    }
    const actor = await person("distributor", d.device_org_unit_id),
      approver = await person("approver", unit);
    const [sku] =
      await h.db`insert into products(code,name,category,uom,unit_price,active,organization_id)values('SAMPLE-F410','Sample promotion SKU','Sample','PC',0,true,'sunpride')returning id`;
    const [campaign] =
      await h.db`insert into campaigns(code)values('SAMPLE-F410')returning id`;
    const [version] =
      await h.db`insert into campaign_versions(campaign_id,version,name,mechanic,status,effective_from,effective_to,budget_centavos,expected_volume_base,expected_roi_bps,source,created_by)values(${campaign.id},1,'Sample partner campaign','Slab rebate','active',${early},${new Date(now + 86400000)},50,2,1000,'sample',${approver.subject})returning id`;
    const rule = {
      kind: "slab",
      item: { productId: sku.id, uom: "PC", quantity: 1 },
      slabs: [{ minQuantity: 1, percentOffBasisPoints: 5000 }],
    };
    const [promotion] =
      await h.db`insert into promotions(organization_id,code,name,rule_kind,rule,status,source,effective_from,effective_to,campaign_version_id,benefit_timing,eligibility)values('sunpride','SAMPLE-F410','Sample slab rebate','slab',${rule},'active','sample',${early},${new Date(now + 86400000)},${version.id},'claimable',${{ distributorId: { include: [d.id] } }})returning id`;
    const payload = {
      products: [
        {
          productId: sku.id,
          uom: "PC",
          unitsPerUom: 1,
          availableBase: 100,
          priceCentavos: 100,
        },
      ],
      schemes: [{ promotionId: promotion.id }],
      terms: { deliveryLeadDays: 1 },
    };
    await h.db`insert into distributor_master_versions(distributor_id,source,source_key,version,payload_hash,payload,effective_from)values(${d.id},'sample','SAMPLE-F410',1,'fixture',${payload},${early})`;
    await h.db`insert into fiscal_authority_rules(org_unit_id,kind,role,channel,min_centavos,max_centavos,self_limit_centavos,approver_roles,effective_from,sample)values(${unit},'discount','distributor','distributor',0,100000,0,'["approver"]'::jsonb,${early},true)`;
    const c = {
        db: h.db,
        actor,
        env: h.env,
        now,
        body: { requestKey: "sample-f410-order" },
      },
      b = {
        poNumber: "SAMPLE-F410-PO",
        lines: [{ productId: sku.id, quantity: 2 }],
      };
    const initial = await quote(c, d, b);
    expect(initial.totalCentavos).toBe(200);
    expect(initial.benefits[0].earnedCentavos).toBe(100);
    expect(initial.canConfirm).toBe(false);
    const request = await tx(h.db, (db) =>
      requestQuoteApproval({ ...c, db }, d, {
        ...b,
        reason: "Sample rebate above self limit",
      }),
    );
    await tx(h.db, (db) =>
      decideOverride(db, approver, {
        id: request.id,
        decision: "approved",
        reason: "Sample independent approval",
      }),
    );
    expect((await quote(c, d, b)).canConfirm).toBe(true);
    await expect(
      tx(h.db, (db) => placeOrder({ ...c, db }, d, b)),
    ).rejects.toThrow("budget");
    expect(
      Number(
        (
          await h.db`select count(*) as n from distributor_sap_requests where distributor_id=${d.id}`
        )[0].n,
      ),
    ).toBe(0);
    await h.db`update campaign_versions set budget_centavos=100 where id=${version.id}`;
    const saved = await tx(h.db, (db) => placeOrder({ ...c, db }, d, b));
    expect(
      Number(
        (
          await h.db`select amount_centavos from campaign_commitment_balances where campaign_version_id=${version.id}`
        )[0].amount_centavos,
      ),
    ).toBe(100);
    expect(
      Number(
        (
          await h.db`select count(*) as n from fiscal_override_events where request_id=${request.id} and kind='consumed'`
        )[0].n,
      ),
    ).toBe(1);
    await runOutbox(h.db, { env: h.env });
    const [order] =
      await h.db`select status,sap_document_number from orders where id=${saved.id}`;
    expect(order.status).toBe("approved");
    expect(order.sap_document_number).toStartWith("SAMPLE-ORDER-");
    const earnings =
      await h.db`select amount_centavos from promotion_earnings where promotion_id=${promotion.id}`;
    expect(earnings).toHaveLength(1);
    expect(Number(earnings[0].amount_centavos)).toBe(100);
  } finally {
    mock.stop();
    await h.close();
  }
}, 60000);
