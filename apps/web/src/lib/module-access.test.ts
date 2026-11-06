import { describe, expect, it } from "vitest";
import {
  APP_ROLES,
  MODULE_ROLES,
  TARGET_MANAGERS,
  canAccessWebModule,
  isReadOnlyRole,
} from "./module-access";

type Capabilities = Record<string, readonly string[]>;

// The API is the authority; the web map mirrors it for UX only. A variable path
// keeps the plain-JS API module out of the web type graph.
const API_CAPABILITIES = new URL(
  "../../../api/src/core/capabilities.js",
  import.meta.url,
).href;
const api = (await import(/* @vite-ignore */ API_CAPABILITIES)) as {
  ROLES: readonly string[];
  CAPABILITIES: Capabilities;
};

const union = (...capabilities: string[]) =>
  [...new Set(capabilities.flatMap((c) => api.CAPABILITIES[c] ?? []))].sort();
const sorted = (roles: readonly string[]) => [...roles].sort();

describe("module access mirrors apps/api capabilities.js", () => {
  it("knows the same eight roles", () => {
    expect(sorted(APP_ROLES)).toEqual(sorted(api.ROLES));
  });

  it.each([
    ["admin", ["admin.manage"]],
    ["master-data", ["masterdata.manage"]],
    ["pricing", ["masterdata.manage"]],
    ["sap-integration", ["integration.read"]],
    ["agencies", ["integration.read"]],
    ["live-map", ["location.read"]],
    ["supervision", ["people.read"]],
    ["orders", ["order.create", "order.approve", "order.encode"]],
    ["outside-calls", ["order.encode", "visit.record"]],
    [
      "imports",
      [
        "masterdata.manage",
        "inventory.adjustment.request",
        "inventory.count.submit",
      ],
    ],
    [
      "workflows",
      [
        "order.approve",
        "van.load.approve",
        "van.damage.approve",
        "van.void.approve",
        "van.cash.approve",
        "van.stock.approve",
      ],
    ],
    ["van-trips", ["van.read"]],
    // IP-NAV: the Operations verbs.
    ["ops-stock", ["inventory.read"]],
    ["ops-receive", ["inventory.write"]],
    ["ops-transfers", ["inventory.write", "inventory.approve"]],
    ["ops-counts", ["inventory.count.submit", "inventory.count.approve"]],
    ["ops-van-day", ["van.manage", "van.load.approve"]],
    ["ops-stores-pos", ["van.cash.approve", "admin.manage"]],
    [
      "ops-decide",
      [
        "van.load.approve",
        "inventory.approve",
        "inventory.count.approve",
        "inventory.adjustment.approve",
        "van.cash.approve",
        "van.stock.approve",
      ],
    ],
    ["inventory", ["inventory.read"]],
    ["today", ["report.read"]],
  ] as const)("%s follows %j", (slug, capabilities) => {
    expect(sorted(MODULE_ROLES[slug])).toEqual(union(...capabilities));
  });

  it("owner pages stay inside report.read", () => {
    const readers = new Set(api.CAPABILITIES["report.read"]);
    for (const slug of [
      "sales",
      "coverage-people",
      "stores",
      "stock",
      "vans",
      "money",
      "decide",
    ] as const)
      for (const role of MODULE_ROLES[slug])
        expect(readers.has(role)).toBe(true);
  });

  it("only target.manage holders edit targets", () => {
    expect(sorted(TARGET_MANAGERS)).toEqual(union("target.manage"));
  });

  it("issues follow issues.read", () => {
    for (const role of APP_ROLES)
      expect(canAccessWebModule("issues", role)).toBe(
        api.CAPABILITIES["issues.read"]!.includes(role),
      );
  });
});

describe("owner pages per role", () => {
  const owner = [
    "today",
    "sales",
    "coverage-people",
    "stores",
    "stock",
    "vans",
    "money",
    "decide",
  ];

  it.each(["super_admin", "admin", "manager", "analyst", "viewer"])(
    "%s opens every owner page",
    (role) => {
      for (const slug of owner)
        expect(canAccessWebModule(slug, role)).toBe(true);
    },
  );

  it("sales open only Today (the server scopes it to themselves)", () => {
    expect(owner.filter((slug) => canAccessWebModule(slug, "sales"))).toEqual([
      "today",
    ]);
  });

  it("legacy slugs follow their destination", () => {
    expect(canAccessWebModule("dashboard", "sales")).toBe(true);
    expect(canAccessWebModule("analytics", "sales")).toBe(false);
    expect(canAccessWebModule("analytics", "viewer")).toBe(true);
  });

  it("refuses unknown slugs and missing roles", () => {
    expect(canAccessWebModule("metrics", "super_admin")).toBe(false);
    expect(canAccessWebModule("today", null)).toBe(false);
    expect(canAccessWebModule("today", "owner")).toBe(false);
  });

  it("analyst and viewer are read-only", () => {
    expect(APP_ROLES.filter(isReadOnlyRole)).toEqual(["analyst", "viewer"]);
  });
});
