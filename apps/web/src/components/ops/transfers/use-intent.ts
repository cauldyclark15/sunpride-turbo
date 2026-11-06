"use client";

import { useRef } from "react";

/**
 * One idempotency key per distinct request: a retry of the same request after an uncertain send reuses its key
 * (so it cannot post twice), a changed request gets a new one. The server wants the key inside the body.
 */
export function useIntent() {
  const keys = useRef(new Map<string, string>());
  return {
    withKey<T extends Record<string, unknown>>(
      path: string,
      body: T,
    ): T & { idempotencyKey: string } {
      const fingerprint = JSON.stringify([path, body]);
      let key = keys.current.get(fingerprint);
      if (!key) {
        key = crypto.randomUUID();
        keys.current.set(fingerprint, key);
      }
      return { ...body, idempotencyKey: key };
    },
    done(path: string, body: Record<string, unknown>) {
      keys.current.delete(JSON.stringify([path, body]));
    },
  };
}
