import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiProvider, ApiStore, apiFetch } from "../../lib/api";
import { orgQueryParams, useOrgMutation } from "./api";
import { collectExport, csvText } from "./export";
import { MasterDataWorkspace } from "./master-data-workspace";
import { SetupHealth } from "./setup-health";
import type { CommandArgs } from "./model";

const args = { q: "", paginationOpts: { numItems: 25, cursor: null } };
function storeWith(path: string, data: unknown) {
  const store = new ApiStore();
  store.setData(["setup", "org/permissions", {}], {
    capabilities: ["masterdata.manage", "outlet.read"],
    role: "super_admin",
    scopeUnitIds: [],
  });
  store.setData(["setup", path, args], data);
  return store;
}
const render = (store: ApiStore, node: React.ReactNode) =>
  renderToStaticMarkup(createElement(ApiProvider, { store }, node));
afterEach(() => vi.unstubAllGlobals());

describe("master data using the real API hooks", () => {
  it("shows product pack conversion and governed price status, never the legacy zero price or raw identity", () => {
    const store = storeWith("catalog/products/list", {
      page: [
        {
          _id: "private-product-id",
          code: "SKU-1",
          name: "Sample meat",
          category: "Sample",
          uom: "PCS",
          uomDisplay: "1 case = 24 pcs",
          priceStatus: "Governed price required",
          active: true,
          conversions: [],
        },
      ],
      isDone: false,
      continueCursor: "next-page",
    });
    const html = render(store, createElement(MasterDataWorkspace));
    expect(html).toContain("1 case = 24 pcs");
    expect(html).toContain("Sample meat");
    expect(html).not.toContain("private-product-id");
    expect(html).not.toContain("₱0");
    expect(html).toContain("Search master data");
    expect(html).toContain("Master data pages");
    expect(html).toContain("Export CSV");
    expect(html).toContain("Edit");
  });
  it("shows customer channel, territory and peso credit instead of a database identity", () => {
    const store = storeWith("catalog/customers/list", {
      page: [
        {
          _id: "private-customer-id",
          code: "C-001",
          name: "Sample customer",
          channel: "GT",
          territory: "Cebu",
          creditLimitCentavos: 2500000,
          active: true,
        },
      ],
      isDone: true,
      continueCursor: "",
    });
    const html = render(
      store,
      <MasterDataWorkspace initialSection="customers" />,
    );
    expect(html).toContain("Sample customer");
    expect(html).toContain("GT");
    expect(html).toContain("Cebu");
    expect(html).toContain("25,000.00");
    expect(html).not.toContain("private-customer-id");
  });
  it("shows store scope names, explicit missing credit and a link to its setup", () => {
    const store = storeWith("outlets/list", {
      page: [
        {
          _id: "store-selection",
          code: "S-01",
          name: "Sample store",
          channel: "PMOT",
          territoryName: "South Cebu",
          status: "active",
        },
      ],
      isDone: true,
      continueCursor: "",
    });
    const html = render(
      store,
      <MasterDataWorkspace initialSection="outlets" />,
    );
    expect(html).toContain("South Cebu");
    expect(html).toContain("Not set");
    expect(html).toContain("Open store setup");
    expect(html).not.toContain(">store-selection<");
  });
  it("opens Setup health with five actionable exceptions and honest unknown prior history", () => {
    const store = new ApiStore();
    store.setData(["setup", "org/setup-health", {}], {
      asOf: 0,
      comparisonNote: "Prior history is not available.",
      items: ["people", "outlets", "routes", "prices", "pins"].map(
        (key, i) => ({
          key,
          label: `Missing ${key}`,
          count: i === 0 ? null : i,
          target: 0,
          prior: null,
          trend: [],
          fix: key,
          href: `/admin?section=${key}`,
        }),
      ),
    });
    const html = render(store, createElement(SetupHealth));
    expect(html).toContain("Setup health");
    expect(html.match(/Review and fix/g)).toHaveLength(5);
    expect(html).toContain("Target: 0");
    expect(html).toContain("Unknown");
    expect(html).toContain("Prior history is not available.");
  });
  it("preserves no-data versus loading and hides edit controls when not permitted", () => {
    const store = storeWith("catalog/products/list", {
      page: [],
      isDone: true,
      continueCursor: "",
    });
    store.setData(["setup", "org/permissions", {}], {
      capabilities: [],
      role: "viewer",
      scopeUnitIds: [],
    });
    const html = render(store, createElement(MasterDataWorkspace));
    expect(html).toContain("No matches");
    expect(html).not.toContain(">Edit<");
    expect(html).not.toContain("Loading master data");
  });
  it("serializes page options and search to the actual Bun GET route", async () => {
    const transport = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ page: [], isDone: true, continueCursor: "" }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    await apiFetch("/api/v1/people/list", {
      query: orgQueryParams({
        q: "Ana & Bea",
        paginationOpts: { numItems: 25, cursor: null },
      }),
      fetchImpl: transport,
    });
    const [url, init] = transport.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain("/api/v1/people/list?");
    const query = new URL(url, "http://test.local").searchParams;
    expect(query.get("q")).toBe("Ana & Bea");
    expect(JSON.parse(query.get("paginationOpts")!)).toEqual({
      numItems: 25,
      cursor: null,
    });
    expect(init.credentials).toBe("same-origin");
  });
  it("reuses the same idempotency key after uncertain failure and rotates after confirmed success", async () => {
    const requests: RequestInit[] = [];
    const transport = vi.fn(async (_url: string, init?: RequestInit) => {
      requests.push(init ?? {});
      if (requests.length === 1) throw new Error("offline");
      return new Response("null", {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", transport);
    let send: ((body: CommandArgs<"org/edit">) => Promise<unknown>) | undefined;
    function Binding() {
      send = useOrgMutation("org/edit");
      return null;
    }
    render(new ApiStore(), createElement(Binding));
    const body = {
      unitId: "selected-unit",
      name: "Corrected name",
      reason: "Spelling",
    };
    await expect(send!(body)).rejects.toThrow();
    await send!(body);
    await send!(body);
    const key = (i: number) =>
      (requests[i]?.headers as Record<string, string>)["idempotency-key"];
    expect(key(0)).toBe(key(1));
    expect(key(2)).not.toBe(key(1));
    expect(JSON.parse(String(requests[1]?.body))).toEqual(body);
  });
});

describe("complete safe CSV export", () => {
  it("keeps BOM, RFC-4180 quoting and formula-prefix protection", () => {
    const csv = csvText([
      ["Code", "Name"],
      ["0001", 'A, "quoted" store'],
      ["=1+1", "\t@malicious"],
      ["\u0000=SUM(A1)", "line\nwrap"],
    ]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain('"0001","A, ""quoted"" store"');
    expect(csv).toContain('"\'=1+1"');
    expect(csv).toContain('"\'\t@malicious"');
    expect(csv).toContain('"\'\u0000=SUM(A1)"');
    expect(csv).toContain("\r\n");
  });
  it("collects every page, including an empty filtered page with continuation", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        page: [1],
        continueCursor: "page-2",
        isDone: false,
      })
      .mockResolvedValueOnce({
        page: [],
        continueCursor: "page-3",
        isDone: false,
      })
      .mockResolvedValueOnce({ page: [3], continueCursor: "", isDone: true });
    expect(await collectExport("catalog/products/list", {}, read)).toEqual([
      1, 3,
    ]);
    expect(read.mock.calls.map((c) => c[0])).toEqual([
      null,
      "page-2",
      "page-3",
    ]);
  });
  it("refuses cursor cycles and partial network failures instead of generating a partial file", async () => {
    const cycle = vi.fn(async () => ({
      page: [1],
      continueCursor: "same",
      isDone: false,
    }));
    await expect(
      collectExport("catalog/products/list", {}, cycle),
    ).rejects.toThrow("did not finish");
    const failure = vi
      .fn()
      .mockResolvedValueOnce({
        page: [1],
        continueCursor: "next",
        isDone: false,
      })
      .mockRejectedValueOnce(new Error("second page failed"));
    await expect(
      collectExport("catalog/products/list", {}, failure),
    ).rejects.toThrow("second page failed");
  });
});
