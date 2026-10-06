import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { describe, expect, it, vi } from "vitest";
import type { ActionCtx } from "../_generated/server";
import { handleVan } from "./http_handlers";

const actor = {
  deviceId: "device",
  profileId: "seller",
  subject: "issuer|seller",
  orgUnitId: "unit",
  role: "sales",
  scopeFingerprint: "fixture",
};
const uuid = (n = 1) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const operation = (n = 1) => ({
  kind: "trip.start",
  clientRequestId: uuid(n),
  payload: { tripId: "trip", vehicleConfirmed: true, routeConfirmed: true },
});
const body = (
  route: "bootstrap" | "push",
  operations: unknown[] = [operation()],
) => ({
  type: `van.${route}.request`,
  contractVersion: 1,
  deviceId: "device",
  ...(route === "push" ? { operations } : {}),
});
function harness(auth = true) {
  const authorize = vi.fn(async (_args: Record<string, unknown>) => {
    void _args;
    return actor;
  });
  const apply = vi.fn(async (_args: Record<string, unknown>) => {
    void _args;
    return {
      status: "accepted",
      ack: { entityId: "trip", movementId: null, serverTime: 123 },
    };
  });
  const reserve = vi.fn(async () => 0),
    refund = vi.fn(async () => null);
  const runQuery = vi.fn(async () => ({
    type: "van.bootstrap.response",
    contractVersion: 1,
    serverTime: 123,
    trip: null,
    load: null,
    products: [],
    customers: [],
    truckStock: [],
  }));
  const runMutation = vi.fn(
    async (fn: unknown, args: Record<string, unknown>) => {
      switch (getFunctionName(fn as never)) {
        case "mobile/device_auth:authorize":
          return authorize(args);
        case "van/device:applyOne":
          return apply(args);
        case "mobile/rate_limits:refund":
          return refund();
        case "mobile/rate_limits:reserve":
          return reserve();
        default:
          throw new Error("Unexpected mutation");
      }
    },
  );
  const ctx = {
    auth: {
      getUserIdentity: vi.fn(async () =>
        auth ? { tokenIdentifier: actor.subject } : null,
      ),
    },
    runMutation,
    runQuery,
  } as unknown as ActionCtx;
  return { ctx, authorize, apply, reserve, refund, runQuery, runMutation };
}
async function request(
  route: "bootstrap" | "push",
  value: unknown = body(route),
  overrides: Record<string, string> = {},
  raw?: string,
) {
  const text = raw ?? JSON.stringify(value);
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return new Request(`https://example.convex.site/van/v1/${route}`, {
    method: "POST",
    body: text,
    headers: {
      "content-type": "application/json",
      authorization: "Bearer jwt",
      "x-mobile-contract-version": "1",
      "x-mobile-device-id": "device",
      "x-mobile-app": "VAN_ANDROID",
      "x-mobile-nonce": uuid(),
      "x-mobile-timestamp": String(Date.now()),
      "x-mobile-signature": "signed",
      "x-mobile-body-digest": digest,
      ...overrides,
    },
  });
}

