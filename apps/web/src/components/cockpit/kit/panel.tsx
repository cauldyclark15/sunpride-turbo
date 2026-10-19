"use client";

import { Component, type ReactNode } from "react";
import { ExportTools } from "./drill-table";

type BoundaryProps = { label: string; children: ReactNode };
type BoundaryState = { error: Error | null; retry: number };

/**
 * Error boundary for one cockpit panel. A failing panel shows what failed and
 * a retry; the rest of the page keeps working.
 */
export class PanelBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, retry: 0 };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  retry = () => {
    this.setState((state) => ({ error: null, retry: state.retry + 1 }));
  };

  render() {
    if (this.state.error)
      return (
        <PanelError
          label={this.props.label}
          message="This part of the page could not be drawn from the figures we received."
          onRetry={this.retry}
        />
      );
    return <div key={this.state.retry}>{this.props.children}</div>;
  }
}

/** Says what failed, never a generic "Something went wrong". */
export function PanelError({
  label,
  message,
  onRetry,
}: {
  label: string;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-border px-4 py-3"
    >
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">
          Couldn&apos;t load {label.toLowerCase()}.
        </p>
        {message ? (
          <p className="mt-0.5 text-[13px] text-muted">{message}</p>
        ) : null}
      </div>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="ck-noprint h-8 shrink-0 rounded-lg border border-border bg-surface px-3 text-[13px] font-medium text-foreground hover:bg-default-soft"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

/** A titled block of a cockpit page, isolated by its own error boundary. */
export function Panel({
  title,
  question,
  actions,
  csvHref,
  children,
  className = "",
  flush = false,
}: {
  title: string;
  question?: string;
  actions?: ReactNode;
  /** Adds Download CSV and Print to the header. */
  csvHref?: string;
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <section
      aria-label={title}
      className={`ck-panel min-w-0 rounded-2xl border border-border bg-surface ${className}`}
    >
      <header className="min-w-0 flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 pt-4 sm:px-5">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
            {title}
          </h2>
          {question ? (
            <p className="mt-0.5 text-pretty text-[13px] text-muted">
              {question}
            </p>
          ) : null}
        </div>
        {actions || csvHref ? (
          <div className="ck-noprint flex flex-wrap items-center gap-2">
            {actions}
            {csvHref ? <ExportTools csvHref={csvHref} /> : null}
          </div>
        ) : null}
      </header>
      <div className={flush ? "mt-3 pb-1" : "px-4 pb-4 pt-3 sm:px-5"}>
        <PanelBoundary label={title}>{children}</PanelBoundary>
      </div>
    </section>
  );
}
