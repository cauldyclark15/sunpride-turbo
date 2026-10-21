import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { it, expect, vi } from "vitest";
import { IntegrityFleet } from "./fleet";
const state = vi.hoisted(() => ({ selected: false }));
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useState: (initial: unknown) => {
      if (initial === null && !state.selected) {
        state.selected = true;
        return [
          { id: "sample", person: "SAMPLE seller", status: "active" },
          vi.fn(),
        ];
      }
      return [initial, vi.fn()];
    },
  };
});
vi.mock("../../lib/auth", () => ({
  usePermissions: () => ({ can: (c: string) => c === "admin.manage" }),
}));
vi.mock("../../lib/api", () => ({
  useApi: () => ({
    data: {
      devices: [],
      assets: [],
      units: [],
      people: [],
      providers: [],
      truncated: false,
      settings: {},
      source_ref: "SAMPLE",
    },
  }),
  useLive: vi.fn(),
  mutate: vi.fn(),
  apiFetch: vi.fn(),
}));
vi.mock("./identity", () => ({ CompanyIdentity: () => null }));
it("F-007 replacement form requests an expiring phone code, never a pasted public key", () => {
  state.selected = false;
  const html = renderToStaticMarkup(createElement(IntegrityFleet));
  expect(html).toContain("Replacement phone code");
  expect(html).toContain('name="pairingCode"');
  expect(html).toContain("Codes expire in ten minutes");
  expect(html).not.toContain("Replacement public key");
  expect(html).not.toContain('name="key"');
});
