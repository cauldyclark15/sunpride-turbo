import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const perms = vi.hoisted(() => ({ list: new Set<string>() }));
const queue = vi.hoisted(() => ({
  data: undefined as undefined | { rows: unknown[]; truncated: boolean },
}));
vi.mock("../../lib/auth", () => ({
  usePermissions: () => ({ can: (p: string) => perms.list.has(p) }),
}));
vi.mock("../../lib/api", () => ({
  useApi: (key: unknown) => ({ data: key ? queue.data : undefined }),
  apiFetch: vi.fn(),
  mutate: vi.fn(),
}));

import { StoresHeaderActions } from "./tab";

const render = () =>
  renderToStaticMarkup(
    createElement(StoresHeaderActions, { onAdd: () => {}, onReview: () => {} }),
  );

describe("Stores header actions", () => {
  beforeEach(() => {
    perms.list = new Set();
    queue.data = undefined;
  });

  it("shows a primary Add store button and the review count for office staff", () => {
    perms.list = new Set(["outlet.manage", "outlet.verify"]);
    queue.data = { rows: [{}, {}, {}], truncated: false };
    const out = render();
    expect(out).toContain('data-testid="stores-add-store"');
    expect(out).toContain("Add store");
    expect(out).toContain("3 waiting for review");
    // below lg: floats above the phone tab bar; from lg up it sits in the header
    expect(out).toMatch(
      /stores-add-store"[^>]*class="[^"]*fixed[^"]*lg:static/s,
    );
  });

  it("says when the review list is longer than one page", () => {
    perms.list = new Set(["outlet.verify"]);
    queue.data = { rows: [{}], truncated: true };
    expect(render()).toContain("1+ waiting for review");
  });

  it("says plainly when nothing waits", () => {
    perms.list = new Set(["outlet.verify"]);
    queue.data = { rows: [], truncated: false };
    expect(render()).toContain("None waiting for review");
  });

  it("hides Add store and the count without permission", () => {
    queue.data = { rows: [{}], truncated: false };
    const out = render();
    expect(out).not.toContain("Add store");
    expect(out).not.toContain("waiting for review");
  });
});
