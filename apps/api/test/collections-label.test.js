import { expect, test } from "bun:test";
import { dayInWords, itemLabel } from "../src/domains/coverage/collections.js";

test("WEB-062 a promise's For text reads dates in words, never ISO", () => {
  const items = [
    { ref: "a", documentNumber: "INV-1", dueDate: "2026-09-28" },
    { ref: "b", invoiceDate: "2026-09-01", dueDate: "2026-10-01" },
    { ref: "c" },
  ];
  expect(itemLabel(items, "a")).toBe("Invoice INV-1, due Sep 28, 2026");
  expect(itemLabel(items, "b")).toBe("Invoice of Sep 1, 2026, due Oct 1, 2026");
  expect(itemLabel(items, "c")).toBe("Open item");
  expect(itemLabel(items, "gone")).toBe(
    "Open item (since settled in the snapshot)",
  );
  expect(itemLabel(items, null)).toBeNull();
  for (const ref of ["a", "b"])
    expect(itemLabel(items, ref)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  expect(dayInWords("2026-11-12T03:00:00Z")).toBe("Nov 12, 2026");
});
