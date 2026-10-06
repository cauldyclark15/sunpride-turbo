import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BETA_HIDDEN_FEATURES,
  betaApkUrl,
  isBetaFeatureOn,
  isModuleHiddenForBeta,
  reportedFromDescription,
  reportIssueHref,
  safeReportedFrom,
} from "./beta";

afterEach(() => vi.unstubAllEnvs());

describe("beta feature list", () => {
  it("hides every listed feature by default", () => {
    vi.stubEnv("NEXT_PUBLIC_BETA_ENABLE", "");
    for (const feature of Object.keys(BETA_HIDDEN_FEATURES))
      expect(
        isBetaFeatureOn(feature as keyof typeof BETA_HIDDEN_FEATURES),
        feature,
      ).toBe(false);
    expect(isModuleHiddenForBeta("sap-integration")).toBe(true);
    expect(isModuleHiddenForBeta("orders")).toBe(false);
    expect(isModuleHiddenForBeta("toString")).toBe(false);
  });

  it("switches features back on by key or all", () => {
    vi.stubEnv("NEXT_PUBLIC_BETA_ENABLE", " sample-order , integration");
    expect(isBetaFeatureOn("sample-order")).toBe(true);
    expect(isBetaFeatureOn("integration")).toBe(true);
    expect(isBetaFeatureOn("production")).toBe(false);
    expect(isModuleHiddenForBeta("sap-integration")).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_BETA_ENABLE", "all");
    for (const feature of Object.keys(BETA_HIDDEN_FEATURES))
      expect(
        isBetaFeatureOn(feature as keyof typeof BETA_HIDDEN_FEATURES),
      ).toBe(true);
  });

  it("documents every hidden feature in the beta release doc", async () => {
    const { readFileSync } = await import("node:fs");
    const doc = readFileSync(
      new URL("../../docs/BETA_RELEASE.md", import.meta.url),
      "utf8",
    );
    for (const feature of Object.keys(BETA_HIDDEN_FEATURES))
      expect(doc, feature).toContain(`\`${feature}\``);
    expect(doc).toContain("NEXT_PUBLIC_BETA_ENABLE");
    expect(doc).toContain("NEXT_PUBLIC_BETA_APK_URL");
  });
});

describe("Android download link", () => {
  it("is hidden when empty or not a web link", () => {
    vi.stubEnv("NEXT_PUBLIC_BETA_APK_URL", "");
    expect(betaApkUrl()).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_BETA_APK_URL", "javascript:alert(1)");
    expect(betaApkUrl()).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_BETA_APK_URL", " https://drive.example/apks ");
    expect(betaApkUrl()).toBe("https://drive.example/apks");
  });
});

describe("Report an issue", () => {
  it("carries the current page into the new issue", () => {
    expect(reportIssueHref("/inventory")).toBe("/issues/new?from=%2Finventory");
    expect(reportIssueHref("/issues/12")).toBe("/issues/new");
    expect(reportIssueHref(null)).toBe("/issues/new");
    expect(reportedFromDescription("/orders")).toBe("Page: /orders\n\n");
  });

  it("accepts only same-site page paths", () => {
    expect(safeReportedFrom("https://evil.example")).toBeNull();
    expect(safeReportedFrom("//evil.example")).toBeNull();
    expect(safeReportedFrom("/a\nb")).toBeNull();
    expect(reportedFromDescription(undefined)).toBe("");
    expect(safeReportedFrom(`/${"x".repeat(500)}`)).toHaveLength(300);
  });
});
