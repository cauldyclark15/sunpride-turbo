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
function harness(auth = true, backoffMs = 0) {
  const burned = new Set<string>();
  const failures: string[] = [];
  const backoff = vi.fn(async () => backoffMs);
  const recordFailure = vi.fn(async (args: { subject: string }) => {
    failures.push(args.subject);
    return 0;
  });
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
        : "proof" in args
          ? authorize(args as Parameters<typeof authorize>[0])
          : recordFailure(args as { subject: string }),
    ),
    runQuery: vi.fn(async (_fn: unknown, args: Record<string, unknown>) =>
      "actor" in args
        ? {
            type: "bootstrap.response",
            contractVersion: 1,
            serverTime: 123,
            plannedVisits: [],
          }
        : backoff(),
    ),
  };
  return {
    ctx: ctx as unknown as ActionCtx,
    authorize,
    apply,
    backoff,
    recordFailure,
    failures,
  };
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
  it.each(["call_open", "mcp_order", "wrong_date"])(
    "returns field-day rule %s as invalid_request with an additive reason",
    async (reason) => {
      const h = harness();
      h.apply.mockRejectedValueOnce(
        new Error(`Uncaught ConvexError: ${reason}\n    at handler`),
      );
      const r = await handleMobile(
        h.ctx,
        await request("push", {
          type: "push.request",
          contractVersion: 1,
          deviceId: "device",
          operations: [
            { kind: "task.complete", clientRequestId: uuid, payload: {} },
          ],
        }),
        "push",
      );
      expect(r.status).toBe(200);
      expect((await r.json()).results[0]).toEqual({
        kind: "task.complete",
        clientRequestId: uuid,
        status: "rejected",
        code: "invalid_request",
        reason,
      });
    },
  );
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
  it("passes a well-formed call_sheet activity through and rejects malformed lines before proof", async () => {
    const line = {
      productId: "product",
      order: 24,
      beginningInventory: 10,
      take: null,
      delivered: 24,
      offtake: 26,
      endInventory: 8,
    };
    const push = (lines: unknown) => ({
      type: "push.request",
      contractVersion: 1,
      deviceId: "device",
      operations: [
        {
          kind: "visit.activity",
          clientRequestId: uuid,
          payload: {
            visitId: "visit",
            activity: { kind: "call_sheet", lines },
            deviceTime: 1,
          },
        },
      ],
    });
    const ok = harness();
    const accepted = await handleMobile(
      ok.ctx,
      await request("push", push([line])),
      "push",
    );
    expect(accepted.status).toBe(200);
    expect(ok.apply).toHaveBeenCalledTimes(1);
    const { take: _omitted, ...missingMeasure } = line;
    void _omitted;
    for (const lines of [
      [],
      [missingMeasure],
      [{ ...line, order: -1 }],
      [{ ...line, order: 1.5 }],
      [{ ...line, order: 1_000_001 }],
      [{ ...line, order: "24" }],
      [{ ...line, remarks: "x" }],
      Array.from({ length: 101 }, () => line),
    ]) {
      const h = harness();
      expect(
        (await handleMobile(h.ctx, await request("push", push(lines)), "push"))
          .status,
      ).toBe(400);
      expect(h.authorize).not.toHaveBeenCalled();
    }
  });
  describe("abuse and rate controls (QSR-009)", () => {
    it("spends the identity's invalid-request budget only on rejected requests", async () => {
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
      expect(
        (
          await handleMobile(
            h.ctx,
            await request("bootstrap", { ...body, limit: 101 }),
            "bootstrap",
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await handleMobile(
            h.ctx,
            await request("bootstrap", { ...body, extra: "x".repeat(131072) }),
            "bootstrap",
          )
        ).status,
      ).toBe(413);
      expect(h.failures).toEqual([actor.subject, actor.subject, actor.subject]);
      expect(
        (
          await handleMobile(
            h.ctx,
            await request("bootstrap", body),
            "bootstrap",
          )
        ).status,
      ).toBe(200);
      expect(h.recordFailure).toHaveBeenCalledTimes(3);
    });
    it("counts a tampered cursor but not a legitimate rebootstrap", async () => {
      const pull = {
        type: "pull.request",
        contractVersion: 1,
        deviceId: "device",
        cursor: "c",
      };
      for (const [code, counted] of [
        ["invalid_cursor", 1],
        ["rebootstrap_required", 0],
      ] as const) {
        const h = harness();
        (h.ctx.runQuery as ReturnType<typeof vi.fn>).mockImplementation(
          async (_fn: unknown, args: Record<string, unknown>) => {
            if ("actor" in args)
              throw new Error(`Uncaught ConvexError: ${code}`);
            return 0;
          },
        );
        const r = await handleMobile(
          h.ctx,
          await request("pull", pull),
          "pull",
        );
        expect(r.status).toBe(409);
        expect((await r.json()).code).toBe(code);
        expect(h.recordFailure).toHaveBeenCalledTimes(counted);
      }
    });
    it("tells a throttled identity to back off before parsing or verifying proof", async () => {
      const h = harness(true, 12_345);
      const r = await handleMobile(
        h.ctx,
        await request("bootstrap", body),
        "bootstrap",
      );
      expect(r.status).toBe(429);
      expect(r.headers.get("retry-after")).toBe("13");
      expect(await r.json()).toMatchObject({
        type: "error.response",
        contractVersion: 1,
        code: "temporarily_unavailable",
        retryable: true,
      });
      expect(h.authorize).not.toHaveBeenCalled();
      expect(h.recordFailure).not.toHaveBeenCalled();
    });
    it("never checks the budget for an unauthenticated request", async () => {
      const h = harness(false);
      expect(
        (
          await handleMobile(
            h.ctx,
            await request("bootstrap", body),
            "bootstrap",
          )
        ).status,
      ).toBe(401);
      expect(h.backoff).not.toHaveBeenCalled();
      expect(h.recordFailure).not.toHaveBeenCalled();
    });
    it("keeps the client error when failure accounting itself fails", async () => {
      const h = harness();
      h.recordFailure.mockRejectedValueOnce(new Error("conflict"));
      expect(
        (
          await handleMobile(
            h.ctx,
            await request("bootstrap", body, { "x-mobile-signature": "bad" }),
            "bootstrap",
          )
        ).status,
      ).toBe(401);
    });
  });
  it("passes a well-formed field order through and rejects malformed lines before proof", async () => {
    const orderId = "00000000-0000-4000-8000-000000000900";
    const line = { productId: "product", uom: "CAN", quantity: 12 };
    const push = (lines: unknown) => ({
      type: "push.request",
      contractVersion: 1,
      deviceId: "device",
      operations: [
        {
          kind: "visit.activity",
          clientRequestId: uuid,
          payload: {
            visitId: "visit",
            activity: { kind: "order_intent", clientOrderId: orderId, lines },
            deviceTime: 1,
          },
        },
      ],
    });
    const ok = harness();
    const accepted = await handleMobile(
      ok.ctx,
      await request("push", push([line])),
      "push",
    );
    expect(accepted.status).toBe(200);
    expect(ok.apply).toHaveBeenCalledTimes(1);
    for (const lines of [
      [],
      [{ productId: "product", quantity: 1 }],
      [{ ...line, quantity: 0 }],
      [{ ...line, quantity: 1.5 }],
      [{ ...line, quantity: 100_000 }],
      [{ ...line, quantity: "12" }],
      [{ ...line, uom: "" }],
      [{ ...line, unitPrice: 189 }],
      Array.from({ length: 101 }, () => line),
    ]) {
      const h = harness();
      expect(
        (await handleMobile(h.ctx, await request("push", push(lines)), "push"))
          .status,
      ).toBe(400);
      expect(h.authorize).not.toHaveBeenCalled();
    }
  });
});

