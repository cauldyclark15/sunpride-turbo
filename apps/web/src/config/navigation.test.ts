import { describe, expect, it } from "vitest";
import { canAccessWebModule } from "../lib/module-access";
import {
  LEGACY_REDIRECTS,
  OWNER_PAGES,
  getWebNavigation,
  primaryIdFor,
} from "./navigation";

const navFor = (role: string, pathname = "/today") =>
  getWebNavigation(pathname, (slug) => canAccessWebModule(slug, role));
const labels = (role: string) =>
  navFor(role).navGroups.flatMap((group) =>
    group.items.map((item) => item.label),
  );

describe("v2 navigation", () => {
  it("lists the eight owner pages in the contract's order", () => {
    expect(OWNER_PAGES.map((page) => page.label)).toEqual([
      "Today",
      "Sales & targets",
      "Coverage & people",
      "Stores",
      "Products & stock",
      "Vans & cash",
      "Money",
      "Decide",
    ]);
  });

  it("super admin sees the owner pages, then the map, Work, Issues and Setup", () => {
    const all = labels("super_admin");
    expect(all.slice(0, 8)).toEqual(OWNER_PAGES.map((page) => page.label));
    expect(all).toEqual(
      expect.arrayContaining(["Live map", "Work", "Issues", "Setup"]),
    );
    expect(all).not.toContain("Dashboard");
    expect(all).not.toContain("Reports");
  });

  it("sales see Today but no other owner page and no Setup", () => {
    const all = labels("sales");
    expect(all).toContain("Today");
    for (const page of OWNER_PAGES.slice(1))
      expect(all).not.toContain(page.label);
    expect(all).not.toContain("Setup");
  });

  it("viewer reads every owner page", () => {
    const all = labels("viewer");
    for (const page of OWNER_PAGES) expect(all).toContain(page.label);
  });

  it("grouped items point at the first page the role may open", () => {
    const work = navFor("viewer")
      .navGroups.flatMap((group) => group.items)
      .find((item) => item.label === "Work");
    expect(work).toBeDefined();
    expect(
      canAccessWebModule(work!.href.slice(1).split("?")[0]!, "viewer"),
    ).toBe(true);
  });

  it("marks the owner page active, including its detail pages", () => {
    expect(primaryIdFor("/today")).toBe("today");
    expect(primaryIdFor("/coverage-people/agent")).toBe("coverage-people");
    expect(primaryIdFor("/stores/store")).toBe("stores");
  });

  it("keeps the old Home and Reports as redirects", () => {
    expect(LEGACY_REDIRECTS).toEqual({
      dashboard: "/today",
      analytics: "/sales",
    });
  });
});
