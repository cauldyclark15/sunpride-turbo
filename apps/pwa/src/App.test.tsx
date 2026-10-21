import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("retired field pilot", () => {
  it("directs people to the current office app instead of opening old selling routes", () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain("Use the current Sunpride app");
    expect(html).toContain('href="https://sunpride.cauldnclark.com/today"');
    expect(html).not.toContain("<form");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("/orders/new");
  });
  it("warns people to preserve retained unsent evidence and reconcile before recapture", () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain("do not uninstall it or clear its data");
    expect(html).toContain("recover that work before recording it again");
  });
});
