import { describe, expect, it } from "vitest";
import { fieldMobileItems, getFieldNavigation } from "./navigation";

describe("field navigation", () => {
  it.each([
    ["/", "home"],
    ["/orders/new", "orders"],
    ["/orders/queue", "orders"],
    ["/catalog", "catalog"],
    ["/sync", "sync"],
  ])("maps %s to the %s sidebar module", (pathname, expected) => {
    expect(getFieldNavigation(pathname).activePrimaryId).toBe(expected);
  });

  it("keeps order subdivisions inside the Orders module", () => {
    expect(
      getFieldNavigation("/orders/new").moduleTabs.map((item) => item.href),
    ).toEqual(["/orders/new", "/orders/queue"]);
  });

  it("retains the three one-handed mobile quick actions", () => {
    expect(fieldMobileItems.map((item) => item.href)).toEqual([
      "/",
      "/orders/new",
      "/orders/queue",
    ]);
  });
});
