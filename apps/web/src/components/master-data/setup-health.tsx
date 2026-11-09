"use client";

import { Card } from "@sunpride/ui";
import { useQuery } from "./api";

/** Setup answers: what prevents tomorrow's work, and where can I fix it? */
export function SetupHealth() {
  const health = useQuery("org/setup-health", {});
  return (
    <Card label="Setup health">
      <div className="grid gap-4">
        <p className="text-sm text-muted">
          Clear these gaps before the team starts its routes. The goal is zero
          unresolved items.
        </p>
        {!health ? (
          <p>Loading setup checks…</p>
        ) : (
          <>
            <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
              {health.items.map((item) => (
                <li key={item.key}>
                  <a
                    href={item.href}
                    className="flex h-full flex-col gap-2 rounded-xl border border-border p-4 hover:bg-default/5"
                  >
                    <span className="text-2xl tabular-nums">
                      {item.count ??
                        (item.atLeast === undefined
                          ? "Unknown"
                          : `${item.atLeast}+`)}
                    </span>
                    <span className="text-sm">{item.label}</span>
                    <span className="text-xs text-muted">
                      Target: {item.target} · Review and fix →
                    </span>
                  </a>
                </li>
              ))}
            </ul>
            {health.comparisonNote ? (
              <p className="text-xs text-muted">{health.comparisonNote}</p>
            ) : null}
          </>
        )}
      </div>
    </Card>
  );
}

export function SetupSearch({
  value,
  onChange,
  label = "Search",
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  return (
    <label className="grid gap-1 p-3 text-xs text-muted">
      {label}
      <input
        type="search"
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Name or code"
        className="min-h-10 rounded-[10px] border border-border bg-surface px-3 text-sm text-foreground"
      />
    </label>
  );
}
