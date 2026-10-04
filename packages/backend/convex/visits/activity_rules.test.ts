import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";
import {
  DEFAULT_ACTIVITY_RULE_VERSION,
  DEFAULT_ACTIVITY_RULES,
  missingKinds,
  requiredKinds,
  ruleVersionFor,
  VISIT_INTENTS,
  type ActivityRule,
} from "./activity_rules";

const now = Date.parse("2026-10-04T02:00:00Z");
type T = TestConvex<typeof schema>;

const rules: ActivityRule[] = [
  {
    intent: "merchandise",
    version: "v1",
    activities: [
      { kind: "merchandising", required: true },
      { kind: "price_check", required: false },
    ],
  },
  {
    intent: "audit",
    version: "v2",
    activities: [
      { kind: "inventory_check", required: true },
      { kind: "merchandising", required: true },
    ],
  },
  { intent: "deliver", version: "v3", activities: [] },
];

describe("activity rule evaluation (pure)", () => {
  it("unions required kinds across intents once, ignoring optional ones", () => {
    expect(requiredKinds(rules, ["merchandise", "audit"])).toEqual([
      "merchandising",
      "inventory_check",
    ]);
    expect(requiredKinds(rules, ["deliver"])).toEqual([]);
    expect(requiredKinds(rules, ["unknown"])).toEqual([]);
  });
  it("reports only required kinds not yet recorded", () => {
    expect(
      missingKinds(rules, ["merchandise", "audit"], ["merchandising", "note"]),
    ).toEqual(["inventory_check"]);
    expect(missingKinds(rules, ["merchandise"], ["merchandising"])).toEqual([]);
  });
  it("names the governing rule versions for the visit's intents only", () => {
    expect(ruleVersionFor(rules, ["audit", "merchandise"])).toBe(
      "merchandise=v1,audit=v2",
    );
  });
  it("has a provisional default for every intent, each kind at most once", () => {
    for (const intent of VISIT_INTENTS) {
      const kinds = DEFAULT_ACTIVITY_RULES[intent].map((a) => a.kind);
      expect(new Set(kinds).size).toBe(kinds.length);
    }
  });
});

async function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const t: T = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const root = await ctx.db.insert("orgUnits", {
      organizationId: "sunpride",
      code: "SUNPRIDE",
      name: "National",
      typeCode: "NATIONAL",
      status: "active",
      effectiveFrom: now - 10e7,
      createdAt: now,
      updatedAt: now,
    });
    const region = await ctx.db.insert("orgUnits", {
      organizationId: "sunpride",
      code: "NCR",
      name: "NCR",
      typeCode: "REGION",
      parentId: root,
      status: "active",
      effectiveFrom: now - 10e7,
      createdAt: now,
      updatedAt: now,
    });
    for (const [subject, role, unit] of [
      ["ops", "operations", root],
      ["regional", "operations", region],
      ["sales", "sales", region],
    ] as const)
      await ctx.db.insert("profiles", {
        authSubject: `https://auth.test|${subject}`,
        name: subject,
        email: `${subject}@test.local`,
        role,
        status: "active",
        orgUnitId: unit,
        updatedAt: now,
      });
  });
  const as = (subject: string) =>
    t.withIdentity({
      issuer: "https://auth.test",
      subject,
      email: `${subject}@test.local`,
    });
  return { t, ops: as("ops"), regional: as("regional"), sales: as("sales") };
}

describe("office-configured activity rules", () => {
  it("serves defaults, then a future office rule from its effective instant", async () => {
    const f = await fixture();
    try {
      const before = await f.ops.query(api.visits.activity_rules.current, {});
      expect(before.map((r) => r.intent)).toEqual([...VISIT_INTENTS]);
      expect(before.every((r) => r.provisional)).toBe(true);
      expect(before[0]!.version).toBe(DEFAULT_ACTIVITY_RULE_VERSION);
      const from = now + 60_000;
      const id = await f.ops.mutation(api.visits.activity_rules.set, {
        intent: "sell",
        activities: [{ kind: "note", required: true }],
        effectiveFrom: from,
        sourceRef: "Sales ops memo 2026-10",
        provisional: false,
      });
      const at = async (asOf: number) =>
        (await f.sales.query(api.visits.activity_rules.current, { asOf })).find(
          (r) => r.intent === "sell",
        )!;
      expect((await at(now)).version).toBe(DEFAULT_ACTIVITY_RULE_VERSION);
      expect(await at(from)).toMatchObject({
        version: `rule:${id}`,
        activities: [{ kind: "note", required: true }],
        provisional: false,
      });
      // A later revision closes the open row instead of rewriting it.
      const next = await f.ops.mutation(api.visits.activity_rules.set, {
        intent: "sell",
        activities: [],
        effectiveFrom: from + 60_000,
        sourceRef: "Revision",
        provisional: false,
      });
      expect((await at(from)).version).toBe(`rule:${id}`);
      expect((await at(from + 60_000)).version).toBe(`rule:${next}`);
      expect((await f.t.run((ctx) => ctx.db.get(id)))?.effectiveTo).toBe(
        from + 60_000,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses past, overlapping, duplicate-kind and non-national changes", async () => {
    const f = await fixture();
    try {
      const base = {
        intent: "audit" as const,
        activities: [{ kind: "inventory_check" as const, required: true }],
        sourceRef: "Office",
        provisional: false,
      };
      await expect(
        f.ops.mutation(api.visits.activity_rules.set, {
          ...base,
          effectiveFrom: now - 1,
        }),
      ).rejects.toThrow(/future-effective/);
      await expect(
        f.ops.mutation(api.visits.activity_rules.set, {
          ...base,
          activities: [
            { kind: "note", required: true },
            { kind: "note", required: false },
          ],
          effectiveFrom: now + 60_000,
        }),
      ).rejects.toThrow(/invalid_request/);
      await f.ops.mutation(api.visits.activity_rules.set, {
        ...base,
        effectiveFrom: now + 120_000,
      });
      await expect(
        f.ops.mutation(api.visits.activity_rules.set, {
          ...base,
          effectiveFrom: now + 60_000,
        }),
      ).rejects.toThrow(/conflict/);
      await expect(
        f.regional.mutation(api.visits.activity_rules.set, {
          ...base,
          effectiveFrom: now + 600_000,
        }),
      ).rejects.toThrow(/scope/);
      await expect(
        f.sales.mutation(api.visits.activity_rules.set, {
          ...base,
          effectiveFrom: now + 600_000,
        }),
      ).rejects.toThrow(/permission/i);
    } finally {
      vi.useRealTimers();
    }
  });
});
