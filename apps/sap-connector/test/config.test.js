import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config/index.js";

describe("connector configuration", () => {
  test("requires integration URL and secret", () => {
    expect(() => loadConfig({})).toThrow("CONVEX_INTEGRATION_URL");
  });
  test("accepts mock adapter without SAP credentials", () => {
    const config = loadConfig({
      CONVEX_INTEGRATION_URL: "https://example.convex.site",
      CONNECTOR_SIGNING_SECRET: "secret",
    });
    expect(config.adapter).toBe("mock");
  });
});
