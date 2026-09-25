import { describe, expect, it } from "vitest";
import { canonical, payloadHash } from "./idempotency";

describe("processed operation payload hash", () => {
  it("sorts nested validated fields independently of object insertion order", async () => {
    const a = {
      activity: { text: "note", kind: "note" },
      deviceTime: 100,
      optional: undefined,
    };
    const b = { deviceTime: 100, activity: { kind: "note", text: "note" } };
    expect(canonical(a)).toBe(canonical(b));
    expect(await payloadHash(a)).toBe(await payloadHash(b));
    expect(await payloadHash(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await payloadHash({ ...a, deviceTime: 101 })).not.toBe(
      await payloadHash(a),
    );
  });
  it("rejects non-finite and non-JSON values instead of hashing a lossy representation", () => {
    expect(() => canonical({ value: NaN })).toThrow();
    expect(() => canonical({ value: Infinity })).toThrow();
    expect(() => canonical(new Date())).toThrow();
  });
});
