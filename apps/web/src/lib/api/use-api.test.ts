import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import { useApi, useApiPages } from "./hooks";
import { hashKey } from "./key";
import { ApiProvider } from "./provider";
import { ApiStore, type Fetcher } from "./store";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Renders a probe through the real hook (server snapshot path). */
function renderProbe(
  store: ApiStore,
  key: Parameters<typeof useApi>[0],
  fetcher: Fetcher<unknown>,
) {
  function Probe() {
    const result = useApi(key, fetcher);
    return createElement(
      "pre",
      null,
      JSON.stringify({
        status: result.status,
        isLoading: result.isLoading,
        data: result.data === undefined ? "<undefined>" : result.data,
      }),
    );
  }
  const markup = renderToStaticMarkup(
    createElement(ApiProvider, { store }, createElement(Probe)),
  );
  return JSON.parse(
    markup
      .replace(/^<pre>|<\/pre>$/g, "")
      .replaceAll("&quot;", '"')
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">"),
  ) as { status: string; isLoading: boolean; data: unknown };
}

describe("useApi", () => {
  it("skips a null key: no request, idle, data undefined", () => {
    const store = new ApiStore();
    const fetcher = vi.fn(async () => "never");
    expect(renderProbe(store, null, fetcher)).toEqual({
      status: "idle",
      isLoading: false,
      data: "<undefined>",
    });
    expect(renderProbe(store, false, fetcher).status).toBe("idle");
    expect(fetcher).not.toHaveBeenCalled();
    expect(store.keys()).toEqual([]);
  });

  it("keeps loading-undefined, null and [] distinct", async () => {
    const store = new ApiStore();
    expect(renderProbe(store, ["profile"], vi.fn())).toEqual({
      status: "loading",
      isLoading: true,
      data: "<undefined>",
    });
    store.setData(["absent"], null);
    store.setData(["empty"], []);
    expect(renderProbe(store, ["absent"], vi.fn())).toMatchObject({
      status: "success",
      data: null,
    });
    expect(renderProbe(store, ["empty"], vi.fn())).toMatchObject({
      status: "success",
      data: [],
    });

    // Same through a real fetch.
    const hash = hashKey(["nothing"]);
    store.observe(
      hash,
      () => async () => null,
      () => {},
    );
    await tick();
    expect(store.getSnapshot(hash)).toMatchObject({
      status: "success",
      data: null,
    });
  });

  it("dedupes equal keys into one request (object member order ignored)", async () => {
    const store = new ApiStore();
    const gate = deferred<string[]>();
    const fetcher = vi.fn(() => gate.promise);
    const a = hashKey(["issues", { status: "open", page: 1 }]);
    const b = hashKey(["issues", { page: 1, status: "open" }]);
    expect(a).toBe(b);
    store.observe(
      a,
      () => fetcher,
      () => {},
    );
    store.observe(
      b,
      () => fetcher,
      () => {},
    );
    void store.fetch(a);
    expect(fetcher).toHaveBeenCalledTimes(1);
    gate.resolve(["one"]);
    await tick();
    expect(store.getSnapshot(a).data).toEqual(["one"]);
  });

  it("reports a normalized error and keeps the last data", async () => {
    const store = new ApiStore();
    const hash = hashKey(["board"]);
    let fail = false;
    store.observe(
      hash,
      () => async () => {
        if (fail)
          throw new ApiError({
            code: "forbidden",
            message: "No access",
            status: 403,
          });
        return ["row"];
      },
      () => {},
    );
    await tick();
    fail = true;
    await store.fetch(hash, { force: true });
    const snapshot = store.getSnapshot(hash);
    expect(snapshot.status).toBe("error");
    expect(snapshot.error?.toJSON()).toEqual({
      code: "forbidden",
      message: "No access",
      retryable: false,
    });
    expect(snapshot.data).toEqual(["row"]);

    // A thrown non-ApiError is normalized too.
    const other = hashKey(["other"]);
    store.observe(
      other,
      () => async () => {
        throw new TypeError("fetch failed");
      },
      () => {},
    );
    await tick();
    expect(store.getSnapshot(other).error?.code).toBe("network_error");
    expect(store.getSnapshot(other).error?.retryable).toBe(true);
  });

  it("rejects a stale response after a newer request for the same key", async () => {
    const store = new ApiStore();
    const hash = hashKey(["detail", 1]);
    const first = deferred<string>();
    const second = deferred<string>();
    const responses = [first, second];
    store.observe(
      hash,
      () => () => responses.shift()!.promise,
      () => {},
    );
    void store.fetch(hash, { force: true }); // supersedes the first request
    second.resolve("new");
    await tick();
    first.resolve("old");
    await tick();
    expect(store.getSnapshot(hash).data).toBe("new");
  });

  it("never shows the previous key's late response under the new key", async () => {
    const store = new ApiStore({ gcMs: 1 });
    const slow = deferred<string>();
    const a = hashKey(["issue", 1]);
    const b = hashKey(["issue", 2]);
    const stopA = store.observe(
      a,
      () => () => slow.promise,
      () => {},
    );
    stopA(); // key changed: the reader moved to B
    const fast = deferred<string>();
    store.observe(
      b,
      () => () => fast.promise,
      () => {},
    );
    slow.resolve("issue one");
    await tick();
    expect(store.getSnapshot(b)).toMatchObject({
      status: "loading",
      data: undefined,
    });
    fast.resolve("issue two");
    await tick();
    expect(store.getSnapshot(b).data).toBe("issue two");
  });

  it("drops in-flight responses from before an identity change", async () => {
    const store = new ApiStore();
    const hash = hashKey(["me"]);
    const before = deferred<string>();
    const after = deferred<string>();
    const queue = [before, after];
    store.observe(
      hash,
      () => () => queue.shift()!.promise,
      () => {},
    );
    void store.clear();
    before.resolve("old account");
    await tick();
    expect(store.getSnapshot(hash).data).toBeUndefined();
    after.resolve("new account");
    await tick();
    expect(store.getSnapshot(hash).data).toBe("new account");
  });

  it("refetches observed keys on invalidate, coalescing a burst into one request", async () => {
    vi.useFakeTimers();
    try {
      const store = new ApiStore({ coalesceMs: 20 });
      const fetcher = vi.fn(async () => "rows");
      const board = hashKey(["issues", "board"]);
      const unrelated = hashKey(["orders"]);
      const other = vi.fn(async () => "orders");
      store.observe(
        board,
        () => fetcher,
        () => {},
      );
      store.observe(
        unrelated,
        () => other,
        () => {},
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(1);

      store.invalidate([["issues"]]);
      store.invalidate([["issues", "board"]]);
      store.invalidate([["issues"]]);
      await vi.advanceTimersByTimeAsync(25);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(other).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops unobserved data on invalidate so the next reader fetches fresh", async () => {
    const store = new ApiStore();
    store.setData(["issues", "list"], ["cached"]);
    store.invalidate([["issues"]], { immediate: true });
    expect(store.keys()).toEqual([]);
  });
});

describe("useApiPages", () => {
  it("renders loading before the first page, then aggregates pages", () => {
    const store = new ApiStore();
    function Probe() {
      const pages = useApiPages<string>(["runs"], async () => ({
        items: [],
        nextCursor: null,
      }));
      return createElement(
        "pre",
        null,
        `${pages.status}|${pages.items?.join(",") ?? "none"}|${pages.isComplete}`,
      );
    }
    const render = () =>
      renderToStaticMarkup(
        createElement(ApiProvider, { store }, createElement(Probe)),
      );
    expect(render()).toBe("<pre>loading|none|false</pre>");
    store.setData(["runs"], {
      pages: [
        { items: ["a", "b"], nextCursor: "c2" },
        { items: ["c"], nextCursor: null },
      ],
      truncated: false,
    });
    expect(render()).toBe("<pre>exhausted|a,b,c|true</pre>");
    store.setData(["runs"], {
      pages: [{ items: ["a"], nextCursor: "c2" }],
      truncated: false,
    });
    expect(render()).toBe("<pre>canLoadMore|a|false</pre>");
  });
});
