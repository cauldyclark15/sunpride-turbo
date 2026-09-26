import { describe, expect, it } from "vitest";
import {
  getWebModuleTabs,
  getWebNavigation,
  isWebModuleSlug,
} from "./navigation";

describe("web navigation", () => {
  it.each([
    ["/dashboard", "home"],
    ["/orders", "commercial"],
    ["/master-data", "commercial"],
    ["/imports", "commercial"],
    ["/inventory", "inventory"],
    ["/sales-force", "field"],
    ["/sap-integration", "operations"],
    ["/workflows", "approvals"],
    ["/analytics", "reports"],
    ["/admin", "admin"],
  ])("maps %s to the %s sidebar module", (pathname, expected) => {
    expect(getWebNavigation(pathname, true).activePrimaryId).toBe(expected);
  });

  it("keeps administration role-gated", () => {
    const labels = (canAdminister: boolean) =>
      getWebNavigation("/dashboard", canAdminister).navGroups.flatMap((group) =>
        group.items.map((item) => item.label),
      );

    expect(labels(false)).not.toContain("Admin");
    expect(labels(true)).toContain("Admin");
  });

  it("provides in-content tabs only for real subdivisions", () => {
    expect(getWebModuleTabs("/orders").map((item) => item.href)).toEqual([
      "/orders",
      "/master-data",
      "/imports",
    ]);
    expect(getWebModuleTabs("/imports").map((item) => item.href)).toEqual([
      "/orders",
      "/master-data",
      "/imports",
    ]);
    expect(getWebModuleTabs("/sales-force").map((item) => item.href)).toEqual([
      "/sales-force",
    ]);
    expect(getWebModuleTabs("/mobile")).toEqual([]);
    expect(getWebModuleTabs("/dashboard")).toEqual([]);
  });

  it("recognizes only configured module slugs", () => {
    expect(isWebModuleSlug("orders")).toBe(true);
    expect(isWebModuleSlug("admin")).toBe(true);
    expect(isWebModuleSlug("mobile")).toBe(false);
    expect(isWebModuleSlug("not-a-module")).toBe(false);
    expect(isWebModuleSlug("toString")).toBe(false);
  });
});
