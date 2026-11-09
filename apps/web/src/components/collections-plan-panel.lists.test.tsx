import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/x",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => createElement("a", { href, ...rest }, children),
}));
const api = vi.hoisted(() => ({ data: null as unknown }));
vi.mock("../lib/api", () => ({
  useApi: () => ({ data: api.data, error: null }),
  useLive: vi.fn(),
  useMutate: () => ({ mutate: vi.fn() }),
}));
vi.mock("./collection-evidence", () => ({ CollectionEvidence: () => null }));

import {
  CollectionsPlanPanel,
  chequeNext,
  pageOf,
  readMoneyTab,
  type Collections,
} from "./collections-plan-panel";

const promise = (i: number, extra = {}) => ({
  id: `p${i}`,
  customerCode: `C${i}`,
  name: `Store ${i}`,
  openItemRef: null,
  openItemLabel: null,
  amountMinor: 100_00,
  promisedOn: "2026-11-09",
  status: "open" as const,
  overdue: false,
  note: "",
  outcomeNote: null,
  createdBy: "x",
  ...extra,
});
const data = (n = 3): Collections => ({
  asOf: "2026-11-09",
  source: "SAP",
  routeDate: "2026-11-10",
  canPlan: true,
  summary: {
    arMinor: 1,
    overdueMinor: 1,
    openPromisesMinor: 1,
    dueThisWeekMinor: 1,
    overduePromises: 0,
    keptLast28: 0,
    brokenLast28: 0,
    keptPrior28: 0,
    brokenPrior28: 0,
    postDatedMinor: 0,
    bouncedOpen: 0,
  },
  actions: [],
  actionsTotal: 0,
  customers: [],
  customersTotal: 0,
  promises: Array.from({ length: n }, (_, i) => promise(i + 1)),
  cheques: [
    {
      id: "q1",
      customerCode: "C1",
      name: "Store 1",
      chequeNumber: "0001",
      bank: "BDO",
      amountMinor: 500_00,
      chequeDate: "2026-11-20",
      postDated: true,
      status: "received",
      replacesId: null,
    },
  ],
  routes: [],
  collectors: [],
});
const html = () => renderToStaticMarkup(createElement(CollectionsPlanPanel));

describe("Money lists", () => {
  beforeEach(() => {
    nav.search = "";
    api.data = data();
  });
  it("opens on Promises with Add promise first, before any rows", () => {
    const h = html();
    expect(h).toContain('aria-selected="true"');
    expect(h).toMatch(/aria-selected="true"[^>]*>Promises</);
    const add = h.indexOf("Add promise");
    expect(add).toBeGreaterThan(-1);
    expect(add).toBeLessThan(h.indexOf("Store 1"));
    expect(h).not.toContain("Record promise");
    expect(h).not.toContain("Promises kept, 28 days");
  });
  it("shows plain dates and an Edit button per open promise", () => {
    const h = html();
    expect(h).toContain("Nov 9");
    expect(h).not.toContain("2026-11-09");
    expect(h.match(/>Edit</g)?.length).toBe(3);
  });
  it("?tab=cheques shows the cheque list with Add cheque", () => {
    nav.search = "tab=cheques";
    const h = html();
    expect(h).toContain("Add cheque");
    expect(h).toContain("BDO 0001");
    expect(h).toContain("Nov 20 · post-dated");
    expect(h).not.toContain(">Edit<");
  });
  it("?tab=overview holds the figures", () => {
    nav.search = "tab=overview";
    const h = renderToStaticMarkup(
      createElement(CollectionsPlanPanel, { overview: "CHARTS" }),
    );
    expect(h).toContain("CHARTS");
    expect(h).toContain("Promises kept, 28 days");
    expect(h).not.toContain("Add promise");
  });
  it("search-as-you-type filters and ?page= pages the list", () => {
    api.data = data(120);
    nav.search = "q=store 11";
    let h = html();
    expect(h).toContain("Store 11<");
    expect(h).toContain("Store 110");
    expect(h).not.toContain("Store 2<");
    nav.search = "page=3";
    h = html();
    expect(h).toContain("Store 101");
    expect(h).not.toContain("Store 1<");
  });
  it("helpers: tab reader, filter + page, cheque next steps", () => {
    expect(readMoneyTab(new URLSearchParams("tab=bogus"))).toBe("promises");
    expect(readMoneyTab(new URLSearchParams("tab=route"))).toBe("route");
    const r = pageOf([1, 2, 3, 4], {
      q: "",
      filter: "even",
      page: 1,
      text: String,
      group: (n) => (n % 2 ? "odd" : "even"),
    });
    expect(r).toEqual({ total: 2, rows: [2, 4] });
    expect(chequeNext({ status: "received", postDated: true })).toEqual([]);
    expect(chequeNext({ status: "deposited", postDated: false })).toEqual([
      "cleared",
      "bounced",
    ]);
  });
});
