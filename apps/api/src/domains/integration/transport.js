import { validate } from "../../../../../packages/integration-contracts/sap/v1/index.js";

/** @type {WeakMap<object,Record<string,string|undefined>>} */
const configs = new WeakMap();
/** F-002 one mediation configuration for every channel. @param {any} db @param {Record<string,string|undefined>} env */
export function configureSap(db, env) {
  configs.set(db, env);
}
/** @param {any} db @param {Record<string,string|undefined>} [override] */
export function sapConfig(db, override) {
  const env = override ?? configs.get(db) ?? process.env;
  const origin = env.SAP_ORIGIN ?? "http://127.0.0.1:4435";
  const u = new URL(origin);
  const mode = env.SAP_MODE ?? "mock";
  if (
    (mode !== "mock" && (u.protocol !== "https:" || !env.SAP_TOKEN)) ||
    (mode === "mock" && !["127.0.0.1", "localhost"].includes(u.hostname))
  )
    throw new SapFailure("configuration", false);
  return {
    origin: u.origin,
    token: env.SAP_TOKEN,
    timeout: Number(env.SAP_TIMEOUT_MS ?? 5000),
    mode,
  };
}
export class SapFailure extends Error {
  /** @param {string} category @param {boolean} retryable */
  constructor(category, retryable) {
    super(`SAP ${category}`);
    this.category = category;
    this.retryable = retryable;
  }
}
/** F-001/F-002 errors are allowlisted, never log server bodies, URLs or credentials.
 * @param {any} db @param {string} path @param {{body?:any,schema?:string,env?:Record<string,string|undefined>,allow404?:boolean}} [opts]
 */
export async function sapRequest(db, path, opts = {}) {
  const c = sapConfig(db, opts.env);
  let response;
  try {
    response = await fetch(c.origin + path, {
      method: opts.body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        ...(c.token ? { authorization: `Bearer ${c.token}` } : {}),
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      signal: AbortSignal.timeout(c.timeout),
      redirect: "error",
    });
  } catch {
    throw new SapFailure("transport", true);
  }
  if (response.status === 404 && opts.allow404) return null;
  if (!response.ok) {
    const category =
      response.status === 429
        ? "throttle"
        : response.status === 409
          ? "conflict"
          : response.status === 422
            ? "rejection"
            : response.status >= 500
              ? "transport"
              : response.status === 401 || response.status === 403
                ? "configuration"
                : "contract";
    throw new SapFailure(
      category,
      category === "throttle" || category === "transport",
    );
  }
  try {
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) throw new Error("oversize");
    const body = JSON.parse(text);
    if (opts.schema) validate(opts.schema, body);
    return body;
  } catch {
    throw new SapFailure("contract", false);
  }
}
