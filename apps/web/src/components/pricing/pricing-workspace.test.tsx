import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  matchRows,
  parsePriceRows,
  PricingWorkspace,
  readPricingTab,
} from "./pricing-workspace";
import { shortDate } from "./page-tabs";

const state = vi.hoisted(() => ({
  canEdit: true,
  search: "",
  values: {} as Record<string, unknown>,
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(state.search),
  usePathname: () => "/pricing",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    scroll?: boolean;
    children: React.ReactNode;
  }) => {
    const { scroll: _ignored, ...rest } = props as {
      scroll?: boolean;
    } & Record<string, unknown>;
    void _ignored;
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
}));
vi.mock("../../lib/api", () => ({
  useApi: (key: unknown[] | null) => ({
    data: key ? state.values[String(key[1])] : undefined,
  }),
  apiFetch: vi.fn(),
  mutate: vi.fn(),
  useLive: vi.fn(),
}));
vi.mock("../../lib/auth", () => ({
  usePermissions: () => ({
    can: (c: string) => c !== "masterdata.manage" || state.canEdit,
  }),
}));

const list = (i: number, extra: Record<string, unknown> = {}) => ({
  id: `list-${i}`,
  code: `L${i}`,
  name: `List ${i}`,
  channelKey: "gt",
  source: "office",
  status: "active",
  effectiveFrom: 1792368000000,
  effectiveTo: null,
  lineCount: 1,
  ...extra,
});
const render = (search = "") => {
  state.search = search;
  return renderToStaticMarkup(createElement(PricingWorkspace));
};

beforeEach(() => {
  state.canEdit = true;
  state.search = "";
  state.values = {
    lists: {
      rows: [
        list(0, {
          id: "raw-list",
          code: "GT",
          name: "General trade",
          source: "sample",
        }),
      ],
    },
    promotions: {
      rows: [
        {
          id: "raw-promo",
          code: "OCT",
          name: "October discount",
          priceListId: null,
          rule: { kind: "percent_off" },
          status: "active",
          source: "office",
        },
      ],
    },
    matrix: {
      channels: ["gt"],
      rows: [
        {
          productId: "raw-product",
          productCode: "FOOD",
          productName: "Canned food",
          uom: "PC",
          prices: [
            { channel: "gt", unitPriceCentavos: null, source: "missing" },
          ],
        },
      ],
      next: null,
      asOf: 1792368000000,
    },
    detail: {
      ...list(0, { id: "raw-list", name: "General trade" }),
      lines: [],
    },
  };
});

describe("prices · price lists", () => {
  it("is a plain list: Add price list before the rows, Edit on every row, no readiness cards", () => {
    const h = render();
    expect(h).toContain("Add price list");
    expect(h.indexOf('data-testid="list-add"')).toBeGreaterThan(-1);
    expect(h.indexOf('data-testid="list-add"')).toBeLessThan(
      h.indexOf('data-testid="list-table"'),
    );
    expect(h).toContain("General trade");
    expect(h).toContain('href="/pricing?list=raw-list&amp;edit=1"');
    expect(h).toContain(">Edit<");
    for (const gone of [
      "readiness",
      "setup goal",
      "setup comparison",
      "seven days earlier",
      "Create",
      "Remove",
      "Deactivate",
    ])
      expect(h).not.toContain(gone);
  });
  it("search narrows rows from ?q=", () => {
    state.values.lists = {
      rows: [list(1, { name: "Modern trade" }), list(2, { name: "Sari-sari" })],
    };
    const h = render("q=modern");
    expect(h).toContain("Modern trade");
    expect(h).not.toContain("Sari-sari");
  });
  it("pages 50 rows at a time from ?page=", () => {
    state.values.lists = {
      rows: Array.from({ length: 60 }, (_, i) =>
        list(i, { name: `Row ${String(i).padStart(2, "0")}` }),
      ),
    };
    const one = render();
    expect(one).toContain("Row 49");
    expect(one).not.toContain("Row 50");
    expect(one).toContain('data-testid="list-pages"');
    const two = render("page=2");
    expect(two).toContain("Row 50");
    expect(two).not.toContain("Row 49");
  });
  it("Remove and Deactivate live in the Edit panel of the open list", () => {
    const h = render("list=raw-list&edit=1");
    expect(h).toContain("Edit price list");
    expect(h).toContain("Remove");
    expect(h).toContain('value="inactive"');
    expect(h).toContain("Save");
    expect(h).toContain("Cancel");
  });
  it("hides Add, Edit and Remove for a reader", () => {
    state.canEdit = false;
    const h = render("list=raw-list&edit=1");
    expect(h).not.toContain("Remove");
    expect(h).not.toContain(">Edit<");
    expect(render()).not.toContain("Add price list");
  });
});

