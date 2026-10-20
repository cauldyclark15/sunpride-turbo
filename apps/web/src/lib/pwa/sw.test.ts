import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * Runs `public/sw.js` in a sandbox with an in-memory CacheStorage and a
 * scripted network, then exercises its rules through the real handlers.
 */

const SOURCE = readFileSync(
  fileURLToPath(new URL("../../../public/sw.js", import.meta.url)),
  "utf8",
);
const ORIGIN = "https://sunpride.example";

class MemoryCache {
  entries = new Map<string, Response>();
  async match(request: Request | string, options?: { ignoreSearch?: boolean }) {
    const url = new URL(
      typeof request === "string" ? request : request.url,
      ORIGIN,
    );
    const hit = this.entries.get(url.href);
    if (hit) return hit.clone();
    if (options?.ignoreSearch)
      for (const [key, value] of this.entries)
        if (key.split("?")[0] === url.href.split("?")[0]) return value.clone();
    return undefined;
  }
  async put(request: Request | string, response: Response) {
    const url = new URL(
      typeof request === "string" ? request : request.url,
      ORIGIN,
    );
    this.entries.set(url.href, response);
  }
  async add(url: string) {
    this.entries.set(new URL(url, ORIGIN).href, new Response("asset"));
  }
}

class MemoryCaches {
  stores = new Map<string, MemoryCache>();
  async open(name: string) {
    if (!this.stores.has(name)) this.stores.set(name, new MemoryCache());
    return this.stores.get(name)!;
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async delete(name: string) {
    return this.stores.delete(name);
  }
  async match(request: Request | string) {
    for (const store of this.stores.values()) {
      const hit = await store.match(request);
      if (hit) return hit;
    }
    return undefined;
  }
}

type Sw = {
  classify: (request: Request) => string;
  handle: (request: Request) => Promise<Response> | null;
  STATIC_CACHE: string;
  PAGES_CACHE: string;
  DATA_CACHE: string;
};

let network: (request: Request) => Promise<Response>;
let cacheStorage: MemoryCaches;
let listeners: Record<string, (event: unknown) => void>;
let sw: Sw;

function basic(body: string, init: ResponseInit & { json?: boolean } = {}) {
  const response = new Response(body, {
    status: init.status ?? 200,
    headers: {
      "content-type": init.json === false ? "text/html" : "application/json",
    },
  });
  Object.defineProperty(response, "type", { value: "basic" });
  return response;
}

function request(
  path: string,
  init: RequestInit & { navigate?: boolean } = {},
) {
  const { navigate, ...rest } = init;
  const r = new Request(`${ORIGIN}${path}`, rest);
  if (navigate) Object.defineProperty(r, "mode", { value: "navigate" });
  return r;
}

beforeEach(() => {
  cacheStorage = new MemoryCaches();
  listeners = {};
  network = async () => basic("{}");
  const self = {
    location: new URL(`${ORIGIN}/sw.js?v=build-1`),
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners[type] = fn;
    },
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
  } as Record<string, unknown>;
  runInNewContext(SOURCE, {
    self,
    caches: cacheStorage,
    fetch: (r: Request) => network(r),
    URL,
    Headers,
    Response,
    Promise,
  });
  sw = self.__spSw as Sw;
});

