import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const state = vi.hoisted(() => ({ edit: true, error: false }));
vi.mock("../../../lib/auth", () => ({
  usePermissions: () => ({ can: () => state.edit }),
}));
vi.mock("../../../lib/api", () => ({
  useLive: () => {},
  mutate: vi.fn(),
  useApi: () => ({
    error: state.error,
    data: {
      outlets: [],
      products: [],
      datasets: [],
      models: [
        {
          id: "sample",
          purpose: "suggested_order",
          version: 1,
          status: "candidate",
          sample: true,
          metrics: { mae: 2, baselineMae: 5 },
        },
      ],
      runs: [
        {
          id: "unavailable",
          purpose: "shelf",
          status: "unavailable",
          input: { sample: true },
          result: {
            reason: "No shelf model is configured; complete manual review",
          },
        },
      ],
      truncated: false,
    },
    refetch: vi.fn(),
  }),
}));
import { ModelWorkbench } from "./model-workbench";
beforeEach(() => {
  state.edit = true;
  state.error = false;
});
describe("F-609 F-610 reviewed model controls", () => {
  it("shows real holdout comparison, independent approval and honest unavailable shelf fallback", () => {
    const html = renderToStaticMarkup(createElement(ModelWorkbench));
    for (const text of [
      "Held-out error 2.00 versus rule 5.00",
      "Independently approve",
      "Sample",
      "No shelf model is configured",
      "Save reviewed example",
      "Save candidate version",
      "Save independent review",
    ])
      expect(html).toContain(text);
  });
  it("hides edit controls from readers and cached source data after an error", () => {
    state.edit = false;
    expect(renderToStaticMarkup(createElement(ModelWorkbench))).not.toContain(
      "Save candidate version",
    );
    state.error = true;
    const html = renderToStaticMarkup(createElement(ModelWorkbench));
    expect(html).toContain("Existing rules and manual shelf checks");
    expect(html).not.toContain("Held-out error");
  });
});
