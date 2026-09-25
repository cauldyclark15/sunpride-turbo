import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PanelErrorBoundary } from "./panel-error-boundary";

describe("isolated Sales Force panel failures", () => {
  it("replaces only the failing panel with an inline alert and Retry remount", () => {
    const left = new PanelErrorBoundary({
      label: "Coverage plan",
      children: createElement("p", null, "Plan content"),
    });
    const right = new PanelErrorBoundary({
      label: "Outlet editor",
      children: createElement("p", null, "Outlet content"),
    });
    left.state = {
      ...left.state,
      ...PanelErrorBoundary.getDerivedStateFromError(),
    };
    const markup = renderToStaticMarkup(
      createElement("main", null, left.render(), right.render()),
    );
    expect(markup).toContain("Coverage plan could not load");
    expect(markup).toContain("Retry Coverage plan");
    expect(markup).toContain("Outlet content");
    expect(markup).not.toContain("Plan content");
    left.setState = (updater) => {
      left.state =
        typeof updater === "function"
          ? { ...left.state, ...updater(left.state, left.props) }
          : { ...left.state, ...updater };
    };
    const alert = left.render() as React.ReactElement<{
      children: React.ReactNode;
    }>;
    const button = (
      alert.props.children as React.ReactElement[]
    )[1] as React.ReactElement<{ onClick: () => void }>;
    button.props.onClick();
    const recovered = renderToStaticMarkup(
      createElement("main", null, left.render(), right.render()),
    );
    expect(recovered).toContain("Plan content");
    expect(recovered).toContain("Outlet content");
    expect(left.state.retry).toBe(1);
  });
});
