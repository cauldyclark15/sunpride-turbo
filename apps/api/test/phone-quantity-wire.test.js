import { expect, test } from "bun:test";
import wire from "./fixtures/phone-quantity-wire.json";
import { integer } from "../src/domains/van/model.js";
import { qty } from "../src/domains/van/loadout.js";
import { transferReceiveLines } from "../src/domains/storepos/operations.js";

/**
 * SP-0169 POS-044: every quantity the phone sends goes through the office's own validator. The fixture is what the
 * app's builders produce (Kotlin PhoneQuantityWireTest checks its copy against the builders); a number where the office
 * reads a whole-number string, or a field the office does not read, fails here instead of as a refused op on a phone.
 */
test("the fixture is the same file the Android unit tests check", async () => {
  const a = await Bun.file(new URL("./fixtures/phone-quantity-wire.json", import.meta.url)).text();
  const b = await Bun.file(
    new URL("../../van-sales-android/app/src/test/resources/phone-quantity-wire.json", import.meta.url),
  ).text();
  expect(b).toBe(a);
});

test("store.receive (Receive all shipped): the office reads every line's received quantity", () => {
  const lines = transferReceiveLines(wire["store.receive"].lines);
  expect(lines.map((l) => l.receivedGoodBase)).toEqual([24, 0]);
  for (const l of wire["store.receive"].lines)
    for (const field of ["receivedGoodBase", "receivedDamagedBase", "receivedHoldBase"])
      expect(typeof (/** @type {any} */ (l))[field]).toBe("string");
});

test("store.count: countedBase is a whole-number string", () => {
  for (const l of wire["store.count"].lines) expect(integer(l.countedBase)).toBe(12n);
});

test("load.accept: actualBase is read by the load-out count", () => {
  for (const l of wire["load.accept"].lines) expect(qty(l.actualBase, "Counted quantity")).toBe(47);
});

test("stock.reconcile: expected, counted and difference are whole-number strings", () => {
  for (const l of wire["stock.reconcile"].lines) {
    integer(l.expectedBase);
    integer(l.countedBase);
    expect(typeof l.varianceBase).toBe("string");
    expect(BigInt(l.countedBase) - BigInt(l.expectedBase)).toBe(BigInt(l.varianceBase));
  }
});

test("cash.reconcile: denomination and pieces are whole-number strings", () => {
  let total = 0n;
  for (const c of wire["cash.reconcile"].counts)
    total += integer(c.denominationMinor, true) * integer(c.count);
  expect(total).toBe(1150001n);
});
