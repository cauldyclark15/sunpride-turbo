import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrityRate, IntegrityReview, type IntegrityQueue } from "./review";
import { IntegrityFleet, phoneLabel } from "./fleet";

const state = vi.hoisted(() => ({
  grants: new Set<string>(),
  data: {} as Record<string, unknown>,
  error: null as Error | null,
  keys: [] as unknown[],
}));
vi.mock("../../lib/auth", () => ({
  usePermissions: () => ({ can: (grant: string) => state.grants.has(grant) }),
}));
vi.mock("../../lib/api", () => ({
  useApi: (key: unknown) => {
    state.keys.push(key);
    return {
      data: !key
        ? undefined
        : Array.isArray(key) && key.includes("policy")
          ? {
              settings: { mockExitRatePct: 0.5 },
              source_ref: "SAMPLE policy",
              effective_from: "2020-01-01T00:00:00Z",
            }
          : state.data,
      error: state.error,
    };
  },
  useLive: vi.fn(),
  apiFetch: vi.fn(),
  mutate: vi.fn(),
}));
const rate: IntegrityQueue["mockRate"] = {
  attempts: 0,
  incidents: 0,
  ratePct: null,
  targetBelowPct: 0.5,
  priorPct: null,
  definition: "Unique signed attempts; OS signal, not verified attestation.",
};
beforeEach(() => {
  state.grants = new Set(["integrity.read", "integrity.review"]);
  state.data = {
    items: [],
    next: null,
    policySource: "SAMPLE provisional policy",
    mockRate: rate,
  };
  state.error = null;
  state.keys = [];
});
describe("F-221/F-606 integrity review", () => {
  it("F-606 shows pesos and percentage discounts without internal minor-unit labels", () => {
    state.data.items = [
      {
        id: "not-displayed",
        rule: "high_discount",
        severity: "review",
        person: "SAMPLE person",
        outlet: null,
        occurredAt: 0,
        evidence: { varianceCentavos: -125000, discountBps: 2500 },
        disposition: null,
      },
    ];
    const html = renderToStaticMarkup(createElement(IntegrityReview));
    expect(html).toContain("Cash difference");
    expect(html).toContain("-₱1,250.00");
    expect(html).toContain("25%");
    expect(html).not.toContain("Centavos");
    expect(html).not.toContain("Bps");
  });
  it("does not certify the exit gate from missing data", () => {
    const html = renderToStaticMarkup(createElement(IntegrityRate, { rate }));
    expect(html).toContain("Not measured");
    expect(html).not.toContain("Within target");
    expect(html).toContain("below 0.5%");
  });
  it("uses strictly below 0.5%, not less than or equal", () => {
    const html = renderToStaticMarkup(
      createElement(IntegrityRate, {
        rate: {
          ...rate,
          attempts: 200,
          incidents: 1,
          ratePct: 0.5,
          priorPct: 0.4,
        },
      }),
    );
    expect(html).toContain("0.50%");
    expect(html).toContain("Above target");
    expect(html).toContain("0.40%");
    const below = renderToStaticMarkup(
      createElement(IntegrityRate, {
        rate: { ...rate, attempts: 1000, incidents: 4, ratePct: 0.4 },
      }),
    );
    expect(below).toContain("Within target");
  });
  it("skips unauthorized subscriptions, not just its visible panel", () => {
    state.grants.clear();
    expect(renderToStaticMarkup(createElement(IntegrityReview))).toBe("");
    expect(state.keys).toEqual([null]);
  });
  it("keeps paging visible after a scope-filtered empty page", () => {
    state.data.next = "cursor";
    const html = renderToStaticMarkup(createElement(IntegrityReview));
    expect(html).toContain("Continue to the next page");
    expect(html).toContain("Next findings");
  });
  it("keeps analyst review read-only and signals distinct from proof of guilt", () => {
    state.grants.delete("integrity.review");
    state.data.items = [
      {
        id: "finding",
        rule: "impossible_travel",
        severity: "review",
        person: "SAMPLE agent",
        outlet: "SAMPLE outlet",
        occurredAt: 1_000,
        evidence: { speedKph: 200 },
        disposition: null,
      },
    ];
    const html = renderToStaticMarkup(createElement(IntegrityReview));
    expect(html).toContain("SAMPLE agent");
    expect(html).toContain("not proof of fraud");
    expect(html).not.toContain("Confirmed concern");
    expect(html).not.toContain("False alarm");
  });
  it("shows source failures instead of claiming no concerns", () => {
    state.error = new Error("Refresh this authorized scope");
    const html = renderToStaticMarkup(createElement(IntegrityReview));
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("No findings on this page");
  });
});
describe("F-007/F-021 fleet", () => {
  it("replaces automatically generated UUID tags with a plain label, preserving real asset tags", () => {
    expect(phoneLabel("SAMPLE-790b339b-eea6-4207-a0f2-5f5abd7c414a")).toBe(
      "Sample registered phone",
    );
    expect(phoneLabel("SAMPLE-PHONE-SMP-AGENT")).toBe("SAMPLE-PHONE-SMP-AGENT");
  });
  function fleet() {
    state.grants.add("admin.manage");
    state.data = {
      assets: [],
      devices: [],
      units: [],
      people: [],
      providers: [],
      truncated: false,
    };
  }
  it("denies the register without subscribing", () => {
    expect(renderToStaticMarkup(createElement(IntegrityFleet))).toContain(
      "not part of your access",
    );
    expect(state.keys).toEqual([null]);
  });
  it("discloses incomplete fleets instead of presenting truncated counts as complete", () => {
    fleet();
    state.data.truncated = true;
    expect(renderToStaticMarkup(createElement(IntegrityFleet))).toContain(
      "This view is incomplete",
    );
  });
  it("retains supervised recovery access for a retired phone without offering reactivation", () => {
    fleet();
    state.data.devices = [
      {
        id: "device",
        label: "SAMPLE wiped phone",
        person: "SAMPLE user",
        status: "revoked",
        app: "van-android",
        handover_id: null,
        assessment: null,
        control: {
          id: "control",
          kind: "wipe",
          status: "acknowledged",
          queued_count: 1,
        },
      },
    ];
    const html = renderToStaticMarkup(createElement(IntegrityFleet));
    expect(html).toContain("1 queued item held in recovery");
    expect(html).toContain("Download held evidence");
    expect(html).not.toContain("Request remote erase");
  });
});
