import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// WEB-161: forms say Save and Cancel (docs/ui-actions.md); only the list's create control says
// "Add store".
vi.mock("../../lib/auth", () => ({
  usePermissions: () => ({ can: (p: string) => p === "outlet.manage" }),
}));
vi.mock("../../lib/api", () => ({
  useApi: () => ({ data: undefined }),
  apiFetch: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock("./pin-map", () => ({ PinMap: () => null }));

import { AddStore } from "./add-store";

const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

describe("Add a store form actions", () => {
  it("saves with Save and closes with Cancel", () => {
    const out = buttons(
      renderToStaticMarkup(createElement(AddStore, { onCancel: () => {} })),
    );
    expect(out).toContain("Save");
    expect(out).toContain("Cancel");
    expect(out).not.toContain("Add store");
  });
});
