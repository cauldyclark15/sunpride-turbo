import { ApiError, errorFromResponse, normalizeError } from "./errors";

export type QueryValue = string | number | boolean | null | undefined;

export type ApiFetchOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** JSON-serialized. Omitted for GET. */
  body?: unknown;
  /** Appended as a query string; null/undefined values are dropped. */
  query?: Record<string, QueryValue | readonly QueryValue[]>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Sent as `Idempotency-Key` for commands that must not run twice. */
  idempotencyKey?: string;
  /** Absolute origin for server-side calls; browser calls stay same-origin. */
  origin?: string;
  /** Bounds the response before JSON parsing (default 8 MB). */
  maxBytes?: number;
  /** Injected transport (tests). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
};

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** Paths the web app may call: the documented API prefixes only. */
const ALLOWED_PREFIXES = ["/api/v1/", "/api/auth/", "/api/me", "/api/media/"];

export function buildApiUrl(
  path: string,
  query?: ApiFetchOptions["query"],
  origin = "",
) {
  if (!ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix)))
    throw new ApiError({
      code: "invalid_path",
      message: `Not an API path: ${path}`,
    });
  const params = new URLSearchParams();
  for (const [name, raw] of Object.entries(query ?? {})) {
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values)
      if (value !== null && value !== undefined)
        params.append(name, String(value));
  }
  const search = params.toString();
  return `${origin}${path}${search ? `${path.includes("?") ? "&" : "?"}${search}` : ""}`;
}

/**
 * Same-origin JSON call to the Bun API. The `sp_session` cookie rides along
 * (credentials: same-origin); failures throw a normalized {@link ApiError}.
 * Resolves `null` for an empty (204) body.
 */
export async function apiFetch<T = unknown>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<T> {
  const method =
    options.method ?? (options.body === undefined ? "GET" : "POST");
  const headers: Record<string, string> = {
    accept: "application/json",
    ...options.headers,
  };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.idempotencyKey)
    headers["idempotency-key"] = options.idempotencyKey;
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  let response: Response;
  try {
    response = await doFetch(buildApiUrl(path, options.query, options.origin), {
      method,
      headers,
      body:
        options.body === undefined || method === "GET"
          ? undefined
          : JSON.stringify(options.body),
      credentials: "same-origin",
      cache: "no-store",
      signal: options.signal,
    });
  } catch (error) {
    throw normalizeError(error);
  }

  const body = await readJson(response, options.maxBytes ?? DEFAULT_MAX_BYTES);
  if (!response.ok) throw errorFromResponse(response.status, body);
  return (body === undefined ? null : body) as T;
}

async function readJson(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes)
    throw tooLarge(response.status);
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw normalizeError(error);
  }
  if (text.length > maxBytes) throw tooLarge(response.status);
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (!response.ok) return undefined;
    throw new ApiError({
      code: "invalid_response",
      message: "The server sent a response the app could not read.",
      status: response.status,
    });
  }
}

function tooLarge(status: number) {
  return new ApiError({
    code: "response_too_large",
    message: "The server response was too large.",
    status,
  });
}