describe("van HTTP gateway", () => {
  it.each(["bootstrap", "push"] as const)(
    "authorizes VAN_ANDROID with the exact /van/v1/%s proof path",
    async (route) => {
      const h = harness();
      const req = await request(route);
      const digest = req.headers.get("x-mobile-body-digest");
      const response = await handleVan(h.ctx, req, route);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(h.authorize).toHaveBeenCalledExactlyOnceWith({
        deviceId: "device",
        app: "VAN_ANDROID",
        method: "POST",
        path: `/van/v1/${route}`,
        proof: "signed",
        bodyDigest: digest,
        nonce: uuid(),
        timestamp: Number(req.headers.get("x-mobile-timestamp")),
      });
      expect(h.reserve).toHaveBeenCalledOnce();
      expect(h.refund).toHaveBeenCalledOnce();
      if (route === "bootstrap") {
        expect(h.runQuery).toHaveBeenCalledWith(expect.anything(), {
          actor,
          now: expect.any(Number),
        });
        expect(h.apply).not.toHaveBeenCalled();
      } else {
        expect(h.apply).toHaveBeenCalledExactlyOnceWith({
          actor,
          operation: operation(),
        });
        expect(await response.json()).toMatchObject({
          type: "van.push.response",
          contractVersion: 1,
          results: [
            {
              kind: "trip.start",
              clientRequestId: uuid(),
              status: "accepted",
              ack: { entityId: "trip", movementId: null, serverTime: 123 },
            },
          ],
        });
      }
    },
  );

  it("rejects unsupported header/body versions before device proof work", async () => {
    const h = harness();
    for (const [value, headers] of [
      [body("bootstrap"), { "x-mobile-contract-version": "2" }],
      [{ ...body("bootstrap"), contractVersion: 2 }, {}],
    ] as const) {
      const response = await handleVan(
        h.ctx,
        await request("bootstrap", value, headers),
        "bootstrap",
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "version_unsupported",
        retryable: false,
      });
    }
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it.each(["", "Basic token", "Bearer a b"])(
    "rejects invalid/missing bearer %s",
    async (authorization) => {
      const h = harness();
      const response = await handleVan(
        h.ctx,
        await request("bootstrap", body("bootstrap"), { authorization }),
        "bootstrap",
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "unauthorized" });
      expect(h.authorize).not.toHaveBeenCalled();
      expect(h.reserve).not.toHaveBeenCalled();
    },
  );

  it("requires a valid bearer identity, not just a header", async () => {
    const h = harness(false);
    expect(
      (await handleVan(h.ctx, await request("bootstrap"), "bootstrap")).status,
    ).toBe(401);
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it.each(["ANDROID", "IOS", ""])(
    "rejects x-mobile-app %s without authorizing",
    async (app) => {
      const h = harness();
      const response = await handleVan(
        h.ctx,
        await request("bootstrap", body("bootstrap"), { "x-mobile-app": app }),
        "bootstrap",
      );
      expect(response.status).toBe(401);
      expect(h.authorize).not.toHaveBeenCalled();
      expect(h.refund).not.toHaveBeenCalled();
    },
  );

  it.each<Record<string, string>>([
    { "x-mobile-body-digest": "f".repeat(64) },
    { "x-mobile-device-id": "different" },
    { "x-mobile-signature": "" },
    { "x-mobile-nonce": "invalid" },
    { "x-mobile-timestamp": "1" },
  ])("rejects invalid proof headers %j", async (headers) => {
    const h = harness();
    const response = await handleVan(
      h.ctx,
      await request("bootstrap", body("bootstrap"), headers),
      "bootstrap",
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthorized" });
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it.each([
    { ...operation(), clientRequestId: "not-a-uuid" },
    { ...operation(), kind: "sale.unknown" },
    { ...operation(), payload: null },
    { ...operation(), extra: true },
    { ...operation(), payload: { tripId: "x".repeat(65) } },
  ])("rejects malformed operation %j before proof work", async (op) => {
    const h = harness();
    const response = await handleVan(
      h.ctx,
      await request("push", body("push", [op])),
      "push",
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_request" });
    expect(h.authorize).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
  });

  it.each([0, 21])("rejects push operation count %i", async (count) => {
    const h = harness();
    const response = await handleVan(
      h.ctx,
      await request(
        "push",
        body(
          "push",
          Array.from({ length: count }, (_, n) => operation(n + 1)),
        ),
      ),
      "push",
    );
    expect(response.status).toBe(400);
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it("rejects unknown envelope fields, malformed JSON and wrong content type", async () => {
    for (const req of [
      await request("bootstrap", { ...body("bootstrap"), extra: true }),
      await request("bootstrap", body("bootstrap"), {}, "{"),
      await request("bootstrap", body("bootstrap"), {
        "content-type": "text/plain",
      }),
    ]) {
      const h = harness();
      expect((await handleVan(h.ctx, req, "bootstrap")).status).toBe(400);
      expect(h.authorize).not.toHaveBeenCalled();
    }
  });

  it("maps real ConvexErrors per operation and continues the rest of a batch", async () => {
    const h = harness();
    const codes = [
      "invalid_request",
      "conflict",
      "out_of_scope",
      "wrong_date",
      "load_not_posted",
    ];
    for (const code of codes)
      h.apply.mockRejectedValueOnce(new ConvexError(code));
    const response = await handleVan(
      h.ctx,
      await request(
        "push",
        body(
          "push",
          Array.from({ length: 6 }, (_, n) => operation(n + 1)),
        ),
      ),
      "push",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      results: [
        ...codes.map((code, n) => ({
          kind: "trip.start",
          clientRequestId: uuid(n + 1),
          status: code === "conflict" ? "conflict" : "rejected",
          code,
        })),
        { clientRequestId: uuid(6), status: "accepted" },
      ],
    });
    expect(h.apply).toHaveBeenCalledTimes(6);
    expect(h.refund).toHaveBeenCalledOnce();
  });

  it("maps serialized ConvexError strings but does not mistake arbitrary exception text for business codes", async () => {
    const h = harness();
    h.apply.mockRejectedValueOnce(
      new Error("Uncaught ConvexError: conflict\n"),
    );
    const response = await handleVan(h.ctx, await request("push"), "push");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      results: [{ status: "conflict", code: "conflict" }],
    });
    h.apply.mockRejectedValueOnce(
      new Error("unexpected_conflict_suffix: sensitive internal details"),
    );
    const failure = await handleVan(h.ctx, await request("push"), "push");
    expect(failure.status).toBe(500);
    expect(await failure.text()).not.toContain("sensitive");
  });

  it("fails proof authorization closed and maps infrastructure failure to retryable 500", async () => {
    const h = harness();
    h.authorize.mockRejectedValueOnce(new Error("bad signature"));
    expect(
      (await handleVan(h.ctx, await request("bootstrap"), "bootstrap")).status,
    ).toBe(401);
    expect(h.runQuery).not.toHaveBeenCalled();
    h.runQuery.mockRejectedValueOnce(new Error("database unavailable"));
    const response = await handleVan(
      h.ctx,
      await request("bootstrap"),
      "bootstrap",
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "temporarily_unavailable",
      retryable: true,
    });
  });

  it("enforces the request budget before proof work and reports retry-after", async () => {
    const h = harness();
    h.reserve.mockResolvedValueOnce(30_001);
    const response = await handleVan(h.ctx, await request("push"), "push");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("31");
    expect(h.authorize).not.toHaveBeenCalled();
    expect(h.refund).not.toHaveBeenCalled();
  });
});
