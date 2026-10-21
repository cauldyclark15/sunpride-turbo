import { test, expect } from "bun:test";
import { startHarness, profileStore, createUser } from "./harness.js";
import { actorFor } from "../src/core/context.js";
import { schemeFeed, validateSaleSchemes } from "../src/domains/van/schemes.js";

test("F-110 published SQL scheme reaches its scoped van customer and canonical validation refuses withdrawal", async () => {
  const h = await startHarness();
  try {
    const people = profileStore(h);
    h.setHooks({ unitInScope: async () => true });
    const unit = crypto.randomUUID(),
      sku = crypto.randomUUID();
    await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SUNPRIDE','SAMPLE','national','active',now()-interval '1 day')`;
    const userId = await createUser(
      h,
      "scheme-feed@example.test",
      "test-only-scheme-password",
    );
    people.set(userId, {
      role: "sales",
      orgUnitId: unit,
      name: "SAMPLE seller",
    });
    const actor = await actorFor(h.db, userId);
    const [outlet] =
      await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,created_by) values('sunpride','SAMPLE-ONE','SAMPLE buyer','active',${unit},${userId}) returning *`;
    const rule = {
      kind: "percent_off",
      item: { productId: sku, uom: "EA", quantity: 1 },
      percentOffBasisPoints: 5000,
    };
    const [programme] =
      await h.db`insert into promotions(organization_id,code,name,rule_kind,rule,status,source,effective_from,eligibility) values('sunpride','SAMPLE-PUBLISHED','SAMPLE half off','percent_off',${rule},'active','sample','2026-01-01',${{ outletId: { include: [outlet.id] } }}) returning *`;
    const at = Date.now();
    const feed = await schemeFeed(
      h.db,
      actor,
      [{ outletId: outlet.id }],
      [{ productId: sku, uomCode: "EA" }],
      new Map(),
      at,
    );
    expect(feed.holds).toHaveLength(0);
    expect(feed.promotions).toHaveLength(1);
    expect(feed.promotions[0].outletIds).toEqual([outlet.id]);
    const meta = {
      promotionId: programme.id,
      code: programme.code,
      name: programme.name,
      kind: "percent_off",
    };
    const lines = [
      {
        productId: sku,
        uomCode: "EA",
        quantityScale: "1",
        quantityBase: "1",
        paidBase: "1",
        freeBase: "0",
        unitPriceMinor: "101",
        grossMinor: "101",
        discountMinor: "51",
        totalMinor: "50",
        priceListId: null,
      },
    ];
    const incoming = [{ ...lines[0], promotion: meta }];
    const applied = await validateSaleSchemes(
      h.db,
      actor,
      { organization_id: "sunpride" },
      outlet,
      lines,
      incoming,
      at,
    );
    expect(applied[0].id).toBe(programme.id);
    await h.db`update promotions set status='inactive' where id=${programme.id}`;
    await expect(
      validateSaleSchemes(
        h.db,
        actor,
        { organization_id: "sunpride" },
        outlet,
        structuredClone(lines),
        incoming,
        at,
      ),
    ).rejects.toThrow("no longer matches");
  } finally {
    await h.close();
  }
}, 120000);
