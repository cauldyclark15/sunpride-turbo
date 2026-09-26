"use client";

import { Component, type ReactNode } from "react";

type Props = { label: string; children: ReactNode };
type State = { failed: boolean; retry: number };

/** Each panel owns its own subscription failure and retry lifecycle. */
export class PanelErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, retry: 0 };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  render() {
    if (this.state.failed)
      return (
        <div
          role="alert"
          aria-label={this.props.label}
          className="rounded-2xl border border-border bg-surface p-4 text-sm"
        >
          <p className="font-medium text-foreground">Something went wrong</p>
          <button
            type="button"
            className="mt-3 h-10 rounded-[10px] border border-border bg-surface px-4 font-medium"
            onClick={() =>
              this.setState((state) => ({
                failed: false,
                retry: state.retry + 1,
              }))
            }
          >
            Try again
          </button>
        </div>
      );
    return <div key={this.state.retry}>{this.props.children}</div>;
  }
}
