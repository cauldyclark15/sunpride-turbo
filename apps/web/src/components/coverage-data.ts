"use client";
import { useRef } from "react";
import { apiFetch, useApi, useLive, useMutate } from "../lib/api";
import type {
  Endpoint,
  FunctionArgs,
  FunctionReturnType,
} from "./coverage-model";

export function useCoverageQuery<T extends Endpoint<unknown, unknown>>(
  ref: T,
  args: FunctionArgs<T> | "skip",
): FunctionReturnType<T> | undefined {
  const skipped = args === "skip";
  const query = useApi<FunctionReturnType<T>>(
    skipped ? null : ["coverage", ref.name, JSON.stringify(args)],
    ({ signal }) =>
      apiFetch(ref.path, { query: { input: JSON.stringify(args) }, signal }),
  );
  useLive(skipped ? null : ["coverage"], [["coverage"]]);
  if (query.error) throw query.error;
  return query.data;
}
export function useCoverageMutation<A, R>(ref: Endpoint<A, R>) {
  const { mutate } = useMutate();
  const pending = useRef(new Map<string, string>());
  return async (body: A): Promise<R> => {
    const serialized = JSON.stringify(body);
    let key = pending.current.get(serialized);
    if (!key) {
      key = crypto.randomUUID();
      pending.current.set(serialized, key);
    }
    const result = await mutate<R>(
      ref.path,
      { ...body, idempotencyKey: key },
      { invalidate: [["coverage"]] },
    );
    pending.current.delete(serialized);
    return result;
  };
}
export function useCoverageClient() {
  return {
    query: <A, R>(ref: Endpoint<A, R>, args: A) =>
      apiFetch<R>(ref.path, { query: { input: JSON.stringify(args) } }),
  };
}
