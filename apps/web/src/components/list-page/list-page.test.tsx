import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

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

import { countLine, ListPage, toCsv, type ListColumn } from "./list-page";

type Thing = { id: string; name: string; note: string };
const columns: ListColumn<Thing>[] = [
  {
    key: "name",
    label: "Name",
    primary: true,
    render: (r) => r.name,
    text: (r) => r.name,
  },
  { key: "note", label: "Note", render: (r) => r.note, text: (r) => r.note },
];
const base = {
  noun: { one: "thing", many: "things" },
  page: 1,
  onPage: () => {},
  q: "",
  onSearch: () => {},
  searchPlaceholder: "Search things",
  columns,
  rowKey: (r: Thing) => r.id,
};
const html = (el: React.ReactElement) =>
  renderToStaticMarkup(el).replaceAll("&amp;", "&");

describe("ListPage", () => {
  it("renders search, Add, filter chips, rows with checkboxes and pages", () => {
    const out = html(
      <ListPage
        {...base}
        rows={[{ id: "a", name: "Alpha", note: "x" }]}
        total={120}
        onAdd={() => {}}
        filters={[{ id: "open", label: "Open", count: 4 }]}
        filter="open"
        rowHref={(r) => `/t/${r.id}`}
      />,
    );
    expect(out).toContain("Search things");
    expect(out).toContain("Add thing");
    expect(out).toMatch(/aria-pressed="true"[^>]*>Open/);
    expect(out).toContain('href="/t/a"');
    expect(out).toContain('type="checkbox"');
    expect(out).toContain("Showing 1–50 of 120 things");
    expect(out).toContain('data-testid="list-pages"');
  });
  it("empty search offers to add the typed name", () => {
    const out = html(
      <ListPage {...base} rows={[]} total={0} q="Zeta" onAdd={() => {}} />,
    );
    expect(out).toContain("No thing named “Zeta”");
    expect(out).toContain("Add “Zeta” as a new thing");
    expect(out).toContain("Clear search");
  });
  it("no Add without onAdd", () => {
    const out = html(<ListPage {...base} rows={[]} total={0} q="" />);
    expect(out).toContain("No things yet");
    expect(out).not.toContain("Add thing");
  });
  it("exports chosen rows as CSV", () => {
    expect(
      toCsv(columns, [
        { id: "a", name: "Alpha", note: 'says "hi", ok' },
        { id: "b", name: "Beta", note: "" },
      ]),
    ).toBe('Name,Note\nAlpha,"says ""hi"", ok"\nBeta,');
  });
});

describe("ListPage conventions (WEB-177)", () => {
  const one = [{ id: "a", name: "Alpha", note: "x" }];
  it("a single page still shows the Pages bar with Prev and Next disabled (L6)", () => {
    const out = html(<ListPage {...base} rows={one} total={1} />);
    expect(out).toContain('data-testid="list-pages"');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Prev<\/button>/);
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Next<\/button>/);
  });
  it("cursor lists without a total still get the count line (L1)", () => {
    const noun = { one: "product", many: "products" };
    expect(countLine(noun, null, 1, 25, { from: 26, to: 50, more: true })).toBe(
      "Showing 26–50 products · more on the next page",
    );
    expect(countLine(noun, null, 1, 25, { from: 1, to: 12, more: false })).toBe(
      "Showing 1–12 of 12 products",
    );
    expect(countLine(noun, 312, 2, 50)).toBe("Showing 51–100 of 312 products");
    const out = html(
      <ListPage
        {...base}
        rows={one}
        total={null}
        range={{ from: 1, to: 1, more: false }}
      />,
    );
    expect(out).toContain("Showing 1–1 of 1 thing");
  });
  it("folds extra filter dropdowns behind a Filters toggle on a phone", () => {
    const out = html(
      <ListPage
        {...base}
        rows={one}
        total={1}
        filterPanel={{ node: <select aria-label="Region" />, active: 2 }}
      />,
    );
    expect(out).toMatch(/aria-expanded="false"[^>]*>Filters/);
    // hidden below the sm breakpoint until opened, shown from sm up
    expect(out).toContain('class="hidden sm:block"');
    // the search box comes before the filter panel
    expect(out.indexOf('data-testid="list-search"')).toBeLessThan(
      out.indexOf('data-testid="list-filter-panel"'),
    );
  });
});
