import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Card,
  IconTile,
  ListRow,
  Notice,
  UnderlineTabs,
} from "./calm-primitives";
import { MetricCard } from "./metric-card";
import { PageHeader } from "./page-header";
import { StatusPill } from "./status-pill";

describe("calm workspace primitives", () => {
  it("keeps legacy header prose hidden and renders only the live stat", () => {
    const html = renderToStaticMarkup(
      createElement(PageHeader, {
        title: "Inventory",
        eyebrow: "Old eyebrow",
        description: "Old explanation",
        meta: "240 cases · 1 location",
      }),
    );
    expect(html).toContain("Inventory");
    expect(html).toContain("240 cases · 1 location");
    expect(html).not.toContain("Old eyebrow");
    expect(html).not.toContain("Old explanation");
  });
  it("uses bordered sections, tint-only notices and compact pills", () => {
    const html = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(Card, { label: "Stock", count: 2, children: "Content" }),
        createElement(Notice, { title: "Check stock", tone: "warning" }),
        createElement(StatusPill, { tone: "success", children: "Active" }),
        createElement(IconTile, { icon: "•", tone: "neutral" }),
        createElement(ListRow, {
          icon: "•",
          title: "Recent receipt",
          meta: "Today · L1",
        }),
      ),
    );
    expect(html).toContain("Stock · 2");
    expect(html).toContain("border-border");
    expect(html).toContain("bg-warning-soft");
    expect(html).toContain("bg-success-soft");
    expect(html).toContain("min-h-14");
    expect(html).not.toContain("shadow-surface");
  });
  it("renders undecorated KPI and underline tabs", () => {
    const html = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(MetricCard, { label: "Physical", value: "240" }),
        createElement(UnderlineTabs, {
          items: [
            ["stock", "Stock"],
            ["counts", "Counts"],
          ],
          activeId: "stock",
          onChange: () => {},
        }),
      ),
    );
    expect(html).toContain("Physical");
    expect(html).toContain("240");
    expect(html).toContain("border-accent");
    expect(html).toContain('aria-current="page"');
  });
});
