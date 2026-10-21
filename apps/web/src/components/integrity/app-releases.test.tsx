import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { it, expect, vi } from "vitest";
import { AppReleases } from "./app-releases";
const state = vi.hoisted(() => ({
  role: "super_admin",
  keys: [] as unknown[],
}));
vi.mock("../../lib/auth", () => ({
  usePermissions: () => ({ role: state.role }),
}));
vi.mock("../../lib/api", () => ({
  useApi: (key: unknown) => {
    state.keys.push(key);
    return { data: { staged: [], releases: [], truncated: false } };
  },
  mutate: vi.fn(),
}));
it("F-006 update publication stays super-admin-only and requires a real staged APK", () => {
  state.role = "super_admin";
  state.keys = [];
  const html = renderToStaticMarkup(createElement(AppReleases));
  expect(html).toContain("No signed APK is staged");
  expect(html).not.toContain("Publish inspected update");
  expect(html).toContain("No silent update");
  state.role = "admin";
  state.keys = [];
  expect(renderToStaticMarkup(createElement(AppReleases))).toBe("");
  expect(state.keys).toEqual([null]);
});
