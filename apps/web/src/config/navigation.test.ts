import { describe, expect, it, vi } from "vitest";
import {
  getWebModuleTabs,
  getWebNavigation,
  isWebModuleSlug,
  navigationForRole,
} from "./navigation";

describe("web navigation", () => {
  it.each([
    ["/dashboard", "home"],
    ["/orders", "commercial"],
    ["/outside-calls", "commercial"],
    ["/master-data", "commercial"],
    ["/imports", "commercial"],
    ["/inventory", "inventory"],
    ["/sales-force", "field"],
    ["/supervision", "field"],
    ["/call-sheets", "field"],
    ["/daily-sales", "field"],
    ["/training", "field"],
    ["/activity-reports", "field"],
    ["/sap-integration", "operations"],
    ["/workflows", "approvals"],
    ["/analytics", "reports"],
    ["/admin", "admin"],
  ])("maps %s to the %s sidebar module", (pathname, expected) => {
    expect(getWebNavigation(pathname, true).activePrimaryId).toBe(expected);
  });

  it.each(["/issues", "/issues/new", "/issues/12"])(
    "highlights Issues on %s",
    (pathname) => {
      expect(getWebNavigation(pathname, true, true).activePrimaryId).toBe(
        "issues",
      );
      expect(getWebModuleTabs(pathname)).toEqual([]);
    },
  );

  it("shows Issues only to people with tracker access", () => {
    const hrefs = (canSeeIssues: boolean) =>
      getWebNavigation("/dashboard", false, canSeeIssues).navGroups.flatMap(
        (group) => group.items.map((item) => item.href),
      );
    expect(hrefs(false)).not.toContain("/issues");
    expect(hrefs(true)).toContain("/issues");
    expect(isWebModuleSlug("issues")).toBe(false);
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
      "/outside-calls",
      "/master-data",
      "/imports",
    ]);
    expect(getWebModuleTabs("/imports").map((item) => item.href)).toEqual([
      "/orders",
      "/outside-calls",
      "/master-data",
      "/imports",
    ]);
    expect(getWebModuleTabs("/sales-force").map((item) => item.href)).toEqual([
      "/sales-force",
      "/supervision",
      "/call-sheets",
      "/daily-sales",
      "/training",
      "/activity-reports",
    ]);
    expect(getWebModuleTabs("/supervision").map((item) => item.label)).toEqual([
      "Coverage",
      "Supervision",
      "Call sheets",
      "Daily sales report",
      "Training",
      "DAR / ROAR",
    ]);
    expect(getWebModuleTabs("/call-sheets").map((item) => item.href)).toEqual([
      "/sales-force",
      "/supervision",
      "/call-sheets",
      "/daily-sales",
      "/training",
      "/activity-reports",
    ]);
    expect(getWebModuleTabs("/mobile")).toEqual([]);
    expect(getWebModuleTabs("/dashboard")).toEqual([]);
  });

  it("hides the Integration (SAP) module for the beta", () => {
    const hrefs = () =>
      getWebNavigation("/dashboard", true, true).navGroups.flatMap((group) =>
        group.items.map((item) => item.href),
      );
    expect(hrefs()).not.toContain("/sap-integration");
    expect(hrefs()).toContain("/issues");
    expect(hrefs()).toContain("/admin");
    // The beta feature list switches it back on.
    vi.stubEnv("NEXT_PUBLIC_BETA_ENABLE", "integration");
    expect(hrefs()).toContain("/sap-integration");
    vi.unstubAllEnvs();
  });

  it("shows each role only the sidebar items it can open", () => {
    const groups = getWebNavigation("/dashboard", false, true).navGroups;
    const items = (opens: string[]) =>
      navigationForRole(groups, (slug) => opens.includes(slug)).flatMap(
        (group) => group.items.map((item) => `${item.label}:${item.href}`),
      );
    // A seller opens orders but not approvals.
    expect(items(["dashboard", "orders", "sales-force", "analytics"])).toEqual([
      "Home:/dashboard",
      "Commercial:/orders",
      "Field:/sales-force",
      "Reports:/analytics",
      "Issues:/issues",
    ]);
    // A role without Orders still reaches Commercial through its first open tab.
    expect(items(["master-data"])).toEqual([
      "Commercial:/master-data",
      "Issues:/issues",
    ]);
    // Supervision only: Field points at it instead of an Access denied page.
    expect(items(["supervision"])).toContain("Field:/supervision");
    expect(navigationForRole(groups, () => false)).toEqual([
      { ...groups[0], items: [groups[0]!.items.at(-1)] },
    ]);
  });

  it("recognizes only configured module slugs", () => {
    expect(isWebModuleSlug("orders")).toBe(true);
    expect(isWebModuleSlug("admin")).toBe(true);
    expect(isWebModuleSlug("mobile")).toBe(false);
    expect(isWebModuleSlug("not-a-module")).toBe(false);
    expect(isWebModuleSlug("toString")).toBe(false);
  });
});
