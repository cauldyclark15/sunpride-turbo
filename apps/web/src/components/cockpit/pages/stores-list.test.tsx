import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { StoreRow } from "../types";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import {
  StoreListView,
  StoresTabs,
  pageNumbers,
  readPage,
  readStoreStatus,
  readStoresTab,
  storeFilters,
} from "./stores-list";

const row = (n: number): StoreRow => ({
  storeId: `s${n}`,
  code: `SMP-${String(n).padStart(5, "0")}`,
  name: `Mercado ${n}`,
  channel: "general_trade",
  territory: "Cebu North",
  status: n % 2 ? "active" : "dormant",
  salesPeriod: 0,
  salesPrior: 0,
  deltaPct: null,
  lastOrderAt: null,
  lastVisitAt: null,
  skuCount: 0,
  mustSellGaps: 0,
  arBalance: null,
});

const view = (over: Partial<Parameters<typeof StoreListView>[0]> = {}) =>
  renderToStaticMarkup(
    <StoreListView
      rows={[row(1), row(2)]}
      total={301}
      page={1}
      q=""
      canAdd
      onSearch={() => {}}
      onPage={() => {}}
      onAdd={() => {}}
      storeHref={(r) => `/customers/customer?storeId=${r.storeId}`}
      {...over}
    />,
  ).replaceAll("&amp;", "&");

describe("stores tab in the URL", () => {
  it("defaults to the list and falls back to it for unknown values", () => {
    expect(readStoresTab(new URLSearchParams(""))).toBe("list");
    expect(readStoresTab(new URLSearchParams("tab=nope"))).toBe("list");
    expect(readStoresTab(new URLSearchParams("tab=performance"))).toBe(
      "performance",
    );
    expect(readStoresTab(new URLSearchParams("tab=winback&q=x"))).toBe(
      "winback",
    );
    // Settings only for people who may edit the rules
    expect(
      readStoresTab(new URLSearchParams("tab=settings"), ["settings"]),
    ).toBe("list");
    expect(readStoresTab(new URLSearchParams("tab=settings"))).toBe("settings");
  });
  it("tab links carry the tab in the URL", () => {
    const out = renderToStaticMarkup(
      <StoresTabs
        tab="new"
        onTab={() => {}}
        hrefFor={(t) => (t === "list" ? "/customers" : `/customers?tab=${t}`)}
        badges={{ new: 3 }}
      />,
    );
    expect(out).toContain('href="/customers"');
    expect(out).toContain('href="/customers?tab=performance"');
    expect(out).toMatch(/aria-selected="true"[^>]*>New customers<span[^>]*>3</);
  });
});

describe("pagination params", () => {
  it("reads ?page= as a whole number from 1", () => {
    expect(readPage(new URLSearchParams(""))).toBe(1);
    expect(readPage(new URLSearchParams("page=3"))).toBe(3);
    expect(readPage(new URLSearchParams("page=0"))).toBe(1);
    expect(readPage(new URLSearchParams("page=2.5"))).toBe(1);
    expect(readPage(new URLSearchParams("page=abc"))).toBe(1);
  });
  it("shows first, last and neighbours", () => {
    expect(pageNumbers(1, 7)).toEqual([1, 2, "…", 7]);
    expect(pageNumbers(4, 7)).toEqual([1, "…", 3, 4, 5, "…", 7]);
    expect(pageNumbers(2, 3)).toEqual([1, 2, 3]);
  });
});

describe("store list", () => {
  it("is just search, Add store, the list and pages", () => {
    const out = view();
    expect(out).toContain('data-testid="list-search"');
    expect(out).toContain("Search by store name or code");
    expect(out).toContain('data-testid="list-add"');
    expect(out).toContain("Showing 1–50 of 301 stores");
    expect(out).toContain("Mercado 1");
    expect(out).toContain("SMP-00001");
    expect(out).toContain("Cebu North");
    expect(out).toContain("Dormant");
    expect(out).toContain('href="/customers/customer?storeId=s1"');
    expect(out).toContain('data-testid="list-pages"');
    expect(out).toMatch(/aria-current="page"[^>]*>1</);
    // nothing else on the default view
    expect(out).not.toMatch(/Where is|period|Download/i);
  });
  it("says the range on a later page", () => {
    expect(view({ page: 7 })).toContain("Showing 301–301 of 301 stores");
  });
  it("offers to add the searched name when nothing matches", () => {
    const out = view({ rows: [], total: 0, q: "Aling Nena" });
    expect(out).toContain("No store named “Aling Nena”");
    expect(out).toContain("Add “Aling Nena” as a new store");
    expect(out).toContain("Clear search");
    expect(out).not.toContain('data-testid="list-pages"');
  });
  it("hides Add store without permission", () => {
    const out = view({ canAdd: false, rows: [], total: 0, q: "x" });
    expect(out).not.toContain("Add store");
    expect(out).not.toContain("as a new store");
    expect(out).toContain("No store named “x”");
  });
});

describe("store status chips", () => {
  it("reads ?status= and ignores unknown values", () => {
    expect(readStoreStatus(new URLSearchParams("status=dormant"))).toBe(
      "dormant",
    );
    expect(readStoreStatus(new URLSearchParams("status=nope"))).toBeNull();
    expect(readStoreStatus(new URLSearchParams(""))).toBeNull();
  });
  it("uses the API's per-status counts for the current search", () => {
    const chips = storeFilters({ all: 9, active: 5, dormant: 3, lost: 1 });
    expect(chips.map((c) => [c.id, c.count])).toEqual([
      ["active", 5],
      ["new", 0],
      ["dormant", 3],
      ["lost", 1],
      ["never", 0],
    ]);
    expect(storeFilters(undefined).every((c) => c.count === null)).toBe(true);
  });
  it("renders chips with counts, the chosen one pressed, and Edit per row", () => {
    const out = view({
      status: "dormant",
      matches: { all: 301, active: 200, dormant: 101 },
      onStatus: () => {},
      onEdit: () => {},
    });
    expect(out).toMatch(/aria-pressed="true"[^>]*>Dormant<span[^>]*>101</);
    expect(out).toMatch(/aria-pressed="false"[^>]*>Buying<span[^>]*>200</);
    expect(out).toMatch(/aria-label="Edit Mercado 1"[^>]*>Edit<\/button>/);
    // Edit sits outside the row link
    expect(out).not.toMatch(/<a [^>]*>(?:(?!<\/a>).)*>Edit<\/button>/);
  });
  it("hides chips and Edit when not wired", () => {
    const out = view();
    expect(out).not.toContain('aria-label="Filter"');
    expect(out).not.toContain(">Edit</button>");
  });
});
