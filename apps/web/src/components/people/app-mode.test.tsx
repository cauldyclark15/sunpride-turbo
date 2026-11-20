import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  APP_MODES,
  AppModeChoice,
  BulkAppMode,
  OWNER_MODES,
  SELLING_SALES_ONLY,
  appModePill,
  canPickAppMode,
  currentAppMode,
  currentAppModes,
  toggleAppMode,
} from "./app-mode";

/** SP-0194: Setup > People "App mode" (Customer mapping, Field visits, Truck selling). */

const html = (el: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(el).replace(/<!-- -->/g, "");
const sales = { profileId: "p1", role: "sales", status: "active" };

describe("App mode", () => {
  it("shows three plain rows with one line each; Customer mapping is the default", () => {
    const view = html(
      createElement(AppModeChoice, {
        target: sales,
        canManage: true,
        save: vi.fn(),
      }),
    );
    expect(view).toContain(">App mode<");
    for (const mode of APP_MODES) {
      expect(view).toContain(`>${mode.label}<`);
      expect(view).toContain(mode.line);
    }
    expect(view).toMatch(/checked="" value="mapping"/);
    expect(view).toContain('type="checkbox"');
    expect(view).not.toContain(SELLING_SALES_ONLY);
  });
  it("shows every enabled mode as a checkbox and lists both labels", () => {
    const target = {
      ...sales,
      appMode: "visits",
      appModes: ["visits", "selling"],
    };
    const view = html(
      createElement(AppModeChoice, { target, canManage: true, save: vi.fn() }),
    );
    expect(view.match(/type="checkbox"/g)).toHaveLength(3);
    expect(view).toMatch(/checked="" value="visits"/);
    expect(view).toMatch(/checked="" value="selling"/);
    expect(appModePill(target)).toBe("Field visits, Truck selling");
    expect(currentAppModes({ ...target, role: "manager" })).toEqual(["visits"]);
    expect(toggleAppMode(["visits"], "selling")).toEqual(["visits", "selling"]);
    expect(toggleAppMode(["visits", "selling"], "visits")).toEqual(["selling"]);
    expect(toggleAppMode(["visits"], "visits")).toEqual([]);
  });
  it("Truck selling is only for Sales people, and says why", () => {
    const view = html(
      createElement(AppModeChoice, {
        target: {
          profileId: "p2",
          role: "manager",
          status: "active",
          appMode: "visits",
        },
        canManage: true,
        save: vi.fn(),
      }),
    );
    expect(view).toMatch(/checked="" value="visits"/);
    expect(view).toMatch(/disabled=""[^>]*value="selling"/);
    expect(view).toContain(SELLING_SALES_ONLY);
  });
  it("the owner shows All modes (owner), read-only", () => {
    const view = html(
      createElement(AppModeChoice, {
        target: {
          profileId: "p0",
          role: "super_admin",
          status: "active",
          appMode: "selling",
        },
        canManage: true,
        save: vi.fn(),
      }),
    );
    expect(view).toContain(OWNER_MODES);
    expect(view).not.toContain('type="radio"');
    expect(appModePill({ role: "super_admin", appMode: "mapping" })).toBe(
      OWNER_MODES,
    );
  });
  it("only an administrator can change it; inactive people cannot change", () => {
    expect(canPickAppMode(sales, "selling", true)).toBe(true);
    expect(canPickAppMode(sales, "visits", false)).toBe(false);
    expect(
      canPickAppMode({ ...sales, status: "disabled" }, "mapping", true),
    ).toBe(false);
    expect(
      canPickAppMode({ role: "viewer", status: "active" }, "selling", true),
    ).toBe(false);
    expect(
      canPickAppMode({ role: "viewer", status: "active" }, "visits", true),
    ).toBe(true);
  });
  it("reads the same mode the phone shows (old Selling switch, stale selling for non-Sales)", () => {
    expect(currentAppMode({ role: "sales" })).toBe("mapping");
    expect(currentAppMode({ role: "sales", selling: true })).toBe("selling");
    expect(currentAppMode({ role: "sales", appMode: "visits" })).toBe("visits");
    expect(currentAppMode({ role: "manager", appMode: "selling" })).toBe(
      "visits",
    );
    expect(appModePill({ role: "sales", appMode: "selling" })).toBe(
      "Truck selling",
    );
  });
});

describe("Set app mode for many people", () => {
  const people = [
    { ...sales, name: "Ana" },
    { profileId: "p2", role: "sales", status: "active", name: "Ben" },
    { profileId: "p3", role: "manager", status: "active", name: "Cy" },
    { profileId: "p0", role: "super_admin", status: "active", name: "Owner" },
  ];
  it("counts who changes and leaves the owner out", () => {
    const view = html(
      createElement(BulkAppMode, {
        people,
        save: vi.fn(),
        onDone: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    expect(view).toContain("Pick one or more app modes for 3 people.");
    expect(view).toContain("1 person left out");
    expect(view).toContain(">Save<");
    expect(view).toContain(">Cancel<");
    for (const mode of APP_MODES) expect(view).toContain(`>${mode.label}<`);
  });
});
