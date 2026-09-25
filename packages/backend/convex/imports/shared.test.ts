import { describe, expect, it } from "vitest";
import {
  chunk,
  chunkKey,
  ERROR_CODES,
  fileHashOf,
  normalizeBarcode,
  normalizeCode,
  parseCsvBoolean,
  parseCsvDate,
  parseCsvInteger,
  requiredCell,
  rowError,
} from "./shared";

describe("csv scalar parsing", () => {
  it("normalizes codes and barcodes", () => {
    expect(normalizeCode("  sp-pj-1l ")).toBe("SP-PJ-1L");
    expect(normalizeBarcode("480-1234 567890")).toBe("4801234567890");
    expect(normalizeBarcode("no digits")).toBe("");
  });

  it("parses the accepted boolean spellings and rejects the rest", () => {
    expect(parseCsvBoolean("Y", false)).toBe(true);
    expect(parseCsvBoolean("N", true)).toBe(false);
    expect(parseCsvBoolean("", true)).toBe(true);
    expect(parseCsvBoolean("maybe", true)).toBeNull();
  });

  it("parses only ISO dates", () => {
    expect(parseCsvDate("2026-08-01")).toBe(
      Date.parse("2026-08-01T00:00:00.000Z"),
    );
    expect(parseCsvDate("01/08/2026")).toBeNull();
    expect(parseCsvDate("")).toBeNull();
  });

  it("parses only integers", () => {
    expect(parseCsvInteger("240")).toBe(240);
    expect(parseCsvInteger("-3")).toBe(-3);
    expect(parseCsvInteger("2.5")).toBeNull();
    expect(parseCsvInteger("")).toBeNull();
  });
});

describe("chunking", () => {
  it("splits rows at the chunk boundary", () => {
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    expect(chunk([], 2)).toEqual([]);
    expect(chunk(new Array(101).fill(0), 100).map((c) => c.length)).toEqual([
      100, 1,
    ]);
  });

  it("builds stable per-chunk idempotency keys", () => {
    expect(chunkKey("products", "run-1", 0)).toBe("products:run-1:0");
    expect(chunkKey("opening_stock", "run-1", 3)).toBe("opening_stock:run-1:3");
  });

  it("hashes the same payload identically and different payloads differently", () => {
    const rows = [{ rowNumber: 1, values: { product_code: "A" } }];
    expect(fileHashOf(1, rows)).toBe(fileHashOf(1, rows));
    expect(fileHashOf(1, rows)).not.toBe(
      fileHashOf(1, [{ rowNumber: 1, values: { product_code: "B" } }]),
    );
  });
});

describe("row helpers", () => {
  it("reports a required column once", () => {
    const errors: ReturnType<typeof rowError>[] = [];
    expect(
      requiredCell({ rowNumber: 2, values: {} }, "name", errors),
    ).toBeNull();
    expect(errors).toEqual([
      {
        rowNumber: 2,
        column: "name",
        code: ERROR_CODES.requiredMissing,
        message: "name is required",
      },
    ]);
    expect(
      requiredCell({ rowNumber: 3, values: { name: " Ada " } }, "name", errors),
    ).toBe("Ada");
    expect(errors).toHaveLength(1);
  });
});
