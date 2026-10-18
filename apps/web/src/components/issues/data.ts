"use client";
import { useRef } from "react";
import { apiFetch, mutate, useApi } from "../../lib/api";
import type { ApiFetchOptions } from "../../lib/api";

export function useIssueQuery<T>(
  action: string,
  params: ApiFetchOptions["query"] | null,
) {
  return useApi<T>(
    params === null ? null : ["issues", action, params ?? {}],
    ({ signal }) =>
      apiFetch<T>(`/api/v1/issues/${action}`, {
        query: params ?? undefined,
        signal,
      }),
  );
}
/** Keep the same key after an uncertain transport failure; retire it only on success. */
export function useIssueCommand<T = unknown>(action: string) {
  const pending = useRef(new Map<string, string>());
  return async (body: Record<string, unknown>): Promise<T> => {
    const content = JSON.stringify(body);
    let key = pending.current.get(content);
    if (!key) {
      key = crypto.randomUUID();
      pending.current.set(content, key);
    }
    const result = await mutate<T>(`/api/v1/issues/${action}`, body, {
      idempotencyKey: key,
      invalidate: [["issues"]],
    });
    pending.current.delete(content);
    return result;
  };
}
