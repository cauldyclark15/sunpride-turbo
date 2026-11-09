import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/x",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => createElement("a", { href, ...rest }, children),
}));
const st = vi.hoisted(() => ({ role: "admin" }));
vi.mock("../../lib/auth/session", () => ({
  useSession: () => ({ me: {}, profile: { role: st.role } }),
}));
vi.mock("../../lib/api", () => ({
  useApi: (key: unknown[] | null) => ({
    data:
      key && key[1] === "list"
        ? {
            rows: [
              { id: "a1", name: "Cebu agency" },
              { id: "a2", name: "Davao agency" },
            ],
          }
        : undefined,
    error: null,
    refetch: vi.fn(),
  }),
  useLive: vi.fn(),
  mutate: vi.fn(),
  apiFetch: vi.fn(),
}));
vi.mock("../claimant-claims", () => ({ ClaimantClaims: () => null }));

import { AgencyWorkspace, readAgencyTab } from "./workspace";

const html = () => renderToStaticMarkup(createElement(AgencyWorkspace));

describe("Agencies list", () => {
  beforeEach(() => {
    nav.search = "";
    st.role = "admin";
  });
  it("lists agencies with Add agency before the rows, no setup forms", () => {
    const h = html();
    expect(h).toContain(">Agencies<");
    expect(h.indexOf("Add agency")).toBeLessThan(h.indexOf("Cebu agency"));
    expect(h).toContain('href="/x?id=a1"');
    expect(h).not.toContain("Create agency");
  });
  it("search filters agencies", () => {
    nav.search = "q=davao";
    const h = html();
    expect(h).toContain("Davao agency");
    expect(h).not.toContain("Cebu agency");
  });
  it("operations can read but not add", () => {
    st.role = "operations";
    expect(html()).not.toContain("Add agency");
  });
  it("one agency at ?id= with Edit and tabs from ?tab=", () => {
    nav.search = "id=a1&tab=billing";
    const h = html();
    expect(h).toContain("Cebu agency");
    expect(h).toContain(">Edit<");
    expect(h).toMatch(/aria-selected="true"[^>]*>Billing</);
    expect(readAgencyTab(new URLSearchParams("tab=setup"), false)).toBe("work");
    expect(readAgencyTab(new URLSearchParams("tab=setup"), true)).toBe("setup");
  });
});
