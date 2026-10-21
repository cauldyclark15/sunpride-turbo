import { afterAll, beforeAll, expect, test } from "bun:test";
import { tx } from "@sunpride/db/client";
import { startHarness, createUser } from "./harness.js";
import { actorFor } from "../src/core/context.js";
import { ensureRoot } from "../src/domains/org/identity.js";
import { install as org } from "../src/domains/org/index.js";
import {
  requestOverride,
  decideOverride,
} from "../src/domains/fiscal/authority.js";
import { authorizeCampaignQuote } from "../src/domains/tpm/authority.js";
/** @type {any} */ let h;
/** @type {any} */ let c;
/** @type {any} */ let approver;
/** @type {any} */ let unit;
const q = {
  kind: "discount",
  channelKey: "general_trade",
  outletId: null,
  subtotalCentavos: 1000,
  totalCentavos: 900,
  promotions: [
    { campaignVersionId: crypto.randomUUID(), discountCentavos: 100 },
  ],
  lines: [
    {
      productId: crypto.randomUUID(),
      quantityBase: 1,
      unitPriceCentavos: 1000,
    },
  ],
};
beforeAll(async () => {
  h = await startHarness({ installers: [org] });
  unit = await ensureRoot(h.db);
  for (const [i, role] of ["super_admin", "approver"].entries()) {
    const email = `sample-authority-${i}@example.com`,
      user = await createUser(h, email, "Test-only-authority-fixture");
    const [p] =
      await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id) values(${user},${user},'Sample authority',${email},${role},'active',${unit}) returning id`;
    await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},${role},${new Date(Date.now() - 86400000)},${user},'Sample fixture')`;
    const actor = await actorFor(h.db, user);
    if (i === 0) c = { db: h.db, actor };
    else approver = actor;
  }
  await h.db`insert into fiscal_authority_rules(org_unit_id,kind,role,channel,min_centavos,max_centavos,self_limit_centavos,approver_roles,effective_from,sample) values(${unit},'discount','super_admin','general_trade',0,10000,50,'["approver"]'::jsonb,${new Date(Date.now() - 86400000)},true)`;
}, 60000);
afterAll(async () => {
  await h?.close();
});
test("F-511 quote previews share fiscal approval facts but only an order spends the second-person approval", async () => {
  expect((await authorizeCampaignQuote(c, q)).status).toBe("approval_required");
  const id = crypto.randomUUID();
  await tx(h.db, (db) =>
    requestOverride(db, c.actor, {
      id,
      kind: "discount",
      orgUnitId: unit,
      channel: q.channelKey,
      amountCentavos: "100",
      facts: q,
      reason: "Sample campaign above self limit",
    }),
  );
  await tx(h.db, (db) =>
    decideOverride(db, approver, {
      id,
      decision: "approved",
      reason: "Sample approval",
    }),
  );
  const approved = { ...q, discountOverrideId: id };
  expect(
    (await tx(h.db, (db) => authorizeCampaignQuote({ ...c, db }, approved)))
      .status,
  ).toBe("authorized");
  expect(
    Number(
      (
        await h.db`select count(*)::int as n from fiscal_override_events where kind='consumed'`
      )[0].n,
    ),
  ).toBe(0);
  await tx(h.db, (db) =>
    authorizeCampaignQuote(
      { ...c, db, orderAuthorityOperationId: crypto.randomUUID() },
      approved,
    ),
  );
  expect(
    Number(
      (
        await h.db`select count(*)::int as n from fiscal_override_events where kind='consumed'`
      )[0].n,
    ),
  ).toBe(1);
  await expect(
    tx(h.db, (db) =>
      authorizeCampaignQuote(
        { ...c, db, orderAuthorityOperationId: crypto.randomUUID() },
        approved,
      ),
    ),
  ).rejects.toThrow();
});
