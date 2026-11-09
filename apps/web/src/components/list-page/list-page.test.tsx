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

import { ListPage, toCsv, type ListColumn } from "./list-page";

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
