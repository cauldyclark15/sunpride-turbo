import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/auth", () => ({
  usePermissions: () => ({ can: () => true, profileId: null }),
}));
vi.mock("../lib/api", () => ({
  useApi: () => ({ data: undefined }),
  useLive: vi.fn(),
  mutate: vi.fn(),
  apiFetch: vi.fn(),
}));

import { ApproveControl } from "./customers/customer-editor";
import { gatheredEmptyHint } from "./cockpit/pages/stores";
import { pinSourceLabel, storeTitle } from "./store-gathering/review";
import { typeLabel } from "./org-admin";
import { metaParts } from "./supervision/supervision-model";

// SP-0178: launch-role friction found in the live role test (2026-11-13).
describe("SP-0178 role friction", () => {
  it("Approve asks once before giving the Customer Code", () => {
    const closed = renderToStaticMarkup(
      createElement(ApproveControl, {
        busy: false,
        name: "Tindahan ni Ana",
        onApprove: () => undefined,
      }),
    );
    expect(closed).toContain(">Approve<");
    expect(closed).not.toContain("Yes, approve");
    const open = renderToStaticMarkup(
      createElement(ApproveControl, {
        busy: false,
        name: "Tindahan ni Ana",
        onApprove: () => undefined,
        initiallyOpen: true,
      }),
    );
    expect(open).toContain("Approve Tindahan ni Ana as a customer?");
    expect(open).toContain(">Yes, approve<");
    expect(open).toContain(">Cancel<");
  });

  it("the gathered review never says nothing waits while Add customer stores wait", () => {
    expect(gatheredEmptyHint(0)).toBe("Nothing waiting for review.");
    expect(gatheredEmptyHint(2)).toBe(
      "No gathered stores waiting. 2 stores added with Add customer on the phone wait below.",
    );
  });

  it("pins show a plain source, never a raw code", () => {
    expect(pinSourceLabel("new_store_enrolment")).toBe(
      "Added on the phone (Add customer)",
    );
    expect(pinSourceLabel("office")).toBe("Added from the office");
    expect(pinSourceLabel("something_new")).toBe("something new");
  });

  it("stores read by Registered Name, owner second", () => {
    expect(
      storeTitle({ name: "Ana Santos", registeredName: "Ana Sari-sari Store" }),
    ).toBe("Ana Sari-sari Store · Ana Santos");
    expect(storeTitle({ name: "Ana Santos", registeredName: null })).toBe(
      "Ana Santos",
    );
  });

  it("an org unit type reads by its configured label (department → Distribution Channel)", () => {
    expect(
      typeLabel("department", [
        { code: "department", label: "Distribution Channel" },
      ]),
    ).toBe("Distribution Channel");
    expect(typeLabel("area")).toBe("Area");
  });

  it("a person's meta line never repeats the job title", () => {
    expect(metaParts("Senior Route Salesman", "Senior Route Salesman")).toBe(
      "Senior Route Salesman",
    );
    expect(metaParts("Senior Route Salesman", null, "")).toBe(
      "Senior Route Salesman",
    );
  });
});
