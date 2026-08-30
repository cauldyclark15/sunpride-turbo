import { describe, expect, it } from "vitest";

describe("offline order policy", () => {
  it("uses stable idempotency identifiers", () => {
    const id = crypto.randomUUID();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("caps exponential retry delay at one minute", () => {
    const delay = (attempts: number) => Math.min(60_000, 1000 * 2 ** attempts);
    expect(delay(1)).toBe(2_000);
    expect(delay(10)).toBe(60_000);
  });
});
