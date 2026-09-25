import { describe, expect, it, vi } from "vitest";
import type { ActionCtx } from "../_generated/server";
import { handleMobile } from "./http_handlers";

const actor = {
  deviceId: "device",
  profileId: "person",
  subject: "issuer|sales",
  orgUnitId: "unit",
  role: "sales",
  scopeFingerprint: "fingerprint",
};
const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const body = {
  type: "bootstrap.request",
  contractVersion: 1,
  deviceId: "device",
};
function harness(auth = true) {
  const burned = new Set<string>();
  const registry = new Map<string, unknown>();
  const authorize = vi.fn(async (args: { nonce: string; proof: string }) => {
    if (args.proof !== "signed" || burned.has(args.nonce))
      throw new Error("Invalid device proof");
    burned.add(args.nonce);
    return actor;
  });
  const apply = vi.fn(
    async (args: {
      operation: { clientRequestId: string; payload: unknown };
    }) => {
      const op = args.operation;
      if (op.payload && (op.payload as { reject?: boolean }).reject)
        throw new Error("Uncaught ConvexError: invalid_plan");
      const existing = registry.get(op.clientRequestId);
      if (existing) return existing;
      const result = {
        status: "accepted",
        ack: { entityId: "visit", eventIds: ["event"], serverTime: 123 },
      };
      registry.set(op.clientRequestId, result);
      return result;
    },
  );
  const ctx = {
    auth: {
      getUserIdentity: vi.fn(async () =>
        auth ? { tokenIdentifier: actor.subject } : null,
      ),
    },
    runMutation: vi.fn(async (_fn: unknown, args: Record<string, unknown>) =>
      "operation" in args
        ? apply(args as Parameters<typeof apply>[0])
        : authorize(args as Parameters<typeof authorize>[0]),
    ),
    runQuery: vi.fn(async () => ({
      type: "bootstrap.response",
      contractVersion: 1,
      serverTime: 123,
      plannedVisits: [],
    })),
  };
  return { ctx: ctx as unknown as ActionCtx, authorize, apply };
}
async function request(
  route: "bootstrap" | "pull" | "push",
  payload: unknown,
  overrides: Record<string, string> = {},
) {
  const text = JSON.stringify(payload);
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  return new Request(`https://example.convex.site/mobile/v1/${route}`, {
    method: "POST",
    body: text,
    headers: {
      "content-type": "application/json",
      authorization: "Bearer jwt",
      "x-mobile-contract-version": "1",
      "x-mobile-device-id": "device",
      "x-mobile-app": "IOS",
      "x-mobile-nonce": crypto.randomUUID(),
      "x-mobile-timestamp": String(Date.now()),
      "x-mobile-signature": "signed",
      "x-mobile-body-digest": digest,
      ...overrides,
    },
  });
}
describe("mobile HTTP boundary", () => {
  it("rejects missing and invalid bearer before authorizing a device", async () => {
    const h = harness();
    const missing = await handleMobile(
      h.ctx,
      await request("bootstrap", body, { authorization: "" }),
      "bootstrap",
    );
    expect(missing.status).toBe(401);
    expect(h.authorize).not.toHaveBeenCalled();
    const invalid = harness(false);
    expect(
      (
        await handleMobile(
          invalid.ctx,
          await request("bootstrap", body),
          "bootstrap",
        )
      ).status,
    ).toBe(401);
    expect(invalid.authorize).not.toHaveBeenCalled();
  });
  it("rejects bad proof and replayed nonce", async () => {
    const h = harness();
    expect(
      (
        await handleMobile(
          h.ctx,
          await request("bootstrap", body, { "x-mobile-signature": "bad" }),
          "bootstrap",
        )
      ).status,
    ).toBe(401);
    const nonce = crypto.randomUUID();
    expect(
      (
        await handleMobile(
          h.ctx,
          await request("bootstrap", body, { "x-mobile-nonce": nonce }),
          "bootstrap",
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await handleMobile(
          h.ctx,
          await request("bootstrap", body, { "x-mobile-nonce": nonce }),
          "bootstrap",
        )
      ).status,
    ).toBe(401);
  });
  it("rejects unsupported version, altered digest and oversized body before device authorization", async () => {
    const h = harness();
    expect(
      (
        await handleMobile(
          h.ctx,
          await request("bootstrap", body, {
            "x-mobile-contract-version": "2",
          }),
          "bootstrap",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleMobile(
          h.ctx,
          await request("bootstrap", { ...body, contractVersion: 2 }),
          "bootstrap",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleMobile(
          h.ctx,
          await request("bootstrap", body, {
            "x-mobile-body-digest": "0".repeat(64),
          }),
          "bootstrap",
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleMobile(
          h.ctx,
          await request("bootstrap", { ...body, extra: "x".repeat(131072) }),
          "bootstrap",
        )
      ).status,
    ).toBe(413);
    expect(h.authorize).not.toHaveBeenCalled();
  });
  it("rejects a batch of more than 20 without consuming the nonce", async () => {
    const h = harness();
    const operations = Array.from({ length: 21 }, () => ({
      kind: "task.complete",
      clientRequestId: uuid,
      payload: {},
    }));
    expect(
      (
        await handleMobile(
          h.ctx,
          await request("push", {
            type: "push.request",
            contractVersion: 1,
            deviceId: "device",
            operations,
          }),
          "push",
        )
      ).status,
    ).toBe(400);
    expect(h.authorize).not.toHaveBeenCalled();
  });
  it("returns per-operation business rejection but fails unexpected infrastructure errors", async () => {
    const h = harness();
    const op = {
      kind: "task.complete",
      clientRequestId: uuid,
      payload: { reject: true },
    };
    const r = await handleMobile(
      h.ctx,
      await request("push", {
        type: "push.request",
        contractVersion: 1,
        deviceId: "device",
        operations: [op],
      }),
      "push",
    );
    expect(r.status).toBe(200);
    expect((await r.json()).results[0]).toMatchObject({
      status: "rejected",
      code: "invalid_plan",
    });
    h.apply.mockRejectedValueOnce(new Error("database offline"));
    const fail = await handleMobile(
      h.ctx,
      await request("push", {
        type: "push.request",
        contractVersion: 1,
        deviceId: "device",
        operations: [op],
      }),
      "push",
    );
    expect(fail.status).toBe(500);
    expect((await fail.json()).code).toBe("temporarily_unavailable");
  });
  it("rejects malformed operation variants before consuming proof", async () => {
    const h = harness();
    const payload = {
      type: "push.request",
      contractVersion: 1,
      deviceId: "device",
      operations: [
        {
          kind: "visit.checkIn",
          clientRequestId: uuid,
          payload: {
            location: { latitude: 1, longitude: 2, withinGeofence: true },
          },
        },
      ],
    };
    expect(
      (await handleMobile(h.ctx, await request("push", payload), "push"))
        .status,
    ).toBe(400);
    expect(h.authorize).not.toHaveBeenCalled();
  });
  it("identical operation replay over two authenticated HTTP calls returns the same ack", async () => {
    const h = harness();
    const payload = {
      type: "push.request",
      contractVersion: 1,
      deviceId: "device",
      operations: [
        { kind: "task.complete", clientRequestId: uuid, payload: {} },
      ],
    };
    const first = await handleMobile(
      h.ctx,
      await request("push", payload),
      "push",
    );
    const second = await handleMobile(
      h.ctx,
      await request("push", payload),
      "push",
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await first.json()).results).toEqual((await second.json()).results);
    expect(h.authorize).toHaveBeenCalledTimes(2);
  });
});