/** Replace the snapshot/delta read while keeping the QSR-009 back-off query at zero. */
function snapshot(
  h: ReturnType<typeof harness>,
  read: () => Promise<unknown>,
): void {
  (h.ctx.runQuery as ReturnType<typeof vi.fn>).mockImplementation(
    async (_fn: unknown, args: Record<string, unknown>) =>
      "actor" in args ? read() : 0,
  );
}

describe("QSR-013 bootstrap response strategy", () => {
  const big = {
    type: "bootstrap.response",
    contractVersion: 1,
    serverTime: 123,
    plannedVisits: Array.from({ length: 50 }, (_, i) => ({
      id: `visit-${i}`,
      outletId: `outlet-${i}`,
    })),
  };
  it("gzips a large bootstrap/pull body only when the phone accepts gzip", async () => {
    for (const route of ["bootstrap", "pull"] as const) {
      const payload =
        route === "bootstrap"
          ? body
          : {
              type: "pull.request",
              contractVersion: 1,
              deviceId: "device",
              cursor: "c",
            };
      const h = harness();
      snapshot(h, async () => big);
      const zipped = await handleMobile(
        h.ctx,
        await request(route, payload, {
          "accept-encoding": "gzip, deflate, br",
        }),
        route,
      );
      expect(zipped.status).toBe(200);
      expect(zipped.headers.get("content-encoding")).toBe("gzip");
      expect(zipped.headers.get("vary")).toBe("accept-encoding");
      const raw = new Uint8Array(await zipped.arrayBuffer());
      expect(raw.length).toBeLessThan(JSON.stringify(big).length);
      const inflated = await new Response(
        new Response(raw).body!.pipeThrough(new DecompressionStream("gzip")),
      ).json();
      expect(inflated).toEqual(big);
      const plain = harness();
      snapshot(plain, async () => big);
      for (const encoding of [undefined, "identity", "gzip;q=0, *"]) {
        const response = await handleMobile(
          plain.ctx,
          await request(
            route,
            payload,
            encoding ? { "accept-encoding": encoding } : {},
          ),
          route,
        );
        expect(response.headers.get("content-encoding")).toBeNull();
        expect(await response.json()).toEqual(big);
      }
    }
  });
  it("leaves small bodies uncompressed", async () => {
    const h = harness();
    const response = await handleMobile(
      h.ctx,
      await request("bootstrap", body, { "accept-encoding": "gzip" }),
      "bootstrap",
    );
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.json()).toMatchObject({ type: "bootstrap.response" });
  });
  it("maps an over-budget working set to a non-retryable 413 invalid_request", async () => {
    const h = harness();
    snapshot(h, async () => {
      throw new Error(
        "Uncaught ConvexError: working_set_too_large\n    at handler",
      );
    });
    const response = await handleMobile(
      h.ctx,
      await request("bootstrap", body),
      "bootstrap",
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      type: "error.response",
      code: "invalid_request",
      retryable: false,
    });
    // An honest phone with an oversized plan must not burn its invalid-request budget.
    expect(h.recordFailure).not.toHaveBeenCalled();
  });
});
