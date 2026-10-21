import { test, expect } from "bun:test";
import { tx } from "@sunpride/db/client";
import { startHarness } from "./harness.js";
import { ensureRoot } from "../src/domains/org/identity.js";
import { accrueOrder } from "../src/domains/tpm/finance.js";
import {
  returnedBenefits,
  reverseVanBenefitTotals,
} from "../src/domains/tpm/returns.js";

const product = "sample-sku";
const receipt = {
  schemeEngineVersion: 1,
  lines: [{ productId: product, quantityBase: "3", paidBase: "3" }],
  promotionsApplied: [
    {
      id: "sample-promo",
      campaignVersionId: "sample-campaign",
      benefitTiming: "claimable",
      earnedCentavos: 100,
      discountCentavos: 0,
      allocations: [100],
      freeGoods: [],
    },
  ],
};
test("F-504 split returns use frozen allocations and cumulative centavo rounding", () => {
  expect(returnedBenefits(receipt, new Map([[product, 1n]]))[0]).toMatchObject({
    earned: 33,
    spend: 33,
  });
  expect(returnedBenefits(receipt, new Map([[product, 2n]]))[0]).toMatchObject({
    earned: 66,
    spend: 66,
  });
  expect(returnedBenefits(receipt, new Map([[product, 3n]]))[0]).toMatchObject({
    earned: 100,
    spend: 100,
  });
  expect(() => returnedBenefits(receipt, new Map([[product, 4n]]))).toThrow();
  const gifts = {
    ...receipt,
    promotionsApplied: [
      {
        ...receipt.promotionsApplied[0],
        freeGoods: [{ productId: product, referenceValueCentavos: 30 }],
      },
    ],
  };
  expect(returnedBenefits(gifts, new Map([[product, 1n]]))[0].spend).toBe(43);
});
test("F-504 partial returns stage each remaining earning reversal once and release valued spend without erasing history", async () => {
  const h = await startHarness({ installers: [] });
  try {
    const unit = await ensureRoot(h.db),
      now = Date.now();
    const [outlet] =
      await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,channel,created_by) values('sunpride','SAMPLE-RETURN','Sample return store','active',${unit},'GT','sample') returning id`;
    const [campaign] =
      await h.db`insert into campaigns(code) values('SAMPLE-RETURN') returning id`;
    const [version] =
      await h.db`insert into campaign_versions(campaign_id,version,name,mechanic,status,effective_from,effective_to,budget_centavos,expected_volume_base,expected_roi_bps,source,created_by) values(${campaign.id},1,'Sample returns','Sample return proration','active',${new Date(now - 1000)},${new Date(now + 86400000)},1000,3,1000,'sample','sample') returning id`;
    const [promotion] =
      await h.db`insert into promotions(organization_id,code,name,rule_kind,rule,status,source,effective_from,effective_to,campaign_version_id,benefit_timing) values('sunpride','SAMPLE-RETURN','Sample rebate','basket',${{ kind: "basket", minSubtotalCentavos: 1, valueCentavos: 100 }},'active','sample',${new Date(now - 1000)},${new Date(now + 86400000)},${version.id},'claimable') returning id`;
    const applied = {
      ...receipt.promotionsApplied[0],
      id: promotion.id,
      campaignVersionId: version.id,
    };
    const sale = {
      id: crypto.randomUUID(),
      receipt: { ...receipt, promotionsApplied: [applied] },
    };
    const c = {
      db: h.db,
      env: h.env,
      actor: { subject: "sample-return" },
      now,
    };
    await tx(h.db, (db) =>
      accrueOrder(
        { ...c, db },
        {
          id: sale.id,
          source_type: "van_sale",
          status: "approved",
          pricing_snapshot: { pricedAt: now, promotionsApplied: [applied] },
          customer_code: "SAMPLE",
          outlet_id: outlet.id,
          created_at: new Date(now),
        },
      ),
    );
    const first = crypto.randomUUID();
    await tx(h.db, (db) =>
      reverseVanBenefitTotals(
        { ...c, db },
        sale,
        first,
        new Map([[product, 1n]]),
      ),
    );
    await tx(h.db, (db) =>
      reverseVanBenefitTotals(
        { ...c, db },
        sale,
        first,
        new Map([[product, 1n]]),
      ),
    );
    await tx(h.db, (db) =>
      reverseVanBenefitTotals(
        { ...c, db },
        sale,
        crypto.randomUUID(),
        new Map([[product, 3n]]),
      ),
    );
    const [earning] =
      await h.db`select * from promotion_earnings where promotion_id=${promotion.id}`;
    expect(Number(earning.reversed_centavos)).toBe(100);
    const reversals =
      await h.db`select amount_centavos from tpm_posting_instructions where earning_id=${earning.id} and kind='reversal' order by amount_centavos`;
    expect(
      reversals.map((/** @type {any} */ r) => Number(r.amount_centavos)),
    ).toEqual([33, 67]);
    const [balance] =
      await h.db`select amount_centavos from campaign_commitment_balances where campaign_id=${campaign.id}`;
    expect(Number(balance.amount_centavos)).toBe(0);
    expect(
      (await h.db`select * from campaign_commitment_releases`).length,
    ).toBe(2);
  } finally {
    await h.close();
  }
}, 30000);
