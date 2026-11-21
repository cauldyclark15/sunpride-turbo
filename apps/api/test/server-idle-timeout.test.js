import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SERVER_IDLE_TIMEOUT_S } from "../src/core/app.js";

// Admin Today: Bun's default 10 s idle timeout dropped slow reads ("socket hang up")
// while the web proxy still waited. The API must outlast the proxy, within Bun's 255 s cap.
test("API request idle timeout outlasts the web proxy timeout", () => {
  const config = readFileSync(
    new URL("../../web/next.config.ts", import.meta.url),
    "utf8",
  );
  const proxyMs = Number(
    config.match(/proxyTimeout:\s*([\d_]+)/)?.[1]?.replaceAll("_", ""),
  );
  expect(proxyMs).toBeGreaterThan(0);
  expect(SERVER_IDLE_TIMEOUT_S * 1000).toBeGreaterThan(proxyMs);
  expect(SERVER_IDLE_TIMEOUT_S).toBeLessThanOrEqual(255);
});
