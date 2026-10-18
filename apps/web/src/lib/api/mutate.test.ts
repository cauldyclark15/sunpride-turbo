import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import { apiFetch } from "./fetch";
import { hashKey } from "./key";
import { mutate } from "./mutate";
import { ApiStore } from "./store";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("mutate", () => {
  it("POSTs JSON same-origin and refetches the invalidated keys after success", async () => {
    const store = new ApiStore();
    const board = vi.fn(async () => ["before"]);
    const orders = vi.fn(async () => ["orders"]);
    store.observe(
      hashKey(["issues", "board", { q: "" }]),
      () => board,
      () => {},
    );
    store.observe(
      hashKey(["orders"]),
      () => orders,
      () => {},
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const fetchImpl = vi.fn(async () => json(200, { moved: true }));
    const result = await mutate(
      "/api/v1/issues/move",
      { number: 142, status: "done" },
      {
        invalidate: [["issues"], null],
        idempotencyKey: "intent-1",
        store,
        fetchImpl,
      },
    );
    expect(result).toEqual({ moved: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/v1/issues/move");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(JSON.parse(String(init.body))).toEqual({
      number: 142,
      status: "done",
    });
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBe(
      "intent-1",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(board).toHaveBeenCalledTimes(2);
    expect(orders).toHaveBeenCalledTimes(1);
  });

  it("throws the normalized envelope and invalidates nothing on failure", async () => {
    const store = new ApiStore();
    const board = vi.fn(async () => ["row"]);
    store.observe(
      hashKey(["issues"]),
      () => board,
      () => {},
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const fetchImpl = vi.fn(async () =>
      json(422, {
        error: {
          code: "issue_closed",
          message: "This issue is closed.",
          retryable: false,
        },
      }),
    );
    const failure = await mutate(
      "/api/v1/issues/move",
      {},
      { invalidate: [["issues"]], store, fetchImpl },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).toJSON()).toEqual({
      code: "issue_closed",
      message: "This issue is closed.",
      retryable: false,
    });
    expect((failure as ApiError).status).toBe(422);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(board).toHaveBeenCalledTimes(1);
  });
});

describe("apiFetch", () => {
  it("builds query strings, maps bare statuses and refuses non-API paths", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response("", { status: 503 }),
    );
    const failure = await apiFetch("/api/v1/orders/list", {
      query: { status: ["open", "held"], cursor: null, limit: 20 },
      fetchImpl,
    }).catch((error: unknown) => error as ApiError);
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      "/api/v1/orders/list?status=open&status=held&limit=20",
    );
    expect((failure as ApiError).toJSON()).toMatchObject({
      code: "server_error",
      retryable: true,
    });
    await expect(apiFetch("/elsewhere", { fetchImpl })).rejects.toMatchObject({
      code: "invalid_path",
    });
    expect(
      await apiFetch("/api/me", {
        fetchImpl: async () => new Response(null, { status: 204 }),
      }),
    ).toBeNull();
  });
});
