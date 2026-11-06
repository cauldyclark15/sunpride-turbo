import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { STATUS_STATES, StatusPill, statusFor } from "./status-pill";

const html = (state: string, children?: string) =>
  renderToStaticMarkup(createElement(StatusPill, { state, children }));

describe("StatusPill", () => {
  it("shows the five handheld truth states in plain words and the right colour", () => {
    expect(html("saved_on_phone")).toContain("Saved on phone");
    expect(html("saved_on_phone")).toContain("bg-default-soft");
    expect(html("sent")).toContain("Sent");
    expect(html("sent")).toContain("bg-blue-100");
    expect(html("accepted")).toContain("bg-success-soft");
    expect(html("sap_posted")).toContain("✓ SAP posted");
    expect(html("sap_posted")).toContain("bg-success-soft");
    expect(html("needs_review")).toContain("Needs review");
    expect(html("needs_review")).toContain("bg-warning-soft");
  });
  it("covers document states and server spellings", () => {
    expect(html("dispatched")).toContain("In transit");
    expect(html("in_transit")).toContain("In transit");
    expect(html("partially_received")).toContain("Partly received");
    expect(html("review_needed")).toContain("Needs review");
    expect(html("rejected")).toContain("bg-danger-soft");
    expect(html("canceled")).toContain("Cancelled");
    expect(html("Saved on phone")).toContain("Saved on phone");
  });
  it("lets a screen add detail and falls back to readable words", () => {
    expect(html("needs_review", "Needs review: short 2 cs")).toContain(
      "Needs review: short 2 cs",
    );
    expect(statusFor("weird_state")).toEqual({
      label: "Weird state",
      tone: "neutral",
    });
  });
  it("has a label and tone for every state", () => {
    for (const [key, s] of Object.entries(STATUS_STATES)) {
      expect(s.label.length, key).toBeGreaterThan(0);
      expect(["neutral", "info", "success", "warning", "danger"]).toContain(
        s.tone,
      );
    }
  });
});
