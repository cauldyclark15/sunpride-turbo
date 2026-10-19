"use client";

import {
  Component,
  lazy,
  Suspense,
  type ComponentType,
  type ReactNode,
} from "react";

/**
 * Workspaces that other v2 lanes deliver under agreed export names. Their
 * folders do not exist on this branch yet, and a static `import()` of a
 * missing module fails the Next build, so the loaders stay commented until
 * the lead merges each lane. Uncomment one line per merged lane.
 */
export type WorkspaceName =
  | "MasterDataWorkspace"
  | "OrdersWorkspace"
  | "PricingWorkspace"
  | "VanTripsWorkspace";

type Loader = () => Promise<Record<string, unknown>>;

export const WORKSPACE_LOADERS: Partial<Record<WorkspaceName, Loader>> = {
  // MOUNT: MasterDataWorkspace: () => import("@/components/master-data"),
  // MOUNT: OrdersWorkspace: () => import("@/components/orders"),
  // MOUNT: PricingWorkspace: () => import("@/components/pricing"),
  // MOUNT: VanTripsWorkspace: () => import("@/components/van"),
};

export const WORKSPACE_TITLES: Record<WorkspaceName, string> = {
  MasterDataWorkspace: "Master data",
  OrdersWorkspace: "Orders",
  PricingWorkspace: "Prices",
  VanTripsWorkspace: "Van trips",
};

type AnyProps = Record<string, unknown>;

export function BeingRebuilt({ title }: { title: string }) {
  return (
    <section
      data-being-rebuilt={title}
      className="rounded-2xl border border-dashed border-border bg-surface px-6 py-8 text-center"
    >
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        Being rebuilt
      </p>
      <p className="mt-1 text-[15px] font-semibold text-foreground">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-[13px] text-muted">
        This page is moving to the new system and comes back in the next update.
      </p>
    </section>
  );
}

class LoadBoundary extends Component<
  { title: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <BeingRebuilt title={this.props.title} />
    ) : (
      this.props.children
    );
  }
}

const cache = new Map<WorkspaceName, ComponentType<AnyProps>>();

/**
 * The named workspace, loaded on demand; "Being rebuilt" when its lane is
 * not merged yet, the module fails to load, or the export is missing.
 */
export function lazyWorkspace(
  name: WorkspaceName,
  loaders: Partial<Record<WorkspaceName, Loader>> = WORKSPACE_LOADERS,
): ComponentType<AnyProps> {
  const cached = loaders === WORKSPACE_LOADERS ? cache.get(name) : undefined;
  if (cached) return cached;
  const title = WORKSPACE_TITLES[name];
  const loader = loaders[name];
  const Missing = () => <BeingRebuilt title={title} />;
  if (!loader) return Missing;
  const Lazy = lazy(async () => {
    try {
      const loaded = await loader();
      const found = loaded[name];
      return {
        default:
          typeof found === "function"
            ? (found as ComponentType<AnyProps>)
            : Missing,
      };
    } catch {
      return { default: Missing };
    }
  });
  const Mounted = (props: AnyProps) => (
    <LoadBoundary title={title}>
      <Suspense
        fallback={
          <p className="text-[13px] text-muted">
            Loading {title.toLowerCase()}…
          </p>
        }
      >
        <Lazy {...props} />
      </Suspense>
    </LoadBoundary>
  );
  if (loaders === WORKSPACE_LOADERS) cache.set(name, Mounted);
  return Mounted;
}
