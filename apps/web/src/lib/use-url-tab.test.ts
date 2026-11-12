import { describe, expect, it } from "vitest";
import { hrefForTab, readUrlTab } from "./use-url-tab";

const TABS = ["claims", "liability", "deductions", "incentives"] as const;

describe("readUrlTab", () => {
  it("reads a known tab and falls back for missing or unknown values", () => {
    expect(
      readUrlTab(new URLSearchParams("tab=liability"), TABS, "claims"),
    ).toBe("liability");
    expect(readUrlTab(new URLSearchParams(""), TABS, "claims")).toBe("claims");
    expect(readUrlTab(new URLSearchParams("tab=bogus"), TABS, "claims")).toBe(
      "claims",
    );
    expect(readUrlTab(null, TABS, "claims")).toBe("claims");
  });
  it("can use another key when ?tab= belongs to an outer tab", () => {
    const p = new URLSearchParams("tab=performance&view=retail");
    expect(
      readUrlTab(p, ["distribution", "retail"], "distribution", "view"),
    ).toBe("retail");
  });
});

describe("hrefForTab", () => {
  it("writes ?tab= and keeps other state (L8)", () => {
    expect(
      hrefForTab(
        "/finance-claims",
        new URLSearchParams("fixture=a"),
        "tab",
        "liability",
        "claims",
      ),
    ).toBe("/finance-claims?fixture=a&tab=liability");
  });
  it("leaves the default tab out of the URL and drops the page number", () => {
    expect(
      hrefForTab(
        "/finance-claims",
        new URLSearchParams("tab=liability&page=3"),
        "tab",
        "claims",
        "claims",
      ),
    ).toBe("/finance-claims");
  });
});
