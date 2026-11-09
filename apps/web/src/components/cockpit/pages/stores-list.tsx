"use client";

import { ListPage, type ListColumn } from "../../list-page/list-page";
import type { StoreRow, StoreStatus } from "../types";

/** /stores tabs, persisted as ?tab=. The default list carries no tab param. */
export const STORE_TABS = [
  { id: "list", label: "Stores" },
  { id: "new", label: "New stores" },
  { id: "map", label: "Locations" },
  { id: "performance", label: "Performance" },
  { id: "winback", label: "Win-back" },
  { id: "settings", label: "Settings" },
] as const;
export type StoresTab = (typeof STORE_TABS)[number]["id"];

export function readStoresTab(
  params: URLSearchParams,
  hidden: readonly StoresTab[] = [],
): StoresTab {
  const tab = params.get("tab");
  return STORE_TABS.some((t) => t.id === tab) &&
    !hidden.includes(tab as StoresTab)
    ? (tab as StoresTab)
    : "list";
}

export { PAGE_SIZE, pageNumbers, readPage } from "../../list-page/list-page";

const DOT: Record<StoreStatus, { label: string; className: string }> = {
  active: { label: "Buying", className: "bg-[#1f7a43]" },
  new: { label: "New", className: "bg-[#1f7a43]" },
  dormant: { label: "Dormant", className: "bg-[#c27a0a]" },
  lost: { label: "Lost", className: "bg-[#b4101f]" },
  never: { label: "Never bought", className: "bg-[#9aa0a6]" },
};

const STORE_COLUMNS: ListColumn<StoreRow>[] = [
  {
    key: "name",
    label: "Store",
    primary: true,
    render: (r) => r.name,
    text: (r) => r.name,
  },
  {
    key: "code",
    label: "Code",
    render: (r) => <span className="tabular-nums">{r.code}</span>,
    text: (r) => r.code,
  },
  {
    key: "area",
    label: "Area",
    render: (r) => r.territory ?? "",
    text: (r) => r.territory ?? "",
  },
  {
    key: "status",
    label: "Status",
    render: (r) => {
      const dot = DOT[r.status] ?? DOT.never;
      return (
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={`size-2 rounded-full ${dot.className}`}
          />
          {dot.label}
        </span>
      );
    },
    text: (r) => (DOT[r.status] ?? DOT.never).label,
  },
];

/** The default /stores view, built on the shared ListPage. */
export function StoreListView({
  rows,
  total,
  page,
  q,
  loading = false,
  canAdd,
  onSearch,
  onPage,
  onAdd,
  storeHref,
}: {
  rows: StoreRow[] | null;
  total: number | null;
  page: number;
  q: string;
  loading?: boolean;
  canAdd: boolean;
  onSearch: (q: string) => void;
  onPage: (page: number) => void;
  onAdd: (name: string) => void;
  storeHref: (row: StoreRow) => string;
}) {
  return (
    <ListPage
      noun={{ one: "store", many: "stores" }}
      rows={rows}
      total={total}
      page={page}
      onPage={onPage}
      q={q}
      onSearch={onSearch}
      searchPlaceholder="Search by store name or code"
      onAdd={canAdd ? onAdd : undefined}
      columns={STORE_COLUMNS}
      rowKey={(r) => r.storeId}
      rowHref={storeHref}
      loading={loading}
    />
  );
}

/** Tab strip; scrolls sideways on a phone. */
export function StoresTabs({
  tab,
  hrefFor,
  onTab,
  badges = {},
  hidden = [],
}: {
  hidden?: readonly StoresTab[];
  tab: StoresTab;
  hrefFor: (tab: StoresTab) => string;
  onTab: (tab: StoresTab) => void;
  badges?: Partial<Record<StoresTab, number | null>>;
}) {
  return (
    <div
      role="tablist"
      aria-label="Stores sections"
      className="-mx-4 flex gap-1 overflow-x-auto border-b border-separator px-4 sm:mx-0 sm:px-0"
    >
      {STORE_TABS.filter((t) => !hidden.includes(t.id)).map((t) => {
        const on = t.id === tab;
        const badge = badges[t.id];
        return (
          <a
            key={t.id}
            role="tab"
            aria-selected={on}
            href={hrefFor(t.id)}
            onClick={(event) => {
              event.preventDefault();
              onTab(t.id);
            }}
            className={`-mb-px inline-flex h-11 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-[14px] font-medium ${on ? "border-foreground text-foreground" : "border-transparent text-muted hover:text-foreground"}`}
          >
            {t.label}
            {badge ? (
              <span className="rounded-full bg-foreground px-1.5 text-[11px] leading-[18px] text-background tabular-nums">
                {badge}
              </span>
            ) : null}
          </a>
        );
      })}
    </div>
  );
}
