import { ApiError, errorBody } from "./errors.js";

export const MAX_JSON_BYTES = 1024 * 1024;

/**
 * @typedef {import('./context.js').Ctx} Ctx
 * @typedef {(ctx: Ctx) => Promise<any>|any} Handler
 * @typedef {{ raw?: boolean, v2?: boolean }} RouteOptions
 * @typedef {{ method: string, path: string, parts: string[], handler: Handler, options: RouteOptions }} Route
 */

export class Router {
  constructor() {
    /** @type {Route[]} */
    this.routes = [];
  }

  /** @param {string} method @param {string} path @param {Handler} handler @param {RouteOptions} [options] */
  add(method, path, handler, options = {}) {
    const parts = path.split("/").filter(Boolean);
    const clash = this.routes.find(
      (r) => r.method === method && r.path === path,
    );
    if (clash) throw new Error(`Duplicate route ${method} ${path}`);
    this.routes.push({ method, path, parts, handler, options });
    return this;
  }
  /** @param {string} path @param {Handler} handler @param {RouteOptions} [options] */
  get(path, handler, options) {
    return this.add("GET", path, handler, options);
  }
  /** @param {string} path @param {Handler} handler @param {RouteOptions} [options] */
  post(path, handler, options) {
    return this.add("POST", path, handler, options);
  }
  /** @param {string} path @param {Handler} handler @param {RouteOptions} [options] */
  put(path, handler, options) {
    return this.add("PUT", path, handler, options);
  }
  /** @param {string} path @param {Handler} handler @param {RouteOptions} [options] */
  delete(path, handler, options) {
    return this.add("DELETE", path, handler, options);
  }

  /**
   * @param {string} method @param {string} pathname
   * @returns {{ route: Route, params: Record<string,string> } | { methodNotAllowed: true } | null}
   */
  match(method, pathname) {
    const parts = pathname.split("/").filter(Boolean);
    let pathMatched = false;
    for (const route of this.routes) {
      if (route.parts.length !== parts.length) continue;
      /** @type {Record<string,string>} */
      const params = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const want = /** @type {string} */ (route.parts[i]);
        const got = /** @type {string} */ (parts[i]);
        if (want.startsWith(":")) {
          try {
            params[want.slice(1)] = decodeURIComponent(got);
          } catch {
            ok = false;
            break;
          }
        } else if (want !== got) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pathMatched = true;
      if (
        route.method === method ||
        (method === "HEAD" && route.method === "GET")
      )
        return { route, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

/**
 * Read a request body with a hard byte cap (streams; never trusts Content-Length alone).
 * @param {Request} req @param {number} max @returns {Promise<Uint8Array>}
 */
export async function readCapped(req, max) {
  const declared = Number(req.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > max)
    throw new ApiError("payload_too_large", 413, "Request body is too large");
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new ApiError("payload_too_large", 413, "Request body is too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** @param {Uint8Array} raw @returns {unknown} */
export function parseJson(raw) {
  if (raw.byteLength === 0) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new ApiError("invalid_json", 400, "Body is not valid JSON");
  }
}

/** Explicit status/headers for a JSON reply. */
export class Reply {
  /** @param {number} status @param {unknown} body @param {HeadersInit} [headers] */
  constructor(status, body, headers) {
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

/** @param {number} status @param {unknown} body @param {HeadersInit} [headers] */
export const reply = (status, body, headers) =>
  new Reply(status, body, headers);

/** @param {unknown} body @param {number} [status] @param {HeadersInit} [headers] */
export function json(body, status = 200, headers) {
  const h = new Headers(headers);
  h.set("content-type", "application/json; charset=utf-8");
  h.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: h });
}

/** @param {unknown} error @param {boolean} v2 @param {number} now @param {string} [path] */
export function errorResponse(error, v2, now, path) {
  const apiError =
    error instanceof ApiError
      ? error
      : new ApiError("internal", 500, "Something went wrong", true, {
          action: "retry",
        });
  if (!(error instanceof ApiError)) console.error("[api] unhandled", error);
  /** @type {Record<string,string>} */
  const headers = {};
  if (apiError.retryAfterMs)
    headers["retry-after"] = String(Math.ceil(apiError.retryAfterMs / 1000));
  // The unread body would poison a reused keep-alive connection.
  if (apiError.status === 413) headers.connection = "close";
  return json(errorBody(apiError, v2, now, path), apiError.status, headers);
}
