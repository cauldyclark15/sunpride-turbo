import { test, expect } from "bun:test";
import { tx } from "@sunpride/db/client";
import { startHarness, createUser } from "./harness.js";
import { actorFor } from "../src/core/context.js";
import { ensureRoot } from "../src/domains/org/identity.js";
import {
  nativePromotions,
  nativeSchemeContext,
} from "../src/domains/tpm/native-context.js";
import {
  quoteVanSchemes,
  enforceVanSchemeAuthority as enforceAuthority,
} from "../src/domains/van/commercial.js";
import { accrueOrder, reverseOrder } from "../src/domains/tpm/finance.js";

import { configureSap } from "../src/domains/integration/transport.js";
import { ingestMaster } from "../src/domains/integration/replicas.js";
import { sampleMaster } from "../../sap-mock/src/sample.js";
import { startMock } from "../../sap-mock/src/server.js";
import { install as org } from "../src/domains/org/index.js";
import { vanProjection } from "../src/domains/van/projection.js";
import { installProjections } from "../src/domains/fieldsync/projections.js";

test("F-502 registry negotiation reaches both real projection handlers instead of silently stripping the opt-in", () => {
  const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  /** @type {Map<string,any>} */ const registry = new Map();
  installProjections({
    registerProjection: (
      /** @type {string} */ key,
      /** @type {any} */ handler,
    ) => registry.set(key, handler),
  });
  const field = registry.get("field.bundle"),
    van = vanProjection({});
  const vanParams = van.params;
  if (!vanParams)
    throw new Error("The van projection must normalize its parameters");
  expect(
    field.params({ dayFrom: day, includeWorkforce: true, schemeEngine: 1 }),
  ).toEqual({ dayFrom: day, includeWorkforce: true, schemeEngine: 1 });
  expect(
    vanParams({ serviceDate: day, catalogue: true, schemeEngine: 1 }),
  ).toEqual({ serviceDate: day, catalogue: true, schemeEngine: 1 });
  expect(field.params({ dayFrom: day })).toEqual({ dayFrom: day });
  expect(vanParams({ serviceDate: day })).toEqual({ serviceDate: day });
  for (const value of [99, "1", false]) {
    expect(() => field.params({ dayFrom: day, schemeEngine: value })).toThrow();
    expect(() =>
      vanParams({ serviceDate: day, schemeEngine: value }),
    ).toThrow();
  }
});

// Small real-PG boundary test: no volume, financial transport fabrication or device installation.
test("F-503 native offers are scoped before export and do not disclose other account eligibility", () => {
  const base = {
    id: "sample-p",
    code: "SAMPLE",
    name: "Sample",
    rule: {
      kind: "percent_off",
      item: { productId: "sample-a", uom: "EA", quantity: 1 },
      percentOffBasisPoints: 1000,
    },
    eligibility: { outletId: { include: ["sample-own", "sample-foreign"] } },
    effective_from: new Date(0),
  };
  const products = [{ productId: "sample-a", uom: "EA" }];
  const own = nativePromotions(
    [base],
    { outletId: "sample-own", channelKey: "GT" },
    products,
  );
  expect(own).toHaveLength(1);
  expect(JSON.stringify(own)).not.toContain("sample-foreign");
  expect(
    nativePromotions([base], { outletId: "sample-denied" }, products),
  ).toHaveLength(0);
  expect(
    nativePromotions(
      [{ ...base, channel_key: "MT" }],
      { outletId: "sample-own", channelKey: "GT" },
      products,
    ),
  ).toHaveLength(0);
  expect(nativePromotions([base], { outletId: "sample-own" }, [])).toHaveLength(
    0,
  );
});

