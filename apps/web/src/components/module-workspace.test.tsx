import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  profile: null as null | { active: boolean; role: string; name: string },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/workflows",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("convex/react", () => ({
  useQuery: () => undefined,
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
  usePaginatedQuery: () => ({
    results: [],
    status: "LoadingFirstPage",
    loadMore: vi.fn(),
  }),
  useConvex: () => ({}),
}));
vi.mock("../lib/auth/session", () => ({
  useSession: () => ({ profile: state.profile }),
}));

import {
  WORKSPACE_LOADERS,
  WORKSPACE_TITLES,
  lazyWorkspace,
} from "./cockpit/lazy-workspace";
import { AccessDenied, ModuleWorkspace } from "./module-workspace";

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("ModuleWorkspace", () => {
  it("old Home and Reports point at Today and Sales & targets", () => {
    expect(html(<ModuleWorkspace module="dashboard" />)).toContain(
      'href="/today"',
    );
    expect(html(<ModuleWorkspace module="analytics" />)).toContain(
      'href="/sales"',
    );
  });

  it("waits for the profile before mounting a workspace", () => {
    state.profile = null;
    expect(html(<ModuleWorkspace module="workflows" />)).toContain(
      "Checking access",
    );
  });

  it("refuses a role the access map does not allow, and inactive profiles", () => {
    state.profile = { active: true, role: "sales", name: "Liza" };
    expect(html(<ModuleWorkspace module="admin" />)).toContain("Access denied");
    state.profile = { active: false, role: "super_admin", name: "Francis" };
    expect(html(<ModuleWorkspace module="admin" />)).toContain("Access denied");
    expect(html(<AccessDenied />)).toContain("Ask an administrator");
  });

  it("mounts the other lanes' rebuilt workspaces by name, or says they are being rebuilt", () => {
    state.profile = { active: true, role: "super_admin", name: "Francis" };
    const out = html(<ModuleWorkspace module="pricing" />);
    expect(out).toContain("Being rebuilt");
    expect(out).toContain("Prices");
    expect(out).not.toContain("Something went wrong");
  });
});

describe("lazyWorkspace", () => {
  it("names the four mounts the lead uncomments once the lanes merge", () => {
    expect(Object.keys(WORKSPACE_TITLES).sort()).toEqual([
      "MasterDataWorkspace",
      "OrdersWorkspace",
      "PricingWorkspace",
      "VanTripsWorkspace",
    ]);
  });

  it("renders Being rebuilt when the module is not in the tree", () => {
    for (const name of Object.keys(WORKSPACE_TITLES) as Array<
      keyof typeof WORKSPACE_TITLES
    >) {
      if (WORKSPACE_LOADERS[name]) continue;
      const Missing = lazyWorkspace(name);
      const out = html(<Missing />);
      expect(out).toContain("Being rebuilt");
      expect(out).toContain(WORKSPACE_TITLES[name]);
    }
  });

  it("falls back to Being rebuilt when the export is missing or the import fails", async () => {
    const NoExport = lazyWorkspace("PricingWorkspace", {
      PricingWorkspace: async () => ({}),
    });
    const Failing = lazyWorkspace("OrdersWorkspace", {
      OrdersWorkspace: async () => {
        throw new Error("Cannot find module");
      },
    });
    const { renderToReadableStream } = await import("react-dom/server");
    for (const [Component, title] of [
      [NoExport, WORKSPACE_TITLES.PricingWorkspace],
      [Failing, WORKSPACE_TITLES.OrdersWorkspace],
    ] as const) {
      const stream = await renderToReadableStream(<Component />);
      await stream.allReady;
      const out = await new Response(stream).text();
      expect(out).toContain("Being rebuilt");
      expect(out).toContain(title);
    }
  });
});