describe("prices · SAP owns prices", () => {
  it("keeps Add, Edit, Remove and Active when SAP does not own prices", () => {
    state.values["org/permissions"] = { sapOwnsPrices: false };
    expect(render()).toContain("Add price list");
    expect(render()).not.toContain("come from SAP");
    const open = render("list=raw-list&edit=1");
    expect(open).toContain("Remove");
    expect(open).toContain('value="active"');
    expect(open).toContain("Add prices");
  });
  it("hides Add, Edit, Remove and Active with one plain line when SAP owns prices", () => {
    state.values["org/permissions"] = { sapOwnsPrices: true };
    const list = render();
    expect(list).toContain("General trade");
    expect(list).not.toContain("Add price list");
    expect(list).not.toContain(">Edit<");
    expect(list.match(/Prices come from SAP\./g)).toHaveLength(1);
    const open = render("list=raw-list&edit=1");
    expect(open).not.toContain("Edit price list");
    expect(open).not.toContain("Remove");
    expect(open).not.toContain('value="active"');
    expect(open).not.toContain("Add prices");
    expect(open.match(/Prices come from SAP\./g)).toHaveLength(1);
    // promotions are not SAP prices: still editable
    expect(render("tab=promotions")).toContain("Add promotion");
    expect(render("tab=promotions")).not.toContain("come from SAP");
  });
});

describe("prices · tabs in ?tab=", () => {
  it("reads the tab from the URL with Price lists as default", () => {
    expect(readPricingTab(new URLSearchParams(""))).toBe("lists");
    expect(readPricingTab(new URLSearchParams("tab=promotions"))).toBe(
      "promotions",
    );
    expect(readPricingTab(new URLSearchParams("tab=nope"))).toBe("lists");
  });
  it("shows prices by product with No price yet", () => {
    const h = render("tab=products");
    expect(h).toContain("Canned food");
    expect(h).toContain("No price yet");
    expect(h).toContain('aria-current="page"');
  });
  it("lists promotions with Add promotion and a row Edit", () => {
    const h = render("tab=promotions");
    expect(h).toContain("Add promotion");
    expect(h).toContain("October discount");
    expect(h).toContain(
      'href="/pricing?tab=promotions&amp;promotion=raw-promo"',
    );
    expect(h).not.toContain("raw-promo</");
  });
  it("opens the promotion Edit panel with Remove inside", () => {
    const h = render("tab=promotions&promotion=raw-promo");
    expect(h).toContain("Edit promotion");
    expect(h).toContain("Remove");
  });
});

describe("price helpers", () => {
  it("parses integer centavos including a known zero", () => {
    expect(parsePriceRows("FOOD,PC,1250\nFREE,PC,0")).toEqual([
      { productCode: "FOOD", uom: "PC", unitPriceCentavos: 1250 },
      { productCode: "FREE", uom: "PC", unitPriceCentavos: 0 },
    ]);
  });
  it("refuses fractional prices and incomplete imports before sending", () => {
    expect(() => parsePriceRows("FOOD,PC,12.50")).toThrow("Row 1");
    expect(() => parsePriceRows("FOOD,,1250")).toThrow("Row 1");
    expect(() => parsePriceRows("")).toThrow();
  });
  it("matches on name, code and status", () => {
    const rows = [list(1), list(2, { status: "inactive" })];
    expect(matchRows(rows, "l2", null).map((r) => r.id)).toEqual(["list-2"]);
    expect(matchRows(rows, "", "active").map((r) => r.id)).toEqual(["list-1"]);
  });
  it("writes short dates, never ISO", () => {
    const nov9 = Date.parse("2026-11-09T04:00:00Z");
    expect(shortDate(nov9, nov9)).toBe("Nov 9");
    expect(shortDate(nov9, Date.parse("2027-02-01T00:00:00Z"))).toBe(
      "Nov 9, 2026",
    );
  });
});

describe("WEB-140: Add promotion can save under F-501", () => {
  it("never asks the API to activate a promotion with no campaign budget", async () => {
    const mod = await import("./pricing-workspace");
    const body = mod.newPromotionBody({ code: "P1", name: "Promo" });
    expect(body.status).toBe("inactive");
    expect(body).not.toHaveProperty("campaignVersionId");
    expect(mod.NEW_PROMOTION_NOTICE).toContain("Saved as Inactive");
  });
});