test("F-502 F-511 native basket uses canonical schemes, exact fiscal bands, once-only valued spend and genuine van-source accrual/reversal", async () => {
  const h = await startHarness({ installers: [org] });
  const sap = startMock({
    path: h.filesDir + "/native-schemes-sap.sqlite",
    port: 0,
    seed: false,
  });
  try {
    h.env.SAP_ORIGIN = sap.origin;
    configureSap(h.db, h.env);
    const unit = await ensureRoot(h.db),
      now = Date.now(),
      early = new Date(now - 86400000),
      late = new Date(now + 86400000);
    const user = await createUser(
      h,
      "sample-native-schemes@example.com",
      "Fixture-only-native-schemes",
    );
    const [person] =
      await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id) values(${user},${user},'Sample native seller','sample-native-schemes@example.com','sales','active',${unit}) returning id`;
    await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${person.id},${unit},'sales',${early},${user},'Sample fixture')`;
    const c = { db: h.db, actor: await actorFor(h.db, user), env: h.env, now };
    const [measure] =
      await h.db`insert into units_of_measure(organization_id,code,name,dimension,decimal_places,active) values('sunpride','EA','Sample each','count',0,true) returning id`;
    const [product] =
      await h.db`insert into products(organization_id,code,name,category,uom,unit_price,active,base_uom_id,quantity_scale) values('sunpride','SAMPLE-NATIVE-SKU','Sample native product','Sample','EA',0,true,${measure.id},1) returning id`;
    const condition = sampleMaster("condition", "SAMPLE-NATIVE-CONDITION", {
      productCode: "SAMPLE-NATIVE-SKU",
      uom: "EA",
      customerCode: null,
      channelKey: null,
      currency: "PHP",
      unitPriceCentavos: 100,
      taxCode: "SAMPLE-VAT",
      taxBasisPoints: 0,
      taxInclusive: true,
      precedence: 10,
      priceListCode: "SAMPLE-NATIVE",
    });
    condition.effectiveFrom = +early;
    condition.effectiveTo = +late;
    await ingestMaster(h.db, condition);
    const [store] =
      await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,channel,created_by) values('sunpride','SAMPLE-NATIVE-STORE','Sample native store','active',${unit},'GT',${user}) returning id`;
    const [truck] =
      await h.db`insert into inventory_locations(organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values('sunpride',${unit},'SAMPLE','SAMPLE-NATIVE-TRUCK','Sample native truck','truck',true,true,true,true,false) returning id`;
    await h.db`insert into inventory_balances(product_code,warehouse_code,on_hand,reserved,available,as_of,organization_id,product_id,location_id,physical_base,available_base,damaged_base) values('SAMPLE-NATIVE-SKU','SAMPLE-NATIVE-TRUCK',20,0,20,now(),'sunpride',${product.id},${truck.id},20,20,0)`;
    const [campaign] =
      await h.db`insert into campaigns(code) values('SAMPLE-NATIVE-CAMPAIGN') returning id`;
    const [version] =
      await h.db`insert into campaign_versions(campaign_id,version,name,mechanic,status,effective_from,effective_to,budget_centavos,expected_volume_base,expected_roi_bps,source,created_by) values(${campaign.id},1,'Sample native campaign','Sample stacked native offers','active',${early},${late},10000,10,10000,'sample',${user}) returning id`;
    const unitRule = { productId: product.id, uom: "EA", quantity: 2 };
    /** @type {any[]} */ const offers = [
      [
        "SAMPLE-NATIVE-BOGO",
        { kind: "bogo", buy: unitRule, free: { ...unitRule, quantity: 1 } },
        "on_invoice",
        10,
      ],
      [
        "SAMPLE-NATIVE-OFF",
        {
          kind: "value_off",
          item: { ...unitRule, quantity: 1 },
          valueCentavos: 20,
        },
        "on_invoice",
        20,
      ],
      [
        "SAMPLE-NATIVE-EARN",
        { kind: "value_off", item: unitRule, valueCentavos: 25 },
        "claimable",
        30,
      ],
    ];
    for (const [code, rule, timing, precedence] of offers)
      await h.db`insert into promotions(organization_id,code,name,rule_kind,rule,status,source,effective_from,effective_to,campaign_version_id,precedence,stacking,benefit_timing) values('sunpride',${code},${code},${rule.kind},${rule},'active','sample',${early},${late},${version.id},${precedence},'stack',${timing})`;
    const [policy] =
      await h.db`insert into fiscal_authority_rules(org_unit_id,kind,role,channel,min_centavos,max_centavos,self_limit_centavos,approver_roles,effective_from,sample) values(${unit},'discount','sales','GT',0,10000,200,${["super_admin"]},${early},true) returning id`;
    const trip = {
      id: crypto.randomUUID(),
      organization_id: "sunpride",
      org_unit_id: unit,
      truck_location_id: truck.id,
    };
    const input = {
      schemeEngineVersion: 1,
      deviceTime: now,
      lines: [
        {
          productId: product.id,
          quantityBase: "6",
          paidBase: "4",
          freeBase: "2",
        },
      ],
    };
    const [account] =
      await h.db`insert into customers(code,name,channel,territory,credit_limit,active) values('SAMPLE-NATIVE-CUST','Sample native account','GT','SAMPLE',0,true) returning id`;
    await h.db`insert into outlet_customer_links(outlet_id,customer_id,source,effective_from,actor_subject,reason) values(${store.id},${account.id},'sample',${early},${user},'Sample native account link')`;
    const customer = {
      id: store.id,
      channel: "GT",
      customerCode: "SAMPLE-NATIVE-CUST",
    };
    const quote = await quoteVanSchemes(
      h.db,
      trip,
      c.actor,
      h.env,
      input,
      customer,
    );
    if (!quote)
      throw new Error("The versioned native path must produce a quote");
    expect(quote.quote.totalCentavos).toBe(320);
    expect(quote.benefitCentavos).toBe(330n);
    expect(quote.quote.promotionsApplied.map((p) => p.kind)).toEqual([
      "bogo",
      "value_off",
      "value_off",
    ]);
    const snapshot = await nativeSchemeContext(c, {
      outletId: store.id,
      channelKey: "GT",
      orgUnitId: unit,
      products: [
        { productId: product.id, uom: "EA", name: "Sample native product" },
      ],
      prices: [
        {
          productId: product.id,
          uom: "EA",
          unitPriceCentavos: 100,
          priceListId: null,
        },
      ],
    });
    expect(snapshot.promotions).toHaveLength(3);
    expect(snapshot.accountLinked).toBe(true);
    expect(snapshot.authority[0].selfLimitCentavos).toBe("200");
    const authority = {
      orgUnitId: unit,
      kind: "discount",
      channel: "GT",
      amountCentavos: String(quote.benefitCentavos),
      operationId: crypto.randomUUID(),
      facts: { sample: true },
    };
    await expect(
      tx(h.db, (db) => enforceAuthority(db, c.actor, authority)),
    ).rejects.toThrow();
    await h.db`update fiscal_authority_rules set self_limit_centavos=400 where id=${policy.id}`;
    await tx(h.db, (db) => enforceAuthority(db, c.actor, authority));
    const source = {
      id: crypto.randomUUID(),
      source_type: "van_sale",
      status: "approved",
      pricing_snapshot: quote.quote,
      outlet_id: store.id,
      customer_code: customer.customerCode,
      offline_created_at: new Date(now),
    };
    await tx(h.db, (db) => accrueOrder({ ...c, db }, source));
    await tx(h.db, (db) => accrueOrder({ ...c, db }, source));
    const [commit] =
      await h.db`select sum(amount_centavos)::text n from campaign_commitment_balances where campaign_id=${campaign.id}`;
    expect(commit.n).toBe("330");
    const earned =
      await h.db`select * from promotion_earnings where source_key like ${"van_sale:" + source.id + ":promotion:%"}`;
    expect(earned).toHaveLength(1);
    expect(Number(earned[0].amount_centavos)).toBe(50);
    await tx(h.db, (db) => reverseOrder({ ...c, db }, source.id, "van_sale"));
    const [after] =
      await h.db`select sum(amount_centavos)::text n from campaign_commitment_balances where campaign_id=${campaign.id}`;
    expect(after.n).toBe("0");
    const [reversal] =
      await h.db`select amount_centavos::text n from tpm_posting_instructions where earning_id=${earned[0].id} and kind='reversal'`;
    expect(reversal.n).toBe("50");
    await expect(
      quoteVanSchemes(
        h.db,
        trip,
        c.actor,
        h.env,
        {
          ...input,
          lines: [{ ...input.lines[0], freeBase: "1", quantityBase: "5" }],
        },
        customer,
      ),
    ).rejects.toThrow();
  } finally {
    sap.stop();
    await h.close();
  }
}, 30000);
