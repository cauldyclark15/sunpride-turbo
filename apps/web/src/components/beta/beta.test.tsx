import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AreaPendingNotice, BetaBar, needsAreaAssignment } from "./beta-bar";
import { TesterGuide } from "./tester-guide";

vi.mock("@sunpride/ui", () => ({
  StatusPill: ({ children }: { children: React.ReactNode }) =>
    createElement("span", { "data-pill": "" }, children),
  Notice: ({ title, meta }: { title: string; meta?: React.ReactNode }) =>
    createElement("aside", null, title, " ", meta),
}));
vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) =>
    createElement("img", { alt: props.alt, src: props.src }),
}));

afterEach(() => vi.unstubAllEnvs());

describe("beta bar", () => {
  it("marks the app as Beta and links to the guide and Report an issue for this page", () => {
    const html = renderToStaticMarkup(
      createElement(BetaBar, { pathname: "/inventory", canReport: true }),
    );
    expect(html).toContain('<span data-pill="">Beta</span>');
    expect(html).toContain('href="/help"');
    expect(html).toContain('href="/issues/new?from=%2Finventory"');
    expect(html).toContain("Report an issue");
  });

  it("omits Report an issue for someone without tracker access", () => {
    const html = renderToStaticMarkup(
      createElement(BetaBar, { pathname: "/dashboard", canReport: false }),
    );
    expect(html).not.toContain("Report an issue");
    expect(html).toContain("Beta");
  });
});

describe("area assignment message", () => {
  it("asks for an area only when a scoped role has none", () => {
    expect(needsAreaAssignment({ role: "sales" })).toBe(true);
    expect(needsAreaAssignment({ role: "manager", orgUnitId: null })).toBe(
      true,
    );
    expect(needsAreaAssignment({ role: "sales", orgUnitId: "unit" })).toBe(
      false,
    );
    expect(needsAreaAssignment({ role: "super_admin" })).toBe(false);
    expect(needsAreaAssignment({ role: "analyst" })).toBe(false);
    expect(needsAreaAssignment(null)).toBe(false);
    expect(renderToStaticMarkup(createElement(AreaPendingNotice))).toContain(
      "You have not been assigned to an area yet",
    );
  });
});

describe("tester guide", () => {
  it("explains signing in, what to test and how to report, with no codes", () => {
    const html = renderToStaticMarkup(
      createElement(TesterGuide, { apkUrl: null }),
    );
    for (const text of [
      "Getting started for testers",
      "Create account",
      "What to test",
      "Report an issue",
      "screenshot",
      "Inventory",
      "Approvals",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("Android apps");
    expect(html).not.toMatch(/SP-\d|ADR|PWA/);
  });

  it("shows the Android download only when a link is configured", () => {
    const html = renderToStaticMarkup(
      createElement(TesterGuide, { apkUrl: "https://drive.example/apks" }),
    );
    expect(html).toContain("Android apps");
    expect(html).toContain('href="https://drive.example/apks"');
  });
});
