import {
  Children,
  isValidElement,
  type ButtonHTMLAttributes,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PhoneCode } from "./phone-code";

const state = vi.hoisted(() => ({ status: "idle" }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: () => [state.status, (next: string) => (state.status = next)],
}));

function copyButton(
  node: ReactNode,
): ReactElement<ButtonHTMLAttributes<HTMLButtonElement>> | undefined {
  if (!isValidElement<{ children?: ReactNode }>(node)) return;
  if (node.type === "button")
    return node as ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
  for (const child of Children.toArray(node.props.children)) {
    const button = copyButton(child);
    if (button) return button;
  }
}

beforeEach(() => {
  state.status = "idle";
});
afterEach(() => vi.unstubAllGlobals());

it("truncates only the presentation and copies the entire long phone code", async () => {
  const value = "SAMPLE-PHONE-" + "0123456789abcdef".repeat(12);
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const view = PhoneCode({ value });
  const html = renderToStaticMarkup(view);
  expect(html).toContain(`title="${value}"`);
  expect(html).toContain("min-w-0 flex-1 truncate font-mono text-sm");
  const button = copyButton(view);
  expect(button?.props["aria-label"]).toBe(`Copy phone code ${value}`);
  await button?.props.onClick?.({} as MouseEvent<HTMLButtonElement>);
  expect(writeText).toHaveBeenCalledExactlyOnceWith(value);
  expect(renderToStaticMarkup(PhoneCode({ value }))).toContain(
    "Phone code copied.",
  );
});

it("reports a failed copy without claiming success or changing the code", async () => {
  const value = "AB12 CD34 EF56 7890";
  vi.stubGlobal("navigator", {
    clipboard: { writeText: vi.fn().mockRejectedValue(new Error("Denied")) },
  });
  vi.stubGlobal("document", undefined);
  await copyButton(PhoneCode({ value }))?.props.onClick?.(
    {} as MouseEvent<HTMLButtonElement>,
  );
  const html = renderToStaticMarkup(PhoneCode({ value }));
  expect(html).toContain("Could not copy. Select the phone code to copy it.");
  expect(html).not.toContain("Phone code copied.");
  expect(html).toContain(`title="${value}"`);
});
