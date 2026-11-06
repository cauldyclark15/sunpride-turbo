import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApiProvider } from "@/lib/api/provider";
import { ApiStore } from "@/lib/api/store";
import { ReasonSelect, reasonNeeds, type ReasonCode } from "./reason-select";

const reason = (o: Partial<ReasonCode>): ReasonCode => ({
  code: "X",
  label: "X",
  category: "shrink",
  direction: "both",
  requiresNote: false,
  requiresPhoto: false,
  approvalThresholdCentavos: null,
  active: true,
  ...o,
});
const OUT = [
  reason({
    code: "DMG-HANDLING",
    label: "Damaged in handling",
    category: "damage",
    direction: "out",
    requiresPhoto: true,
  }),
  reason({
    code: "SAMPLE",
    label: "Free sample / promo use",
    direction: "out",
    requiresNote: true,
  }),
  reason({ code: "SHORT-PICK", label: "Short-picked at depot" }),
];

function render(
  props: Record<string, unknown>,
  seed?: { query: object; data: ReasonCode[] },
) {
  const store = new ApiStore();
  if (seed) store.setData(["inventory", "reason-codes", seed.query], seed.data);
  return renderToStaticMarkup(
    createElement(
      ApiProvider,
      { store },
      createElement(ReasonSelect, { onChange: vi.fn(), value: null, ...props }),
    ),
  );
}

describe("ReasonSelect", () => {
  it("lists the reasons the server returns for the direction", () => {
    const html = render(
      { direction: "out" },
      { query: { direction: "out" }, data: OUT },
    );
    expect(html).toContain("Damaged in handling");
    expect(html).toContain("Short-picked at depot");
    expect(html).toContain("Choose a reason");
    expect(html).toContain(">Reason<");
    expect(html).not.toContain("Found stock");
  });
  it("says what the chosen reason needs", () => {
    const photo = render(
      { direction: "out", value: "DMG-HANDLING" },
      { query: { direction: "out" }, data: OUT },
    );
    expect(photo).toContain("Needs a photo.");
    const note = render(
      { direction: "out", value: "SAMPLE" },
      { query: { direction: "out" }, data: OUT },
    );
    expect(note).toContain("Needs a short note.");
    const none = render(
      { direction: "out", value: "SHORT-PICK" },
      { query: { direction: "out" }, data: OUT },
    );
    expect(none).not.toContain("Needs");
  });
  it("keys the read by direction and category, and shows loading before data", () => {
    const html = render({ direction: "in", category: "found" });
    expect(html).toContain("Loading reasons…");
    expect(html).toContain("disabled");
    const seeded = render(
      { category: "damage" },
      { query: { category: "damage" }, data: OUT.slice(0, 1) },
    );
    expect(seeded).toContain("Damaged in handling");
  });
  it("reasonNeeds joins note and photo", () => {
    expect(
      reasonNeeds(reason({ requiresNote: true, requiresPhoto: true })),
    ).toEqual(["a short note", "a photo"]);
    expect(reasonNeeds(null)).toEqual([]);
  });
});
