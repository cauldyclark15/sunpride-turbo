import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { sign } from "../src/convex/client.js";

describe("HMAC signing", () => {
  test("signs timestamp and exact body", () => {
    const expected = createHmac("sha256", "secret")
      .update('123.{"ok":true}')
      .digest("hex");
    expect(sign("secret", "123", '{"ok":true}')).toBe(expected);
  });
});
