import { test, expect } from "bun:test";
import { tx } from "@sunpride/db/client";
import { writeFile } from "node:fs/promises";
import {
  startHarness,
  profileStore,
  boundDevice,
  createUser,
} from "./harness.js";
import { actorFor } from "../src/core/context.js";
import {
  requestOverride,
  decideOverride,
  readOverride,
  authorityContext,
} from "../src/domains/fiscal/authority.js";
import {
  saleOverrideFacts,
  priceOverrideAmount,
  enforceFinancialOverride,
} from "../src/domains/fiscal/discounts.js";
test("F-124 exact price and local credit exceptions share one matrix; consumed replay still checks current approver authority", async () => {
  const h = await startHarness();
  try {
    const people = profileStore(h),
      unit = crypto.randomUUID();
    h.setHooks({ unitInScope: async () => true });
    await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SUNPRIDE','SAMPLE','national','active',now()-interval '1 day')`;
    const seller = await boundDevice(h, people, {
        orgUnitId: unit,
        role: "super_admin",
        app: "van-android",
      }),
      bossId = await createUser(
        h,
        "price-admin@example.test",
        "test-only-price-password",
      ),
      boss = people.set(bossId, {
        role: "super_admin",
        orgUnitId: unit,
        name: "SAMPLE reviewer",
      });
    for (const { uid, p } of [
      { uid: seller.userId, p: seller.profile },
      { uid: bossId, p: boss },
    ]) {
      await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${uid},${uid},${p.name},${`SAMPLE-${uid}@example.test`},${p.role},'active',${unit})`;
      await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},${p.role},now()-interval '1 day','SAMPLE','SAMPLE')`;
    }
    const actor = await actorFor(h.db, seller.userId),
      admin = await actorFor(h.db, bossId);
    if (!actor || !admin) throw Error("SAMPLE actors missing");
    for (const kind of ["price", "credit"])
      await h.db`insert into fiscal_authority_rules(org_unit_id,kind,role,channel,min_centavos,max_centavos,self_limit_centavos,approver_roles,offline_allowed,effective_from,sample) values(${unit},${kind},${seller.profile.role},'general_trade',0,1000000,0,${["super_admin"]},true,'2026-01-01',true)`;
    const saleId = crypto.randomUUID(),
      customerId = crypto.randomUUID(),
      productId = crypto.randomUUID(),
      listId = crypto.randomUUID();
    const lines = [
      {
        productId,
        code: "SAMPLE-PRICE",
        name: "SAMPLE price item",
        uomCode: "EA",
        quantityScale: "1",
        quantityBase: "2",
        paidBase: "2",
        freeBase: "0",
        originalUnitPriceMinor: "12000",
        unitPriceMinor: "10000",
        grossMinor: "20000",
        discountMinor: "0",
        totalMinor: "20000",
      },
    ];
    const amount = String(priceOverrideAmount(lines)),
      reason = "SAMPLE independently agreed price";
    const priceFacts = saleOverrideFacts(
        "price",
        saleId,
        customerId,
        lines,
        "20000",
      ),
      creditFacts = saleOverrideFacts(
        "credit",
        saleId,
        customerId,
        lines,
        "20000",
      );
    /** @type {Record<string,any>} */ const grants = {};
    /** @type {Array<[string,any,string]>} */ const cases = [
      ["price", priceFacts, amount],
      ["credit", creditFacts, "20000"],
    ];
    for (const [kind, facts, value] of cases) {
      const id = crypto.randomUUID();
      const input = {
        id,
        kind,
        facts,
        orgUnitId: unit,
        channel: "general_trade",
        amountCentavos: value,
        reason,
      };
      await tx(h.db, (db) => requestOverride(db, actor, input));
      await expect(
        tx(h.db, (db) =>
          decideOverride(db, actor, {
            id,
            decision: "approved",
            reason: "SAMPLE",
          }),
        ),
      ).rejects.toThrow("second person");
      await tx(h.db, (db) =>
        decideOverride(
          db,
          admin,
          {
            id,
            decision: "approved",
            reason: "SAMPLE reviewed",
            offline: true,
          },
          h.env,
        ),
      );
      const status = await tx(h.db, (db) => readOverride(db, actor, id, h.env));
      expect(status.status).toBe("approved");
      grants[kind] = { ...input, grant: status.grant };
    }
    const authority = await tx(h.db, (db) =>
        authorityContext(db, actor, unit, h.env),
      ),
      operationId = crypto.randomUUID();
    const p = {
      ...grants.price,
      overrideId: grants.price.id,
      operationId,
      offlineCode: grants.price.grant,
    };
    await expect(
      tx(h.db, (db) =>
        enforceFinancialOverride(
          db,
          actor,
          { ...p, facts: { ...priceFacts, totalMinor: "20001" } },
          h.env,
        ),
      ),
    ).rejects.toThrow("exact transaction facts");
    await tx(h.db, (db) => enforceFinancialOverride(db, actor, p, h.env));
    expect(
      (
        await h.db`select count(*)::int as n from fiscal_override_events where request_id=${p.overrideId} and kind='consumed'`
      )[0].n,
    ).toBe(1);
    if (process.env.SP_NATIVE_PRICE_WIRE)
      await writeFile(
        process.env.SP_NATIVE_PRICE_WIRE,
        JSON.stringify({
          at: Date.now(),
          saleId,
          customerId,
          productId,
          listId,
          reason,
          lines,
          amount,
          authority,
          grants,
        }),
        { mode: 0o600 },
      );
    boss.status = "disabled";
    await h.db`update profiles set status='disabled' where id=${boss.id}`;
    await expect(
      tx(h.db, (db) => enforceFinancialOverride(db, actor, p, h.env)),
    ).rejects.toThrow();
  } finally {
    await h.close();
  }
}, 120000);
