import { apiFetch, type ApiFetchOptions } from "./fetch";
import type { ApiKey, ApiKeyInput } from "./key";
import { normalizeKey } from "./key";
import { defaultApiStore, type ApiStore } from "./store";

export type MutateOptions = {
  /**
   * Keys (prefix match) to refetch after the command succeeds. Other
   * viewers are covered by the server's WebSocket invalidation.
   */
  invalidate?: readonly ApiKeyInput[];
  method?: "POST" | "PUT" | "PATCH" | "DELETE";
  /**
   * Stable per user intent (create one when the form opens, reuse it on
   * retry) for commands that must not apply twice after an uncertain send.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
  store?: ApiStore;
  fetchImpl?: ApiFetchOptions["fetchImpl"];
};

/**
 * One-shot command. Resolves with the server result, or throws a normalized
 * ApiError; invalidation happens only after a confirmed success. No
 * optimistic writes, no automatic retry.
 */
export async function mutate<T = unknown>(
  path: string,
  body?: unknown,
  options: MutateOptions = {},
): Promise<T> {
  const result = await apiFetch<T>(path, {
    method: options.method ?? "POST",
    body: body ?? {},
    idempotencyKey: options.idempotencyKey,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  });
  const keys = (options.invalidate ?? [])
    .map(normalizeKey)
    .filter((key): key is ApiKey => key !== null);
  if (keys.length)
    (options.store ?? defaultApiStore).invalidate(keys, { immediate: true });
  return result;
}