describe("service worker cache rules", () => {
  it("F-611 never caches customer portal HTML, RSC, invoices, deductions or original documents", () => {
    for (const path of [
      "/portal",
      "/portal/login",
      "/api/v1/portal/overview",
      "/api/v1/mt/intake/document?id=x",
    ])
      expect(sw.classify(request(path, { navigate: true }))).toBe("none");
    expect(
      sw.classify(request("/portal?_rsc=1", { headers: { rsc: "1" } })),
    ).toBe("none");
    expect(sw.handle(request("/api/v1/portal/overview"))).toBeNull();
  });
  it("caches only same-origin GET reads it owns", () => {
    expect(sw.classify(request("/api/v1/analytics/today?date=x"))).toBe("data");
    expect(sw.classify(request("/api/v1/orders"))).toBe("data");
    expect(sw.classify(request("/_next/static/chunks/a.js"))).toBe("static");
    expect(sw.classify(request("/offline.html"))).toBe("static");
    expect(sw.classify(request("/today", { navigate: true }))).toBe("page");
    expect(
      sw.classify(request("/sales?_rsc=1", { headers: { rsc: "1" } })),
    ).toBe("page");
  });

  it("never touches writes, auth, the session, media, uploads or other origins", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      expect(
        sw.classify(
          request("/api/v1/analytics/today", {
            method,
            body: method === "DELETE" ? undefined : "{}",
          }),
        ),
      ).toBe("none");
    expect(sw.classify(request("/api/auth/sign-in"))).toBe("none");
    expect(sw.classify(request("/api/auth/session"))).toBe("none");
    expect(sw.classify(request("/api/me"))).toBe("none");
    expect(sw.classify(request("/api/media/abc"))).toBe("none");
    expect(sw.classify(request("/api/v1/imports/upload-url"))).toBe("none");
    expect(sw.classify(request("/ws"))).toBe("none");
    expect(sw.classify(request("/sw.js"))).toBe("none");
    expect(sw.classify(new Request("https://maps.example.com/tile.png"))).toBe(
      "none",
    );
    expect(sw.handle(request("/api/me"))).toBeNull();
    expect(
      sw.handle(request("/api/v1/orders", { method: "POST", body: "{}" })),
    ).toBeNull();
  });

  it("F-402 never caches partner reads, exports, documents or portal pages", () => {
    for (const path of [
      "/api/v1/distributors",
      "/api/v1/distributors/finance?distributorId=a",
      "/api/v1/distributors/secondary?format=csv",
      "/api/v1/distributors/documents/private",
      "/distributor",
      "/distributors",
    ]) {
      const req = request(path, { navigate: true });
      expect(sw.classify(req)).toBe("none");
      expect(sw.handle(req)).toBeNull();
    }
  });

  it("answers data from the network, then from the cache with its time when offline", async () => {
    network = async () => basic('{"sales":1}');
    const live = await sw.handle(request("/api/v1/analytics/today"))!;
    expect(await live.text()).toBe('{"sales":1}');
    expect(live.headers.get("x-sp-from-cache")).toBeNull();

    network = async () => {
      throw new TypeError("Failed to fetch");
    };
    const cached = await sw.handle(request("/api/v1/analytics/today"))!;
    expect(await cached.text()).toBe('{"sales":1}');
    expect(cached.headers.get("x-sp-from-cache")).toBe("1");
    expect(Number(cached.headers.get("x-sp-cached-at"))).toBeGreaterThan(0);
  });

  it("does not keep error answers, and a 401 empties the person's caches", async () => {
    network = async () => basic('{"error":"x"}', { status: 500 });
    await sw.handle(request("/api/v1/analytics/sales"))!;
    expect(
      await (
        await cacheStorage.open(sw.DATA_CACHE)
      ).match(request("/api/v1/analytics/sales")),
    ).toBeUndefined();

    network = async () => basic('{"ok":1}');
    await sw.handle(request("/api/v1/analytics/today"))!;
    await sw.handle(request("/today", { navigate: true }))!;
    expect(await cacheStorage.keys()).toEqual(
      expect.arrayContaining([sw.DATA_CACHE, sw.PAGES_CACHE]),
    );

    network = async () => basic("{}", { status: 401 });
    const refused = await sw.handle(request("/api/v1/analytics/today"))!;
    expect(refused.status).toBe(401);
    expect(await cacheStorage.keys()).not.toContain(sw.DATA_CACHE);
    expect(await cacheStorage.keys()).not.toContain(sw.PAGES_CACHE);
  });

  it("falls back to the last copy of a page, then to the offline page", async () => {
    network = async () => basic("<html>today</html>", { json: false });
    await sw.handle(request("/today", { navigate: true }))!;
    await (await cacheStorage.open(sw.STATIC_CACHE)).add("/offline.html");
    network = async () => {
      throw new TypeError("offline");
    };
    const page = await sw.handle(request("/today", { navigate: true }))!;
    expect(await page.text()).toBe("<html>today</html>");
    const unseen = await sw.handle(request("/money", { navigate: true }))!;
    expect(await unseen.text()).toBe("asset");
  });

  it("sign-out (CLEAR_USER_DATA) deletes data and pages but keeps the app shell", async () => {
    network = async () => basic('{"ok":1}');
    await sw.handle(request("/api/v1/analytics/today"))!;
    await sw.handle(request("/today", { navigate: true }))!;
    await (await cacheStorage.open(sw.STATIC_CACHE)).add("/offline.html");
    const pending: Promise<unknown>[] = [];
    const replies: unknown[] = [];
    listeners.message!({
      data: { type: "CLEAR_USER_DATA" },
      ports: [{ postMessage: (m: unknown) => replies.push(m) }],
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    });
    await Promise.all(pending);
    expect(await cacheStorage.keys()).toEqual([sw.STATIC_CACHE]);
    expect(replies).toEqual([{ type: "CLEARED" }]);
  });

  it("names caches by build and deletes older versions on activate", async () => {
    expect(sw.STATIC_CACHE).toBe("sp-static-build-1");
    await cacheStorage.open("sp-static-build-0");
    await cacheStorage.open("sp-pages-build-0");
    await cacheStorage.open(sw.STATIC_CACHE);
    await cacheStorage.open(sw.DATA_CACHE);
    await cacheStorage.open("someone-else");
    const pending: Promise<unknown>[] = [];
    listeners.activate!({
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    });
    await Promise.all(pending);
    expect((await cacheStorage.keys()).sort()).toEqual(
      [sw.DATA_CACHE, sw.STATIC_CACHE, "someone-else"].sort(),
    );
  });
});
