import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  SELLING_LINE,
  SELLING_SALES_ONLY,
  SellingSwitch,
  canSwitchSelling,
} from "./selling-switch";

/** SP-0191: Setup > People "Selling" switch (sell from the truck in the Field app). */

const html = (el: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(el).replace(/<!-- -->/g, "");

const sales = { profileId: "p1", role: "sales", status: "active" };

describe("Selling switch", () => {
  it("shows the plain line and an off switch an administrator can turn on for a Sales person", () => {
    const view = html(
      createElement(SellingSwitch, {
        target: { ...sales, selling: false },
        canManage: true,
        save: vi.fn(),
      }),
    );
    expect(view).toContain(">Selling<");
    expect(view).toContain(SELLING_LINE);
    expect(view).toContain('role="switch"');
    expect(view).toContain('aria-checked="false"');
    expect(view).not.toContain('disabled=""');
    expect(view).not.toContain(SELLING_SALES_ONLY);
  });
  it("shows on when the person sells", () => {
    const view = html(
      createElement(SellingSwitch, {
        target: { ...sales, selling: true },
        canManage: true,
        save: vi.fn(),
      }),
    );
    expect(view).toContain('aria-checked="true"');
    expect(view).toContain(">On<");
  });
  it("cannot be turned on for other roles, and says why in plain words", () => {
    const view = html(
      createElement(SellingSwitch, {
        target: { profileId: "p2", role: "manager", status: "active" },
        canManage: true,
        save: vi.fn(),
      }),
    );
    expect(view).toContain('disabled=""');
    expect(view).toContain(SELLING_SALES_ONLY);
  });
  it("only an administrator can change it; it can always be switched off", () => {
    expect(canSwitchSelling({ ...sales, selling: false }, true)).toBe(true);
    expect(canSwitchSelling({ ...sales, selling: false }, false)).toBe(false);
    expect(canSwitchSelling({ ...sales, selling: true }, false)).toBe(false);
    expect(
      canSwitchSelling(
        { role: "viewer", status: "active", selling: false },
        true,
      ),
    ).toBe(false);
    expect(
      canSwitchSelling(
        { role: "sales", status: "disabled", selling: false },
        true,
      ),
    ).toBe(false);
    expect(
      canSwitchSelling(
        { role: "manager", status: "active", selling: true },
        true,
      ),
    ).toBe(true);
  });
});
