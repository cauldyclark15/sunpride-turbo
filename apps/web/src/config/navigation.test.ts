import { describe, expect, it } from "vitest";
import { APP_ROLES, canAccessWebModule } from "../lib/module-access";
import {
  LEGACY_REDIRECTS,
  OPERATIONS_SECTIONS,
  OWNER_PAGES,
  WORKSPACE_SLUGS,
  getWebNavigation,
  isWebModuleSlug,
  operationsSectionFor,
  operationsSubFor,
  primaryIdFor,
  visibleOperationsSubs,
} from "./navigation";
import { phoneTitleFor } from "./phone-tabs";

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

  it("every internal role sees Messages (messaging.use); partners never do", () => {
    for (const role of APP_ROLES) {
      expect(labels(role)).toContain("Messages");
      expect(canAccessWebModule("messages", role)).toBe(true);
    }
    expect(canAccessWebModule("messages", "distributor")).toBe(false);
    expect(isWebModuleSlug("messages")).toBe(true);
    expect(primaryIdFor("/messages")).toBe("messages");
    expect(phoneTitleFor("/messages")).toBe("Messages");
  });

  it("carries the unread badge onto the Messages item", () => {
    const items = getWebNavigation(
      "/today",
      (slug) => canAccessWebModule(slug, "sales"),
      { messages: "@ 3" },
    ).navGroups.flatMap((group) => group.items);
    expect(items.find((item) => item.id === "messages")?.badge).toBe("@ 3");
    expect(items.find((item) => item.id === "today")?.badge).toBeUndefined();
  });

  it("IP-INT3: carries the open-decisions badge onto the Decide item, and only there", () => {
    const items = getWebNavigation(
      "/decide",
      (slug) => canAccessWebModule(slug, "super_admin"),
      { decide: "4" },
    ).navGroups.flatMap((group) => group.items);
    expect(items.find((item) => item.id === "decide")?.badge).toBe("4");
    expect(items.find((item) => item.id === "stock")?.badge).toBeUndefined();
    const none = getWebNavigation("/decide", (slug) =>
      canAccessWebModule(slug, "super_admin"),
    ).navGroups.flatMap((group) => group.items);
    expect(none.find((item) => item.id === "decide")?.badge).toBeUndefined();
  });

  it("keeps the old Home and Reports as redirects", () => {
    expect(LEGACY_REDIRECTS).toEqual({
      dashboard: "/today",
      analytics: "/sales",
    });
  });
});

describe("Operations: verbs first (IP-NAV)", () => {
  const opsTabs = (role: string, pathname = "/operations/stock") =>
    getWebNavigation(pathname, (slug) => canAccessWebModule(slug, role))
      .moduleTabs.map((tab) => tab.label);

  it("lists the verbs in the order people do them", () => {
    expect(OPERATIONS_SECTIONS.map((s) => s.label)).toEqual([
      "Stock",
      "Receive",
      "Transfers",
      "Counts",
      "Van day",
      "Stores POS",
      "Decide",
    ]);
    expect(opsTabs("super_admin")).toEqual(
      OPERATIONS_SECTIONS.map((s) => s.label),
    );
  });

  it("each verb carries its own screens", () => {
    const subs = (id: string) =>
      OPERATIONS_SECTIONS.find((s) => s.id === id)!.subs.map((s) => s.label);
    expect(subs("stock")).toEqual(
      expect.arrayContaining(["Stock on hand", "Stock card", "Bad orders", "Expiry"]),
    );
    expect(subs("counts")).toEqual(["My counts", "Plan a count", "Review"]);
    expect(subs("van-day")).toEqual(
      expect.arrayContaining(["Board", "Roster", "Suggested loads"]),
    );
    expect(subs("stores-pos")).toEqual(
      expect.arrayContaining([
        "Registers & till days",
        "X / Z readings",
        "Overrides",
        "Receipts",
        "Tax summary",
        "Discount & Z rules",
      ]),
    );
  });

  it("hides the verbs a role cannot use", () => {
    expect(opsTabs("operations")).toEqual([
      "Stock",
      "Receive",
      "Transfers",
      "Counts",
      "Van day",
    ]);
    expect(opsTabs("approver")).toEqual([
      "Stock",
      "Transfers",
      "Counts",
      "Van day",
      "Stores POS",
      "Decide",
    ]);
    expect(opsTabs("sales")).toEqual(["Stock"]);
    expect(opsTabs("viewer")).toEqual(["Stock"]);
  });

  it("the sidebar has one Operations item and Work no longer carries the stock and van pages", () => {
    const items = getWebNavigation("/today", () => true).navGroups.flatMap(
      (g) => g.items,
    );
    expect(items.filter((i) => i.label === "Operations")).toHaveLength(1);
    const work = getWebNavigation("/orders", () => true).moduleTabs.map(
      (t) => t.href,
    );
    for (const moved of ["/inventory", "/van-trips", "/workflows"])
      expect(work).not.toContain(moved);
    expect(work.length).toBeLessThan(17);
  });

  it("every older route stays reachable: it is a tab or a screen of a verb, and it lights Operations", () => {
    for (const moved of ["inventory", "van-trips", "workflows"]) {
      expect(primaryIdFor(`/${moved}`)).toBe("operations");
      expect(
        OPERATIONS_SECTIONS.some((s) =>
          s.subs.some((sub) => sub.href === `/${moved}`),
        ),
      ).toBe(true);
    }
    const reachable = new Set<string>();
    for (const path of ["/orders", "/admin", "/operations/stock"])
      for (const tab of getWebNavigation(path, () => true).moduleTabs)
        reachable.add(tab.href.slice(1).split("?")[0]!);
    for (const section of OPERATIONS_SECTIONS)
      for (const sub of section.subs)
        reachable.add(sub.href.slice(1).split("?")[0]!);
    for (const slug of WORKSPACE_SLUGS)
      if (slug !== "live-map" && slug !== "sap-integration")
        expect(reachable.has(slug), `${slug} is reachable`).toBe(true);
  });

  it("finds the verb and the lit screen for a path, including detail pages and moved pages", () => {
    expect(operationsSectionFor("/operations/counts/review")?.id).toBe("counts");
    expect(operationsSectionFor("/inventory")?.id).toBe("stock");
    expect(operationsSectionFor("/van-trips?tripId=x")?.id).toBe("van-day");
    expect(operationsSectionFor("/workflows")?.id).toBe("decide");
    expect(operationsSectionFor("/today")).toBeNull();
    expect(operationsSubFor("/operations/transfers/abc")?.id).toBe("list");
    expect(operationsSubFor("/operations/stock/bad-orders")?.id).toBe("bad-orders");
    expect(operationsSubFor("/operations/stock")?.id).toBe("on-hand");
    expect(operationsSubFor("/van-trips")?.id).toBe("trips");
  });

  it("IP-INT3FIX: every role that may read trips has a link to /van-trips in Operations, and nobody sees it twice", () => {
    for (const role of APP_ROLES) {
      const canOpen = (slug: string) => canAccessWebModule(slug, role);
      const links = OPERATIONS_SECTIONS.filter((s) => canOpen(s.access)).flatMap(
        (s) =>
          visibleOperationsSubs(s, canOpen)
            .filter((sub) => sub.href === "/van-trips")
            .map(() => s.id),
      );
      expect(links, role).toHaveLength(1);
    }
    const canOpen = (slug: string) => canAccessWebModule(slug, "sales");
    expect(canOpen("ops-van-day")).toBe(false);
    expect(
      visibleOperationsSubs(OPERATIONS_SECTIONS[0], canOpen).map((s) => s.id),
    ).toContain("van-trips");
  });
});
