import { cookies } from "next/headers";
import { apiFetch, type ApiFetchOptions } from "./fetch";

/** Where the Bun API listens when Next talks to it server-side. */
export function apiOrigin() {
  return process.env.API_ORIGIN || "http://127.0.0.1:4310";
}

/**
 * Server-component/route-handler call to the Bun API. Forwards the incoming
 * `cookie` header (so `sp_session` authenticates the call) — the session is
 * never copied into HTML or props. Throws a normalized ApiError.
 */
export async function serverApi<T = unknown>(
  path: string,
  options: Omit<ApiFetchOptions, "origin"> = {},
): Promise<T> {
  const cookieHeader = (await cookies()).toString();
  return apiFetch<T>(path, {
    ...options,
    origin: apiOrigin(),
    headers: {
      ...options.headers,
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
  });
}
