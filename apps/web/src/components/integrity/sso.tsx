"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";

/** F-007: trial passwords stay available; federated sign-in uses a full OIDC browser redirect. */
export function SsoButtons() {
  const [providers, setProviders] = useState<
    Array<{ code: string; label: string }>
  >([]);
  useEffect(() => {
    const controller = new AbortController();
    void apiFetch<{ providers: Array<{ code: string; label: string }> }>(
      "/api/auth/oidc/providers",
      { signal: controller.signal },
    )
      .then((data) => {
        if (!controller.signal.aborted) setProviders(data.providers);
      })
      .catch(() => {
        /* Email/password remains available when federation is not configured. */
      });
    return () => controller.abort();
  }, []);
  if (!providers.length) return null;
  return (
    <div
      className="mt-5 grid gap-2 border-t border-border pt-5"
      aria-label="Company sign-in"
    >
      {providers.map((p) => (
        <a
          key={p.code}
          className="rounded-lg border border-border px-3 py-2 text-center text-sm font-medium"
          href={`/api/auth/oidc/start?provider=${encodeURIComponent(p.code)}`}
        >
          Continue with {p.label}
        </a>
      ))}
      <p className="text-xs text-muted">
        Trial accounts can still use email and password.
      </p>
    </div>
  );
}
