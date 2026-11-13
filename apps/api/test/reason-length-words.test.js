import { expect, test } from "bun:test";
import { required as coverageRequired } from "../src/domains/coverage/model.js";
import { required as orgRequired } from "../src/domains/org/model.js";
import { text as ordersText } from "../src/domains/orders/validation.js";
import { text as inventoryText } from "../src/domains/inventory/common.js";
import { text as distributorsText } from "../src/domains/distributors/model.js";

/** @param {() => unknown} fn */
const message = (fn) => {
  try {
    fn();
  } catch (e) {
    return /** @type {Error} */ (e).message;
  }
  return null;
};

// EDGE-023 (r6): a 1,206-char coverage "Return reason" was refused with "Return reason required (max 500)".
test("an over-long reason says it is too long, an empty one says it is required", () => {
  const long = "x".repeat(1206);
  expect(message(() => coverageRequired(long, "Return reason"))).toBe(
    "Return reason is too long (up to 500 characters)",
  );
  expect(message(() => coverageRequired("  ", "Return reason"))).toBe(
    "Return reason is required",
  );
  expect(coverageRequired(" Cadence too low ", "Return reason")).toBe(
    "Cadence too low",
  );
  for (const fn of [orgRequired, ordersText, inventoryText, distributorsText]) {
    expect(message(() => fn(long, "Reason", 500))).toBe(
      "Reason is too long (up to 500 characters)",
    );
    expect(message(() => fn("", "Reason", 500))).toBe("Reason is required");
  }
});
