"use client";

import { Notice } from "@sunpride/ui";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { apiFetch, useApi } from "@/lib/api";
import { usePermissions } from "@/lib/auth";
import {
  ListPage,
  PAGE_SIZE,
  readPage,
  type ListColumn,
} from "../../list-page/list-page";
import { DocNumber } from "../doc-number";
import { Peso } from "../peso";
import { StatusPill } from "../status-pill";
import { AddTransferDrawer } from "./add-transfer";
import { FILTERS, type FilterId, type TransferSummary } from "./transfer-model";

const route = (t: TransferSummary) =>
  `${t.source?.name ?? "?"} → ${t.destination?.name ?? "?"}`;

const COLUMNS: ListColumn<TransferSummary>[] = [
  {
    key: "number",
    label: "Transfer",
    primary: true,
    render: (t) => (
      <span className="inline-flex flex-wrap items-center gap-2">
        <DocNumber value={t.number} />
        <StatusPill state={t.status} />
      </span>
    ),
    text: (t) => t.number,
  },
  { key: "route", label: "From → To", render: route, text: route },
  {
    key: "lines",
    label: "Lines",
    render: (t) => (
      <>
        {t.lineCount} line{t.lineCount === 1 ? "" : "s"}
        {t.varianceStatus === "open" ? (
          <>
            {" · difference "}
            <Peso
              centavos={t.varianceValueCentavos}
              className="font-medium text-danger"
            />
          </>
        ) : null}
      </>
    ),
    text: (t) => String(t.lineCount),
  },
  {
    key: "edit",
    label: "",
    align: "right",
    // the whole row is the link to the transfer; this is its visible Edit
    render: () => (
      <span className="inline-flex h-9 items-center rounded-lg border border-border px-3 text-[13px] font-medium text-foreground">
        Edit
      </span>
    ),
  },
];

/** Search text against number, places, type, driver and plate. */
export function matchTransfer(t: TransferSummary, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [
    t.number,
    t.typeLabel,
    t.source?.name,
    t.source?.code,
    t.destination?.name,
    t.destination?.code,
    t.header.driverName,
    t.header.vehiclePlate,
  ].some((v) => v?.toLowerCase().includes(needle));
}

/** Pure view of the transfers list: search, Add transfer, filter chips, rows, pages. */
export function TransfersListView({
  transfers,
  loading = false,
  filter,
  onFilter,
  q = "",
  onSearch = () => {},
  page = 1,
  onPage = () => {},
  onAdd,
  hrefFor = (id) => `/operations/transfers/${id}`,
}: {
  transfers: TransferSummary[] | null;
  loading?: boolean;
  filter: FilterId | null;
  onFilter: (f: FilterId | null) => void;
  q?: string;
  onSearch?: (q: string) => void;
  page?: number;
  onPage?: (n: number) => void;
  /** Omit when the person may not add transfers. */
  onAdd?: () => void;
  hrefFor?: (id: string) => string;
}) {
  const hits = transfers ? transfers.filter((t) => matchTransfer(t, q)) : null;
  const rows = hits
    ? hits.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
    : null;
  return (
    <ListPage
      noun={{ one: "transfer", many: "transfers" }}
      rows={rows}
      total={hits?.length ?? null}
      page={page}
      onPage={onPage}
      q={q}
      onSearch={onSearch}
      searchPlaceholder="Search by number, place or driver"
      onAdd={onAdd ? () => onAdd() : undefined}
      filters={FILTERS.map((f) => ({ id: f.id, label: f.label }))}
      filter={filter}
      onFilter={(id) => onFilter((id as FilterId | null) ?? null)}
      columns={COLUMNS}
      rowKey={(t) => t.id}
      rowHref={(t) => hrefFor(t.id)}
      loading={loading}
    />
  );
}

const isFilter = (v: string | null): v is FilterId =>
  FILTERS.some((f) => f.id === v);

/** Transfers list with its state in the URL (?filter, ?q, ?page; ?add=1 opens the Add form). */
export function TransfersList({
  hrefFor,
}: {
  /** Older callers pass a click handler; rows are links now. */
  onOpen?: (id: string) => void;
  hrefFor?: (id: string) => string;
}) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { can } = usePermissions();
  const [adding, setAdding] = useState(false);
  const current = new URLSearchParams(params?.toString() ?? "");
  const filterParam = current.get("filter");
  const filter = isFilter(filterParam) ? filterParam : null;
  const q = current.get("q") ?? "";
  const page = readPage(current);
  const open = adding || current.get("add") === "1";
  const set = (patch: Record<string, string | null>, replace = false) => {
    const next = new URLSearchParams(current);
    for (const [k, v] of Object.entries(patch))
      if (v) next.set(k, v);
      else next.delete(k);
    const s = next.toString();
    const href = s ? `${pathname}?${s}` : (pathname ?? "");
    if (replace) router.replace(href);
    else router.push(href);
  };
  const query = FILTERS.find((f) => f.id === filter)?.query ?? {};
  const list = useApi<{ transfers: TransferSummary[] }>(
    ["inventory", "transfers", "list", filter ?? "all"],
    ({ signal }) =>
      apiFetch<{ transfers: TransferSummary[] }>(
        "/api/v1/inventory/transfers/list",
        { query, signal },
      ),
  );
  if (list.error)
    return (
      <Notice
        tone="danger"
        title="Transfers could not load."
        meta="Check your connection and try again."
      />
    );
  return (
    <>
      <TransfersListView
        transfers={list.data?.transfers ?? null}
        loading={!list.data}
        filter={filter}
        onFilter={(f) => set({ filter: f, page: null })}
        q={q}
        onSearch={(text) => set({ q: text || null, page: null }, true)}
        page={page}
        onPage={(n) => set({ page: n > 1 ? String(n) : null })}
        onAdd={can("inventory.write") ? () => setAdding(true) : undefined}
        hrefFor={hrefFor}
      />
      <AddTransferDrawer
        open={open}
        initial={{
          source: current.get("from") ?? "",
          productId: current.get("product") ?? "",
        }}
        onClose={() => {
          setAdding(false);
          if (current.get("add"))
            set({ add: null, from: null, product: null }, true);
        }}
      />
    </>
  );
}
