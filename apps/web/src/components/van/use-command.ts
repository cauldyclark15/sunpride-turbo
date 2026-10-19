"use client";

import { useRef } from "react";
import { mutate } from "../../lib/api";

/** Keep the request key across uncertain retries, rotate only when the user's facts change. */
export function useVanCommand<Input, Output>(path: string) {
  const pending = useRef<{ payload: string; key: string } | null>(null);
  return (input: Input): Promise<Output> => {
    const payload = JSON.stringify(input);
    if (pending.current?.payload !== payload)
      pending.current = { payload, key: crypto.randomUUID() };
    return mutate<Output>(path, input, {
      invalidate: [["van"]],
      idempotencyKey: pending.current.key,
    });
  };
}
