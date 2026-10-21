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
import { install } from "../src/domains/fiscal/index.js";
import {
  saveRule,
  decideOverride,
  authorityContext,
} from "../src/domains/fiscal/authority.js";
import {
  saleDiscountFacts,
  enforceDiscount,
} from "../src/domains/fiscal/discounts.js";
import { verifyOfflineApprovalGrant } from "../src/domains/fiscal/offline-grants.js";
import { canonicalJson, sha256Hex } from "../src/core/util.js";

test("F-110/F-124 exact-cart native approval, live approver withdrawal and one-time canonical consumption", async () => {
  const h = await startHarness({ installers: [install] });
  try {
    const people = profileStore(h),
      unit = crypto.randomUUID();
    h.setHooks({ unitInScope: async () => true });
    await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SUNPRIDE','SAMPLE','national','active',now()-interval '1 day')`;
    await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values('finish-discount','org_units',${unit},'SAMPLE')`;
    const seller = await boundDevice(h, people, {
      orgUnitId: unit,
      app: "van-android",
    });
    const bossId = await createUser(
      h,
      "discount-approver@example.test",
      "test-only-discount-password",
    );
    const boss = {
      userId: bossId,
      email: "discount-approver@example.test",
      profile: people.set(bossId, {
        role: "super_admin",
        orgUnitId: unit,
        name: "SAMPLE approver",
      }),
    };
    for (const user of [seller, boss]) {
      const p = user.profile;
      await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${user.userId},${user.userId},${p.name},${user.email},${p.role},'active',${unit})`;
      await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},${p.role},now()-interval '1 day','SAMPLE','SAMPLE')`;
    }
    const actor = await actorFor(h.db, seller.userId),
      admin = await actorFor(h.db, bossId);
    if (!actor || !admin) throw new Error("SAMPLE actors missing");
    const rule = await tx(h.db, (db) =>
      saveRule(db, admin, {
        orgUnitId: unit,
        kind: "discount",
        role: "sales",
        channel: "general_trade",
        minCentavos: "0",
        maxCentavos: "100000",
        selfLimitCentavos: "1000",
        approverRoles: ["super_admin"],
        offlineAllowed: true,
        effectiveFrom: new Date(Date.now() - 60000).toISOString(),
      }),
    );
    const gross = 10000n,
      reduction = 2000n,
      total = gross - reduction,
      saleId = crypto.randomUUID(),
      customerId = crypto.randomUUID();
    const line = {
      productId: crypto.randomUUID(),
      code: "SAMPLE-1",
      name: "SAMPLE ñ </x>\u2028🙂",
      uomCode: "CASE",
      quantityScale: "1000",
      quantityBase: "1000",
      unitPriceMinor: String(gross),
      grossMinor: String(gross),
      discountMinor: String(reduction),
      totalMinor: String(total),
    };
    const facts = saleDiscountFacts(saleId, customerId, [line], String(total)),
      id = crypto.randomUUID(),
      reason = "SAMPLE negotiated reduction";
    const body = {
      id,
      expectedRequesterId: actor.profileId,
      orgUnitId: unit,
      kind: "discount",
      channel: "general_trade",
      amountCentavos: String(reduction),
      facts,
      reason,
    };
    const response = await h.fetch("/api/v1/fiscal/overrides/request", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${seller.access}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).requiresSecond).toBe(true);
    const decided = await tx(h.db, (db) =>
      decideOverride(
        db,
        admin,
        {
          id,
          decision: "approved",
          reason: "SAMPLE independent review",
          offline: true,
        },
        h.env,
      ),
    );
    expect(decided.offlineGrant).toMatch(/^SP-APPROVAL1\./);
    const status = await h.fetch("/api/v1/fiscal/overrides/status", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${seller.access}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id }),
    });
    expect(status.status).toBe(200);
    const approved = await status.json();
    expect(approved.status).toBe("approved");
    const claims = verifyOfflineApprovalGrant(h.env, approved.grant);
    expect(claims.factsHash).toBe(sha256Hex(canonicalJson(facts)));
    const context = await authorityContext(h.db, actor, unit, h.env);
    if (process.env.SP_NATIVE_OVERRIDE_WIRE)
      await writeFile(
        process.env.SP_NATIVE_OVERRIDE_WIRE,
        JSON.stringify({
          grant: approved.grant,
          authority: context,
          facts,
          reason,
          ruleId: rule.id,
          at: claims.issuedAt,
          amountMinor: Number(reduction),
          channel: "general_trade",
        }),
        { mode: 0o600 },
      );
    const parts = approved.grant.split(".");
    parts[1] = Buffer.from(
      JSON.stringify({ ...claims, amountCentavos: "1" }),
    ).toString("base64url");
    expect(() => verifyOfflineApprovalGrant(h.env, parts.join("."))).toThrow(
      "invalid",
    );
    const consume = {
      ...body,
      overrideId: id,
      operationId: crypto.randomUUID(),
      offlineCode: approved.grant,
    };
    await expect(
      tx(h.db, (db) =>
        enforceDiscount(
          db,
          actor,
          { ...consume, facts: { ...facts, totalMinor: String(total + 1n) } },
          h.env,
        ),
      ),
    ).rejects.toThrow("exact transaction facts");
    await h.db`update profiles set status='disabled' where id=${boss.profile.id}`;
    await expect(
      tx(h.db, (db) => enforceDiscount(db, actor, consume, h.env)),
    ).rejects.toThrow();
    expect(
      (
        await h.db`select id from fiscal_override_events where request_id=${id} and kind='consumed'`
      ).length,
    ).toBe(0);
    await h.db`update profiles set status='active' where id=${boss.profile.id}`;
    await tx(h.db, (db) => enforceDiscount(db, actor, consume, h.env));
    await expect(
      tx(h.db, (db) =>
        enforceDiscount(
          db,
          actor,
          { ...consume, operationId: crypto.randomUUID() },
          h.env,
        ),
      ),
    ).rejects.toThrow("already consumed");
    expect(
      (
        await h.db`select id from fiscal_override_events where request_id=${id} and kind='consumed'`
      ).length,
    ).toBe(1);
  } finally {
    await h.close();
  }
}, 120000);
