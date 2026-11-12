import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness } from "./harness.js";
import {
  activePromotions,
  alignPromotionPriceLists,
} from "../src/domains/tpm/active.js";
import { nativePromotions } from "../src/domains/tpm/native-context.js";
import { evaluateSchemes } from "../src/domains/tpm/engine.js";

/** @type {any} */ let h;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});

test("FLD-116 a legacy price-list promotion applies to lines priced from that list's SAP mirror", async () => {
  const db = h.db;
  const epoch = new Date(Date.now() - 86400000);
  const product = { id: crypto.randomUUID() }; // rule JSON only; no product FK
  const [governed] =
    await db`insert into price_lists(organization_id,code,name,channel_key,currency,status,source,effective_from) values('sunpride','SMP-SUPERMARKET','Sample supermarket prices','supermarket','PHP','active','sample',${epoch}) returning id`;
  const [mirror] =
    await db`insert into price_lists(organization_id,code,name,channel_key,currency,status,source,effective_from) values('sunpride','SAP-SMP-SUPERMARKET','SAP SMP-SUPERMARKET','supermarket','PHP','active','sap',${epoch}) returning id`;
  const [other] =
    await db`insert into price_lists(organization_id,code,name,channel_key,currency,status,source,effective_from) values('sunpride','SMP-GT','Sample gt prices','gt','PHP','active','sample',${epoch}) returning id`;
  const rule = {
    kind: "percent_off",
    item: { productId: product.id, uom: "CASE", quantity: 1 },
    percentOffBasisPoints: 500,
  };
  await db`insert into promotions(organization_id,code,name,price_list_id,rule_kind,rule,status,source,effective_from) values
    ('sunpride','SMP-PROMO-3','Sample Mixes display offer',${governed.id},'percent_off',${rule},'active','sample',${epoch}),
    ('sunpride','SMP-PROMO-1','Sample gt offer',${other.id},'percent_off',${rule},'active','sample',${epoch})`;
  const now = Date.now();
  const lines = [
    {
      productId: product.id,
      uom: "CASE",
      quantity: "1",
      unitPriceCentavos: 181104,
      lineTotalCentavos: 181104,
      priceListId: mirror.id,
    },
  ];
  const units = [{ productId: product.id, uom: "CASE" }];
  const facts = { channelKey: "supermarket" };
  const raw = await activePromotions(db, "sunpride", now);
  // The bug: SAP-quoted lines carry the mirror list id, so the pinned promotion never matched.
  expect(
    evaluateSchemes(lines, nativePromotions(raw, facts, units), facts)
      .promotionsApplied,
  ).toEqual([]);
  const aligned = await alignPromotionPriceLists(db, raw, [mirror.id]);
  expect(aligned.find((p) => p.code === "SMP-PROMO-3").price_list_id).toBe(
    mirror.id,
  );
  // A promotion on an unrelated list is not widened.
  expect(aligned.find((p) => p.code === "SMP-PROMO-1").price_list_id).toBe(
    other.id,
  );
  const quote = evaluateSchemes(
    lines,
    nativePromotions(aligned, facts, units),
    facts,
  );
  expect(quote.promotionsApplied.map((p) => p.code)).toEqual(["SMP-PROMO-3"]);
  expect(quote.lineDiscounts).toEqual([9055]);
});
