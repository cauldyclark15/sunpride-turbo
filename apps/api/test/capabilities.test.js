import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  CAPABILITIES,
  ROLES,
  capabilitiesFor,
  isReadOnlyCapability,
  requireCapability,
  requireNationalScope,
  requireScopedRole,
} from "../src/core/capabilities.js";
import { ApiError } from "../src/core/errors.js";
import { resetHooks, setHooks } from "../src/core/hooks.js";

const A = [
  "super_admin",
  "admin",
  "operations",
  "manager",
  "approver",
  "sales",
  "analyst",
  "viewer",
];
/** Independent copy of backend inventory §3 "Full capability grants" (51 rows). */
const EXPECTED = {
  "admin.manage": ["super_admin", "admin"],
  "org.read": A,
  "people.read": ["super_admin", "admin", "manager", "analyst", "viewer"],
  "territory.read": A,
  "route.read": A,
  "outlet.read": A,
  "territory.manage": ["super_admin", "admin"],
  "route.manage": ["super_admin", "admin", "operations"],
  "outlet.manage": ["super_admin", "admin", "operations"],
  "outlet.verify": ["super_admin", "admin", "manager"],
  "outlet.enrol.propose": ["super_admin", "manager", "sales"],
  "outlet.enrol.approve": ["super_admin", "manager"],
  "outlet.assign": ["super_admin", "admin", "operations"],
  "masterdata.manage": ["super_admin", "admin", "operations"],
  "inventory.read": A,
  "inventory.write": ["super_admin", "admin", "operations"],
  "inventory.approve": ["super_admin", "approver"],
  "inventory.adjustment.request": [
    "super_admin",
    "admin",
    "operations",
    "manager",
  ],
  "inventory.count.submit": ["super_admin", "admin", "operations", "manager"],
  "inventory.adjustment.approve": [
    "super_admin",
    "admin",
    "manager",
    "approver",
  ],
  "inventory.count.approve": ["super_admin", "admin", "manager", "approver"],
  "mcp.read": A,
  "mcp.plan": ["super_admin", "admin", "manager", "sales"],
  "mcp.approve": ["super_admin", "manager"],
  "visit.record": ["super_admin", "manager", "sales"],
  "visit.locationException.approve": ["super_admin", "manager"],
  "visit.read": A,
  "order.create": ["super_admin", "manager", "sales"],
  "location.read": [
    "super_admin",
    "admin",
    "operations",
    "manager",
    "sales",
    "analyst",
  ],
  "order.approve": ["super_admin", "manager", "approver"],
  "order.encode": ["super_admin", "admin", "operations"],
  "deliverable.submit": ["super_admin", "manager", "sales"],
  "deliverable.review": ["super_admin", "manager"],
  "perdiem.submit": ["super_admin", "manager", "sales"],
  "perdiem.approve": ["super_admin", "manager", "approver"],
  "report.read": A,
  "target.manage": ["super_admin", "admin", "manager"],
  "integration.read": ["super_admin", "admin", "operations"],
  "integration.manage": ["super_admin", "admin"],
  "issues.read": A,
  "issues.write": A,
  "issues.triage": [
    "super_admin",
    "admin",
    "operations",
    "manager",
    "approver",
  ],
  "issues.manage": ["super_admin", "admin"],
  "van.read": A,
  "van.manage": ["super_admin", "admin", "operations"],
  "van.operate": ["super_admin", "manager", "sales"],
  "van.load.approve": ["super_admin", "manager", "approver"],
  "van.damage.approve": ["super_admin", "manager", "approver"],
  "van.void.approve": ["super_admin", "manager", "approver"],
  "van.cash.approve": ["super_admin", "manager", "approver"],
  "van.stock.approve": ["super_admin", "manager", "approver"],
};

/** @param {string} cap @returns {string[]} */
const rolesOf = (cap) => [...(CAPABILITIES[cap] ?? [])];

/** @param {string} role @param {string|null} [orgUnitId] */
const ctxFor = (role, orgUnitId = "unit-a") => ({
  db: null,
  actor: {
    userId: "u",
    profileId: "p",
    role,
    orgUnitId,
    capabilities: new Set(capabilitiesFor(role)),
    subject: "u",
    name: null,
    scopeEpoch: null,
  },
});

/** @param {Promise<unknown>} p */
async function outcome(p) {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
}

