import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { CompanyIdentity } from "./identity";
import { DeviceAssessment } from "./fleet";
const state = vi.hoisted(() => ({
  role: "super_admin",
  keys: [] as unknown[],
}));
vi.mock("../../lib/auth", () => ({
  usePermissions: () => ({ role: state.role, can: () => true }),
}));
vi.mock("../../lib/api", () => ({
  mutate: vi.fn(),
  useLive: vi.fn(),
  useApi: (key: unknown) => {
    state.keys.push(key);
    return {
      data: key
        ? {
            providers: [
              {
                id: "p",
                code: "sample",
                label: "SAMPLE company",
                issuer: "https://identity.example.test",
                effective_from: "2026-01-01",
                effective_to: null,
                source_ref: "SAMPLE",
              },
            ],
            links: [
              {
                id: "l",
                person: "Sample seller",
                subject: "exact-subject",
                issuer: "https://identity.example.test",
                source_ref: "SAMPLE",
                effective_to: null,
              },
            ],
            people: [{ id: "person", name: "Sample seller" }],
            truncated: true,
          }
        : undefined,
    };
  },
}));
beforeEach(() => {
  state.role = "super_admin";
  state.keys = [];
});
it("F-007 exposes provider versions, explicit identity mapping and retained history to the super-admin", () => {
  const html = renderToStaticMarkup(createElement(CompanyIdentity));
  for (const text of [
    "Schedule a provider version",
    "Exact provider subject",
    "Link exact identity",
    "Retire identity link",
    "Sample seller",
    "exact-subject",
    "first 500 entries",
  ])
    expect(html).toContain(text);
  expect(html).toContain('type="datetime-local"');
});
it("F-007 ordinary administrators do not subscribe to identity trust configuration", () => {
  state.role = "admin";
  expect(renderToStaticMarkup(createElement(CompanyIdentity))).toBe("");
  expect(state.keys).toEqual([null]);
});
it("F-024 exposes separate assessment and expiring-exception forms without claiming verified attestation", () => {
  const html = renderToStaticMarkup(
    createElement(DeviceAssessment, { devices: [] }),
  );
  for (const text of [
    "Record assessment",
    "Approve expiring exception",
    "Expires within 24 hours",
    "not hardware attestation",
    "cannot erase an adverse phone report",
  ])
    expect(html).toContain(text);
});
