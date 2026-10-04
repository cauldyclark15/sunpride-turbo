import { describe, expect, test } from "bun:test";
import { DurableQueue } from "../src/queue/sqlite.js";
import {
  MAX_ERROR_LENGTH,
  REDACTED,
  createRedactor,
  secretsFromConfig,
} from "../src/redact.js";
import { ConnectorService } from "../src/service.js";

const config = {
  connectorId: "test-connector",
  signingSecret: "signing-secret-0123456789abcdef",
  sapUsername: "SAPUSER",
  sapPassword: "p@ss:word/With+Specials",
};
const basic = btoa(`${config.sapUsername}:${config.sapPassword}`);
const leaks = [
  config.signingSecret,
  config.sapPassword,
  encodeURIComponent(config.sapPassword),
  basic,
];

function expectClean(text) {
  for (const leak of leaks) expect(text).not.toContain(leak);
}

describe("connector error redaction", () => {
  test("collects the signing secret, SAP password and Basic token", () => {
    expect(secretsFromConfig(config)).toEqual([
      config.signingSecret,
      config.sapPassword,
      basic,
    ]);
    expect(secretsFromConfig({ signingSecret: "" })).toEqual([]);
  });

  test("removes configured secrets, encoded forms and credential headers", () => {
    const redact = createRedactor(secretsFromConfig(config));
    const text = redact(
      new Error(
        `failed with ${config.signingSecret} url=?pw=${encodeURIComponent(config.sapPassword)} Authorization: Basic ${basic} {"password":"${config.sapPassword}"} Bearer abc.def.ghi token=xyz`,
      ),
    );
    expectClean(text);
    expect(text).not.toContain("abc.def.ghi");
    expect(text).not.toContain("xyz");
    expect(text).toContain(REDACTED);
  });

  test("drops stack traces and bounds message length", () => {
    const redact = createRedactor([]);
    const error = new Error("x".repeat(5_000));
    const text = redact(error);
    expect(text.length).toBeLessThanOrEqual(MAX_ERROR_LENGTH + 1);
    expect(text).not.toContain("at ");
  });

  test("never lets a credential reach logs, queue, health, acks or heartbeats", async () => {
    const queue = new DurableQueue(":memory:");
    const logged = [];
    const reported = [];
    const failure = `SAP OData request failed: 401 Authorization: Basic ${basic} password=${config.sapPassword} secret ${config.signingSecret}`;
    const convex = {
      publish: async () => {},
      tasks: async () => ({
        tasks: [{ eventId: "evt-1", eventType: "sales-order.submit" }],
      }),
      acknowledge: async (body) => {
        reported.push(JSON.stringify(body));
      },
      heartbeat: async (body) => {
        reported.push(JSON.stringify(body));
        throw new Error(`heartbeat rejected ${config.signingSecret}`);
      },
    };
    const sap = {
      name: "odata",
      pullChanges: async () => [],
      submitEvent: async () => {
        throw new Error(failure);
      },
    };
    const service = new ConnectorService({
      config,
      queue,
      convex,
      sap,
      logger: { error: (...args) => logged.push(args.map(String).join(" ")) },
    });
    await service.cycle();

    const stored = queue.db
      .query("SELECT last_error FROM queue WHERE id = 'evt-1'")
      .get();
    const health = JSON.stringify(service.health());
    expect(logged.length).toBeGreaterThan(0);
    expect(reported.length).toBeGreaterThan(0);
    for (const text of [...logged, ...reported, stored.last_error, health])
      expectClean(text);
    expect(stored.last_error).toContain("SAP OData request failed: 401");
    queue.close();
  });
});
