import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { REQUEST_PATH_HEADER, signInHref } from "./routing";
import { proxy } from "../../proxy";

const state = vi.hoisted(() => ({
  authenticated: false,
  path: null as string | null,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () =>
    new Headers(state.path ? { "x-sp-path": state.path } : {}),
}));
vi.mock("next/navigation", () => ({
  redirect: (href: string) => {
    throw new Error(`REDIRECT ${href}`);
  },
}));
vi.mock("@/lib/auth-server", () => ({
  isAuthenticated: async () => state.authenticated,
}));
vi.mock("@/components/auth-gate", () => ({ AuthGate: () => null }));
vi.mock("@/components/operations-shell", () => ({ OperationsShell: () => null }));
vi.mock("@/components/cockpit/fixture-session", () => ({
  FixtureSession: () => null,
}));

beforeEach(() => {
  state.authenticated = false;
  state.path = null;
});

describe("WEB-007 signed-out deep link", () => {
  it("builds a safe sign-in address that returns to the page", () => {
    expect(signInHref("/operations/counts")).toBe(
      "/login?next=%2Foperations%2Fcounts",
    );
    expect(signInHref("/stores?tab=new")).toBe("/login?next=%2Fstores%3Ftab%3Dnew");
    expect(signInHref(null)).toBe("/login");
    expect(signInHref("//evil.example")).toBe("/login");
    expect(signInHref("https://evil.example")).toBe("/login");
  });

  it("the proxy passes the opened address to server layouts", () => {
    const res = proxy(
      new NextRequest("http://localhost/operations/counts?day=2026-11-11"),
    );
    expect(res.headers.get(`x-middleware-request-${REQUEST_PATH_HEADER}`)).toBe(
      "/operations/counts?day=2026-11-11",
    );
  });

  it("the dashboard layout sends a signed-out visit to /login?next=<page>", async () => {
    const { default: DashboardLayout } = await import(
      "../../app/(dashboard)/layout"
    );
    state.path = "/operations/counts";
    await expect(DashboardLayout({ children: null })).rejects.toThrow(
      "REDIRECT /login?next=%2Foperations%2Fcounts",
    );
  });
});
