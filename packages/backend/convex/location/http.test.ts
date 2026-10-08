import { getFunctionName } from "convex/server";
import { describe, expect, it, vi } from "vitest";
import type { ActionCtx } from "../_generated/server";
import { handleMobile } from "../mobile/http_handlers";
import { handleVan } from "../van/http_handlers";

/** SP-0135: the signed location routes on both device gateways (proof boundary mocked). */
const actor = {
  deviceId: "device",
  profileId: "person",
  subject: "issuer|sales",
  orgUnitId: "unit",
  role: "sales",
  scopeFingerprint: "fingerprint",
};
const ping = (extra: Record<string, unknown> = {}) => ({
  clientPingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  recordedAt: 1_790_000_000_000,
  latitude: 10.3157,
  longitude: 123.8854,
  accuracyMeters: 10,
  speedMetersPerSecond: null,
  headingDegrees: null,
  batteryPercent: 70,
  mockLocation: false,
  provider: "gps",
  trigger: "still",
  ...extra,
});

function harness(apply?: () => Promise<unknown>) {
  const authorize = vi.fn(async (args: Record<string, unknown>) => {
    void args;
    return actor;
  });
  const batch = vi.fn(async (args: Record<string, unknown>) => {
    if (apply) return apply();
    return (args.pings as { clientPingId: string }[]).map((p) => ({
      clientPingId: p.clientPingId,
      status: "accepted",
    }));
  });
  const runMutation = vi.fn(
    async (fn: unknown, args: Record<string, unknown>) => {
      switch (getFunctionName(fn as never)) {
        case "mobile/device_auth:authorize":
          return authorize(args);
        case "location/ingest:applyBatch":
          return batch(args);
        case "mobile/rate_limits:reserve":
          return 0;
        case "mobile/rate_limits:refund":
          return null;
        default:
          throw new Error("Unexpected mutation");
      }
    },
  );
  const ctx = {
    auth: {
      getUserIdentity: vi.fn(async () => ({ tokenIdentifier: actor.subject })),
    },
    runMutation,
    runQuery: vi.fn(),
  } as unknown as ActionCtx;
  return { ctx, authorize, batch };
}

async function request(gateway: "mobile" | "van", payload: unknown) {
  const text = JSON.stringify(payload);
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  return new Request(`https://example.convex.site/${gateway}/v1/location`, {
    method: "POST",
    body: text,
    headers: {
      "content-type": "application/json",
      authorization: "Bearer jwt",
      "x-mobile-contract-version": "1",
      "x-mobile-device-id": "device",
      "x-mobile-app": gateway === "van" ? "VAN_ANDROID" : "ANDROID",
      "x-mobile-nonce": crypto.randomUUID(),
      "x-mobile-timestamp": String(Date.now()),
      "x-mobile-signature": "signed",
      "x-mobile-body-digest": digest,
    },
  });
}

const fieldBody = (pings: unknown[]) => ({
  type: "location.request",
  contractVersion: 1,
  deviceId: "device",
  pings,
});
const vanBody = (pings: unknown[]) => ({
  type: "van.location.request",
  contractVersion: 1,
  deviceId: "device",
  pings,
});

describe("location HTTP routes", () => {
  it("field: signs /mobile/v1/location and returns one result per ping", async () => {
    const h = harness();
    const response = await handleMobile(
      h.ctx,
      await request("mobile", fieldBody([ping()])),
      "location",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      type: "location.response",
      contractVersion: 1,
      results: [{ status: "accepted" }],
    });
    expect(h.authorize.mock.calls[0]![0]).toMatchObject({
      app: "ANDROID",
      path: "/mobile/v1/location",
    });
    expect(h.batch.mock.calls[0]![0]).toMatchObject({ kind: "field", actor });
  });

  it("van: signs /van/v1/location for VAN_ANDROID with tripId on every ping", async () => {
    const h = harness();
    const response = await handleVan(
      h.ctx,
      await request("van", vanBody([ping({ tripId: "trip" })])),
      "location",
    );
    expect(response.status).toBe(200);
    expect((await response.json()).type).toBe("van.location.response");
    expect(h.authorize.mock.calls[0]![0]).toMatchObject({
      app: "VAN_ANDROID",
      path: "/van/v1/location",
    });
    expect(h.batch.mock.calls[0]![0]).toMatchObject({ kind: "van" });
  });

  it.each([
    ["no pings", fieldBody([])],
    ["101 pings", fieldBody(Array.from({ length: 101 }, () => ping()))],
    ["a field ping with tripId", fieldBody([ping({ tripId: "trip" })])],
    ["latitude out of range", fieldBody([ping({ latitude: 91 })])],
    ["an unknown field", fieldBody([ping({ employeeId: "x" })])],
    ["an extra envelope field", { ...fieldBody([ping()]), limit: 5 }],
  ])("field: rejects %s before the proof", async (_label, payload) => {
    const h = harness();
    const response = await handleMobile(
      h.ctx,
      await request("mobile", payload),
      "location",
    );
    expect(response.status).toBe(400);
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it("van: rejects a ping without tripId or with visitId", async () => {
    for (const bad of [ping(), ping({ tripId: "t", visitId: "v" })]) {
      const h = harness();
      const response = await handleVan(
        h.ctx,
        await request("van", vanBody([bad])),
        "location",
      );
      expect(response.status).toBe(400);
      expect(h.batch).not.toHaveBeenCalled();
    }
  });

  it("maps the writer's per-transaction refusal to 401 on both gateways", async () => {
    const refuse = async () => {
      throw new Error("Uncaught ConvexError: unauthorized");
    };
    const field = await handleMobile(
      harness(refuse).ctx,
      await request("mobile", fieldBody([ping()])),
      "location",
    );
    expect(field.status).toBe(401);
    const van = await handleVan(
      harness(refuse).ctx,
      await request("van", vanBody([ping({ tripId: "trip" })])),
      "location",
    );
    expect(van.status).toBe(401);
  });
});