describe("capability table", () => {
  test("51 grants, 8 roles, identical to the inventory table", () => {
    expect(Object.keys(CAPABILITIES).length).toBe(51);
    expect(/** @type {string[]} */ ([...ROLES])).toEqual(A);
    expect(Object.keys(CAPABILITIES).sort()).toEqual(
      Object.keys(EXPECTED).sort(),
    );
    for (const [cap, roles] of Object.entries(EXPECTED))
      expect(rolesOf(cap)).toEqual(roles);
  });

  test("matches the Convex source while it still exists", async () => {
    const src = resolve(
      import.meta.dir,
      "../../../packages/backend/convex/lib/capabilities.ts",
    );
    if (!existsSync(src)) return;
    const text = await Bun.file(src).text();
    const block = text.slice(
      text.indexOf("export const CAPABILITIES = {"),
      text.indexOf("} as const satisfies"),
    );
    /** @type {Record<string, string[]>} */
    const parsed = {};
    for (const m of block.matchAll(/"([a-zA-Z.]+)":\s*\[([^\]]*)\]/g))
      parsed[/** @type {string} */ (m[1])] = [
        .../** @type {string} */ (m[2]).matchAll(/"([a-z_]+)"/g),
      ].map((x) => /** @type {string} */ (x[1]));
    expect(Object.keys(parsed).length).toBe(51);
    for (const [cap, roles] of Object.entries(parsed))
      expect(rolesOf(cap)).toEqual(roles);
  });

  test("analyst holds only read capabilities plus tester feedback", () => {
    for (const cap of capabilitiesFor("analyst"))
      expect(isReadOnlyCapability(cap) || cap === "issues.write").toBe(true);
  });
});

describe("requireCapability matrix", () => {
  test("every grant × role, no target unit", async () => {
    let checked = 0;
    for (const [cap, roles] of Object.entries(EXPECTED))
      for (const role of A) {
        const want =
          role === "super_admin" || roles.includes(role) ? "ok" : "forbidden";
        expect({
          cap,
          role,
          got: await outcome(requireCapability(ctxFor(role), cap)),
        }).toEqual({ cap, role, got: want });
        checked++;
      }
    expect(checked).toBe(51 * 8);
  });

  test("every grant × role with an out-of-scope target: only super_admin and analyst bypass", async () => {
    resetHooks();
    for (const [cap, roles] of Object.entries(EXPECTED))
      for (const role of A) {
        const holds = role === "super_admin" || roles.includes(role);
        const want = !holds
          ? "forbidden"
          : role === "super_admin" || role === "analyst"
            ? "ok"
            : "out_of_scope";
        expect({
          cap,
          role,
          got: await outcome(
            requireCapability(ctxFor(role), cap, "unit-elsewhere"),
          ),
        }).toEqual({
          cap,
          role,
          got: want,
        });
      }
  });

  test("in-scope target goes through the unitInScope hook", async () => {
    setHooks({
      unitInScope: async (_db, actor, unit) =>
        unit === "child-of-a" && actor.orgUnitId === "unit-a",
    });
    expect(
      await outcome(
        requireCapability(ctxFor("manager"), "mcp.approve", "child-of-a"),
      ),
    ).toBe("ok");
    expect(
      await outcome(
        requireCapability(ctxFor("manager"), "mcp.approve", "unit-z"),
      ),
    ).toBe("out_of_scope");
    expect(
      await outcome(
        requireCapability(ctxFor("manager", null), "mcp.approve", "child-of-a"),
      ),
    ).toBe("no_scope");
    resetHooks();
  });

  test("anonymous and unknown capability", async () => {
    expect(
      await outcome(requireCapability({ db: null, actor: null }, "org.read")),
    ).toBe("unauthenticated");
    expect(await outcome(requireCapability(ctxFor("admin"), "made.up"))).toBe(
      "internal",
    );
  });

  test("legacy scope helpers", async () => {
    resetHooks();
    expect(
      await outcome(requireScopedRole(ctxFor("admin"), ["admin"], "elsewhere")),
    ).toBe("out_of_scope");
    expect(
      await outcome(
        requireScopedRole(ctxFor("analyst"), ["analyst"], "elsewhere"),
      ),
    ).toBe("out_of_scope");
    expect(
      await outcome(requireScopedRole(ctxFor("super_admin"), [], "elsewhere")),
    ).toBe("ok");
    expect(
      await outcome(requireNationalScope(ctxFor("admin"), ["admin"])),
    ).toBe("out_of_scope");
    setHooks({ rootUnitId: async () => "unit-a" });
    expect(
      await outcome(requireNationalScope(ctxFor("admin"), ["admin"])),
    ).toBe("ok");
    expect(
      await outcome(requireNationalScope(ctxFor("sales"), ["admin"])),
    ).toBe("forbidden");
    resetHooks();
  });
});
