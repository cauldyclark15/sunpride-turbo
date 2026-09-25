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
        <div role="alert" className="rounded border border-danger p-3 text-sm">
          <p>
            {this.props.label} could not load. Other panels remain available.
          </p>
          <button
            type="button"
            className="mt-2 rounded border border-border px-3 py-1"
            onClick={() =>
              this.setState((state) => ({
                failed: false,
                retry: state.retry + 1,
              }))
            }
          >
            Retry {this.props.label}
          </button>
        </div>
      );
    return <div key={this.state.retry}>{this.props.children}</div>;
  }
}
