import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useApi } from "../../../lib/api";
import { analyticsFixture } from "../fixtures";
import { LIST_FILTER_KEYS, indexReference } from "../../customers/model";
import {
  customerListHref,
  customerRecordHref,
} from "../../customers/list-navigation";
import { StorePage, StoresPage } from "./stores";

const nav = vi.hoisted(() => ({
  pathname: "/customers",
  search: "",
  push: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("../../../lib/auth", () => ({
  usePermissions: () => ({
    can: (capability: string) => capability === "outlet.read",
  }),
}));
vi.mock("../../../lib/api", async (original) => ({
  ...(await original<typeof import("../../../lib/api")>()),
  useApi: vi.fn(),
  useLive: vi.fn(),
}));
vi.mock("../../store-gathering/tab", () => ({ useWaitingCount: () => 0 }));
vi.mock("../../customers/customer-editor", () => ({
  CustomerEditor: () => <div>Customer information</div>,
  useCustomerReference: () => ({
    index: indexReference([
      { list: "sales_organization", code: "1000", name: "Sample organization" },
      {
        list: "distribution_channel",
        salesOrgCode: "1000",
        code: "30",
        name: "Sample channel",
      },
    ]),
    enrollmentFields: [],
  }),
}));

const NOW = Date.parse("2026-11-26T12:00:00+08:00");
const fixtureRow = {
  id: "sample-customer",
  code: "SAMPLE-0258",
  customerName: "Sample Customer",
  registeredName: "Sample Store",
  status: "active",
  enrolmentStatus: null,
  completeness: "complete",
};

function navigate(href: string) {
  const url = new URL(href, "http://localhost");
  nav.pathname = url.pathname;
  nav.search = url.search.slice(1);
}
function renderPage() {
  return renderToStaticMarkup(
    nav.pathname === "/customers" ? <StoresPage /> : <StorePage />,
  ).replaceAll("&amp;", "&");
}
function links(markup: string, label: string) {
  return [...markup.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gs)]
    .filter((match) => match[2]!.replace(/<[^>]*>/g, "").trim() === label)
    .map((match) => match[1]!);
}
function listRequest() {
  const calls = vi
    .mocked(useApi)
    .mock.calls.filter(
      ([key]) =>
        Array.isArray(key) && key[0] === "customers" && key[1] === "list",
    );
  const key = calls.at(-1)?.[0];
  return Array.isArray(key) ? key[2] : undefined;
}

beforeEach(() => {
  navigate("/customers");
  vi.mocked(useApi).mockReset();
  vi.mocked(useApi).mockImplementation((input) => {
    const key = Array.isArray(input) ? input : [];
    let data: unknown;
    if (key[0] === "customers") data = { rows: [fixtureRow], total: 61 };
    if (key[0] === "org") data = [];
    if (key[0] === "analytics") {
      data = analyticsFixture(key[1] as "store" | "stores", {}, NOW);
    }
    return {
      data,
      error: undefined,
      status: "success",
      isLoading: false,
      isFetching: false,
      refetch: vi.fn().mockResolvedValue(undefined),
    };
  });
});

describe("SP-0258 customer list round trip", () => {
  it.each(["list", "new"])(
    "the real %s page restores search, every filter and page after opening a record",
    (tab) => {
      const initial = new URLSearchParams({
        tab,
        q: "Sample & Co + Cebu",
        page: "3",
      });
      if (tab === "list") initial.set("status", "active");
      for (const key of LIST_FILTER_KEYS) initial.set(key, `sample-${key}`);
      initial.set("salesOrgCode", "1000");
      initial.set("distributionChannelCode", "30");
      navigate(`/customers?${initial}`);
      const before = renderPage();
      const requestBefore = listRequest();
      const record = [...before.matchAll(/href="([^"]*)"/g)]
        .map((match) => match[1]!)
        .find((href) => href.startsWith("/customers/customer?"));
      expect(record).toBeTruthy();
      navigate(record!);
      const detail = renderPage();
      expect(detail).toContain("Customer information");
      const back = links(detail, "All customers")[0];
      expect(back).toBeTruthy();
      navigate(back!);
      const after = renderPage();
      expect(Object.fromEntries(new URLSearchParams(nav.search))).toEqual(
        Object.fromEntries(initial),
      );
      expect(listRequest()).toEqual(requestBefore);
      expect(after).toContain('value="Sample & Co + Cebu"');
      expect(after).toContain(
        '<option value="30" selected="">Sample channel (30)</option>',
      );
    },
  );

  it("both All customers links still restore the list after opening Performance", () => {
    const list = new URLSearchParams(
      "tab=new&q=Sample&addedBy=sample-person&page=2",
    );
    navigate(customerRecordHref("sample-customer", list));
    const infoBack = links(renderPage(), "All customers")[0];
    const record = new URLSearchParams(nav.search);
    record.set("view", "performance");
    record.set("period", "week");
    nav.search = record.toString();
    const performanceBack = links(renderPage(), "All customers");
    expect(performanceBack).toHaveLength(2);
    expect(performanceBack).toEqual([infoBack, infoBack]);
  });

  it("Performance list records return to the same period and view", () => {
    navigate(
      "/customers?tab=performance&view=distribution&period=week&channel=gt&compare=ly",
    );
    const before = new URLSearchParams(nav.search);
    const markup = renderPage();
    const record = [...markup.matchAll(/href="([^"]*)"/g)]
      .map((match) => match[1]!)
      .find((href) => href.startsWith("/customers/customer?"));
    expect(record).toBeTruthy();
    navigate(record!);
    navigate(links(renderPage(), "All customers")[0]!);
    expect(Object.fromEntries(new URLSearchParams(nav.search))).toEqual(
      Object.fromEntries(before),
    );
  });
});

describe("SP-0258 list-state URL boundaries", () => {
  it("a direct record link defaults to the unfiltered list", () => {
    expect(
      customerListHref(new URLSearchParams("storeId=sample-customer")),
    ).toBe("/customers");
    expect(customerRecordHref("sample-customer", new URLSearchParams())).toBe(
      "/customers/customer?storeId=sample-customer",
    );
  });

  it("uses the current filters, including explicitly cleared state, without old selections", () => {
    const list = new URLSearchParams(
      "q=old&status=inactive&page=4&addedBy=old-person",
    );
    list.delete("q");
    list.delete("status");
    list.delete("page");
    list.set("addedBy", "new-person");
    const record = new URL(
      customerRecordHref("id /&?", list),
      "http://localhost",
    );
    expect(record.searchParams.get("storeId")).toBe("id /&?");
    expect(customerListHref(record.searchParams)).toBe(
      "/customers?addedBy=new-person",
    );
  });

  it("drops editor, record and arbitrary navigation params from saved and restored state", () => {
    const list = new URLSearchParams(
      "q=Sample&edit=old&storeId=old&customerList=old&returnTo=https://example.com",
    );
    const record = new URL(customerRecordHref("new", list), "http://localhost");
    expect(record.searchParams.get("customerList")).toBe("q=Sample");
    record.searchParams.set("customerList", list.toString());
    expect(customerListHref(record.searchParams)).toBe("/customers?q=Sample");
    record.searchParams.set("customerList", "https://example.com/customers");
    expect(customerListHref(record.searchParams)).toBe("/customers");
  });

  it("preserves fixture navigation without copying record view into the list", () => {
    const record = new URL(
      customerRecordHref("sample", new URLSearchParams("fixture=1")),
      "http://localhost",
    );
    record.searchParams.set("view", "performance");
    expect(customerListHref(record.searchParams)).toBe("/customers?fixture=1");
  });
});
