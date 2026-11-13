import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { it, expect, vi } from "vitest";
import { WaitingPhones } from "./fleet";

vi.mock("../../lib/auth", () => ({
  usePermissions: () => ({ can: (c: string) => c === "admin.manage" }),
}));
vi.mock("../../lib/api", () => ({
  useApi: () => ({
    data: {
      devices: [],
      assets: [],
      units: [],
      people: [{ id: "p1", name: "SAMPLE seller", org_unit_id: "u" }],
      providers: [],
      truncated: false,
      waiting: [
        {
          id: "w1",
          personId: "p1",
          person: "SAMPLE seller",
          app: "field-android",
          phoneCode: "AB12 CD34 EF56 7890",
          requestedAt: Date.UTC(2026, 10, 14, 0, 30),
          lastSeenAt: Date.UTC(2026, 10, 14, 0, 31),
        },
      ],
    },
  }),
  useLive: vi.fn(),
  mutate: vi.fn(),
  apiFetch: vi.fn(),
}));

it("SP-0174 Setup > Phones lists phones waiting to be registered with Register and Reject", () => {
  const html = renderToStaticMarkup(createElement(WaitingPhones));
  expect(html).toContain("Phones waiting to be registered");
  expect(html).toContain("SAMPLE seller · Field app");
  expect(html).toContain("AB12 CD34 EF56 7890");
  expect(html).toContain("Asked Nov 14");
  expect(html).toContain(">Register<");
  expect(html).toContain(">Reject<");
  expect(html).toContain(
    "Phone not listed? Register with the phone&#x27;s code",
  );
});
