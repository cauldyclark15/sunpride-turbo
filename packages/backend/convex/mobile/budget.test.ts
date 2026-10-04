import { describe, expect, it } from "vitest";
import { acceptsGzip, pageCount, pageEnd } from "./budget";

describe("QSR-013 bootstrap budget helpers", () => {
  it("cuts pages by entry count and by bytes, always taking at least one entry", () => {
    const sizes = [10, 10, 10, 10, 10];
    // Each entry costs size + 1 separator byte.
    expect(pageEnd(sizes, 0, 100, 33)).toBe(3);
    expect(pageEnd(sizes, 0, 2, 1000)).toBe(2);
    expect(pageEnd(sizes, 3, 100, 1000)).toBe(5);
    expect(pageEnd([500], 0, 100, 10)).toBe(1);
    expect(pageEnd(sizes, 5, 100, 10)).toBe(5);
    expect(pageCount(sizes, 100, 33)).toBe(2);
    expect(pageCount(sizes, 1, 1000)).toBe(5);
    expect(pageCount([], 100, 1000)).toBe(1);
  });
  it("reads Accept-Encoding weights, an explicit gzip entry beating the wildcard", () => {
    expect(acceptsGzip("gzip, deflate, br")).toBe(true);
    expect(acceptsGzip("br;q=1.0, gzip;q=0.8, *;q=0.1")).toBe(true);
    expect(acceptsGzip("*")).toBe(true);
    expect(acceptsGzip("GZIP")).toBe(true);
    expect(acceptsGzip(null)).toBe(false);
    expect(acceptsGzip("identity")).toBe(false);
    expect(acceptsGzip("gzip;q=0")).toBe(false);
    expect(acceptsGzip("gzip;q=0, *")).toBe(false);
    expect(acceptsGzip("gzip;q=abc")).toBe(false);
  });
});
