import { test, expect } from "bun:test";
import { startHarness, createUser } from "./harness.js";
import { ensureRoot } from "../src/domains/org/identity.js";
import { actorFor } from "../src/core/context.js";
import { install as org } from "../src/domains/org/index.js";
import { quote } from "../src/domains/orders/service.js";
import { ingestMaster } from "../src/domains/integration/replicas.js";
import { sampleMaster } from "../../sap-mock/src/sample.js";

test("F-504 office free goods are valued before fiscal authorization and frozen in campaign spend", async () => {
  const h = await startHarness({ installers: [org] });
  try {
    const unit = await ensureRoot(h.db),
      now = Date.now(),
      early = new Date(now - 10000),
      late = new Date(now + 86400000);
    const user = await createUser(
      h,
      "sample-gift@example.com",
      "Sample fixture password only",
    );
    const [profile] =
      await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id) values(${user},${user},'Sample gift seller','sample-gift@example.com','super_admin','active',${unit}) returning id`;
    await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${profile.id},${unit},'super_admin',${early},${user},'Sample')`;
    const [measure] =
      await h.db`insert into units_of_measure(organization_id,code,name,dimension,decimal_places,active) values('sunpride','EA','Sample each','count',0,true) returning id`;
    const [product] =
      await h.db`insert into products(organization_id,code,name,category,uom,unit_price,active,base_uom_id,quantity_scale) values('sunpride','SAMPLE-GIFT','Sample gift product','Sample','EA',0,true,${measure.id},1) returning id`;
    const [outlet] =
      await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,channel,created_by) values('sunpride','SAMPLE-GIFT','Sample store','active',${unit},'GT',${user}) returning id`;
    const condition = sampleMaster("condition", "SAMPLE-GIFT", {
      productCode: "SAMPLE-GIFT",
      uom: "EA",
      customerCode: null,
      channelKey: null,
      currency: "PHP",
      unitPriceCentavos: 100,
      taxCode: "SAMPLE",
      taxBasisPoints: 0,
      taxInclusive: true,
      precedence: 10,
      priceListCode: "SAMPLE",
    });
    condition.effectiveFrom = +early;
    condition.effectiveTo = +late;
    await ingestMaster(h.db, condition);
    const [campaign] =
      await h.db`insert into campaigns(code) values('SAMPLE-GIFT') returning id`;
    const [version] =
      await h.db`insert into campaign_versions(campaign_id,version,name,mechanic,status,effective_from,effective_to,budget_centavos,expected_volume_base,expected_roi_bps,source,created_by) values(${campaign.id},1,'Sample gifts','BOGO','active',${early},${late},10000,10,1000,'sample',${user}) returning id`;
    await h.db`insert into promotions(organization_id,code,name,rule_kind,rule,status,source,effective_from,effective_to,campaign_version_id) values('sunpride','SAMPLE-GIFT','Sample gift','bogo',${{ kind: "bogo", buy: { productId: product.id, uom: "EA", quantity: 2 }, free: { productId: product.id, uom: "EA", quantity: 1 } }},'active','sample',${early},${late},${version.id})`;
    const [policy] =
      await h.db`insert into fiscal_authority_rules(org_unit_id,kind,role,channel,min_centavos,max_centavos,self_limit_centavos,approver_roles,effective_from,sample) values(${unit},'discount','super_admin','GT',0,10000,100,${["approver"]},${early},true) returning id`;
    const c = { db: h.db, env: h.env, actor: await actorFor(h.db, user), now };
    const input = {
      outletId: outlet.id,
      customerCode: "SAMPLE-GIFT-ACCOUNT",
      channelKey: "GT",
      lines: [{ productId: product.id, uom: "EA", quantity: 4 }],
    };
    await expect(quote(c, input)).rejects.toThrow("authority");
    await h.db`update fiscal_authority_rules set self_limit_centavos=200 where id=${policy.id}`;
    const result = await quote(c, input);
    expect(result.promotionsApplied[0].freeGoodsValueCentavos).toBe(200);
    expect(
      result.promotionsApplied[0].freeGoods[0].referenceValueCentavos,
    ).toBe(200);
    expect(result.totalCentavos).toBe(400);
  } finally {
    await h.close();
  }
}, 30000);
