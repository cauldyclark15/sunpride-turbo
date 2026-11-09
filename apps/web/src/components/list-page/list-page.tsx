"use client";

/**
 * ListPage — the one way to show a list in the office web (owner rule: lists are
 * search + add + filter + table + bulk actions + pages; no charts or KPI cards).
 *
 * URL state is owned by the caller (use `?q`, `?page`, `?filter`-style params) so
 * reload/back/forward work; ListPage only renders and reports changes.
 *
 *   <ListPage
 *     noun={{ one: "store", many: "stores" }}
 *     rows={data?.rows ?? null} total={data?.total ?? null}
 *     page={readPage(params)} onPage={(n) => set({ page: n > 1 ? String(n) : null })}
 *     q={params.get("q") ?? ""} onSearch={(q) => set({ q: q || null, page: null }, { replace: true })}
 *     searchPlaceholder="Search by store name or code"
 *     onAdd={canAdd ? (name) => openAddSheet(name) : undefined}   // name = the search text on an empty result
 *     columns={[{ key: "name", label: "Store", primary: true, render: (r) => r.name, text: (r) => r.name }, …]}
 *     rowKey={(r) => r.id} rowHref={(r) => `/stores/store?storeId=${r.id}`}
 *     bulkActions={[{ label: "Archive", run: (rows) => … }]}        // "Export selected" is built in
 *   />
 *
 * Phone width: rows become cards and Add floats above the phone tab bar.
 */

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";

export type ListColumn<T> = {
  key: string;
  label: string;
  render: (row: T) => ReactNode;
  /** Plain text for Export selected; columns without it are left out of the file. */
  text?: (row: T) => string;
  /** The row title (bold, first on a phone card). */
  primary?: boolean;
  align?: "left" | "right";
};

export type ListFilter = { id: string; label: string; count?: number | null };

export type BulkAction<T> = {
  label: string;
  run: (rows: T[]) => void | Promise<void>;
};

export const PAGE_SIZE = 50;

/** ?page= as a whole number from 1; anything else is page 1. */
export function readPage(params: URLSearchParams): number {
  const n = Number(params.get("page") ?? "1");
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** Page numbers to show: first, last, and one either side of the current page. */
export function pageNumbers(page: number, pages: number): Array<number | "…"> {
  const out: Array<number | "…"> = [];
  for (let n = 1; n <= pages; n++) {
    if (n === 1 || n === pages || Math.abs(n - page) <= 1) out.push(n);
    else if (out[out.length - 1] !== "…") out.push("…");
  }
  return out;
}

/** CSV text of the chosen rows, using each column's `text`. */
export function toCsv<T>(columns: ListColumn<T>[], rows: T[]): string {
  const cols = columns.filter((c) => c.text);
  const cell = (v: string) =>
    /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  return [
    cols.map((c) => cell(c.label)).join(","),
    ...rows.map((r) => cols.map((c) => cell(c.text!(r))).join(",")),
  ].join("\n");
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function PlusIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M10 4v12M4 10h12" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <circle cx="9" cy="9" r="5.5" />
      <path d="m13.2 13.2 3.3 3.3" />
    </svg>
  );
}

/** Search box that reports after 250ms of no typing (Enter reports at once). */
function SearchBox({
  q,
  placeholder,
  onSearch,
}: {
  q: string;
  placeholder: string;
  onSearch: (q: string) => void;
}) {
  const [text, setText] = useState(q);
  const last = useRef(q);
  useEffect(() => {
    if (q !== last.current) {
      last.current = q;
      setText(q);
    }
  }, [q]);
  useEffect(() => {
    const next = text.trim();
    if (next === last.current) return;
    const id = setTimeout(() => {
      last.current = next;
      onSearch(next);
    }, 250);
    return () => clearTimeout(id);
  }, [text, onSearch]);
  return (
    <form
      role="search"
      className="relative min-w-0 flex-1"
      onSubmit={(event) => {
        event.preventDefault();
        last.current = text.trim();
        onSearch(text.trim());
      }}
    >
      <SearchIcon />
      <input
        type="search"
        aria-label={placeholder}
        data-testid="list-search"
        placeholder={placeholder}
        value={text}
        autoComplete="off"
        onChange={(event) => setText(event.target.value)}
        className="h-12 w-full !rounded-xl !pl-11 !text-[16px]"
      />
    </form>
  );
}

export function ListPage<T>({
  noun,
  rows,
  total,
  page,
  pageSize = PAGE_SIZE,
  onPage,
  q,
  onSearch,
  searchPlaceholder,
  onAdd,
  addLabel,
  filters,
  filter = null,
  onFilter,
  columns,
  rowKey,
  rowHref,
  rowEnd,
  bulkActions = [],
  exportName,
  loading = false,
}: {
  noun: { one: string; many: string };
  rows: T[] | null;
  total: number | null;
  page: number;
  pageSize?: number;
  onPage: (page: number) => void;
  q: string;
  onSearch: (q: string) => void;
  searchPlaceholder: string;
  /** Opens the add form; gets the search text when offered from an empty result. Omit to hide Add. */
  onAdd?: (name: string) => void;
  addLabel?: string;
  filters?: ListFilter[];
  filter?: string | null;
  onFilter?: (id: string | null) => void;
  columns: ListColumn<T>[];
  rowKey: (row: T) => string;
  rowHref?: (row: T) => string;
  /** Always-visible control at the row end (e.g. an Edit button); sits outside the row link. */
  rowEnd?: (row: T) => ReactNode;
  bulkActions?: BulkAction<T>[];
  exportName?: string;
  loading?: boolean;
}) {
  const keys = (rows ?? []).map(rowKey);
  // a new page or search starts with nothing picked
  const pageKey = keys.join("|");
  const [sel, setSel] = useState<{ page: string; keys: Set<string> }>({
    page: pageKey,
    keys: new Set(),
  });
  const picked = sel.page === pageKey ? sel.keys : new Set<string>();
  const setPicked = (next: Set<string> | ((s: Set<string>) => Set<string>)) =>
    setSel({
      page: pageKey,
      keys: typeof next === "function" ? next(picked) : next,
    });
  const chosen = (rows ?? []).filter((r) => picked.has(rowKey(r)));
  const add = addLabel ?? `Add ${noun.one}`;
  const query = q.trim();
  const pages = total ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = total ? Math.min(total, page * pageSize) : 0;
  const allPicked = keys.length > 0 && keys.every((k) => picked.has(k));
  const actions: BulkAction<T>[] = [
    ...(columns.some((c) => c.text)
      ? [
          {
            label: "Export selected",
            run: (list: T[]) =>
              download(`${exportName ?? noun.many}.csv`, toCsv(columns, list)),
          },
        ]
      : []),
    ...bulkActions,
  ];
  const toggle = (key: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const primary = columns.find((c) => c.primary) ?? columns[0]!;
  const rest = columns.filter((c) => c !== primary);
  const grid = `2.5rem minmax(0,2fr) ${rest.map(() => "minmax(0,1fr)").join(" ")}${rowEnd ? " auto" : ""}`;

  return (
    <div className="grid gap-4 pb-20 sm:pb-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchBox q={q} placeholder={searchPlaceholder} onSearch={onSearch} />
        {onAdd ? (
          <button
            type="button"
            data-testid="list-add"
            onClick={() => onAdd("")}
            className="fixed right-[max(1rem,env(safe-area-inset-right))] bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-30 inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-full bg-foreground px-5 text-[15px] font-semibold text-background shadow-[0_4px_14px_rgba(0,0,0,0.18)] hover:opacity-90 sm:static sm:rounded-xl sm:shadow-none"
          >
            <PlusIcon />
            {add}
          </button>
        ) : null}
      </div>

      {filters?.length ? (
        <div
          className="-mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0"
          role="group"
          aria-label="Filter"
        >
          {[{ id: "", label: "All" } as ListFilter, ...filters].map((f) => {
            const on = (filter ?? "") === f.id;
            return (
              <button
                key={f.id || "all"}
                type="button"
                aria-pressed={on}
                onClick={() => onFilter?.(f.id || null)}
                className={`h-9 shrink-0 whitespace-nowrap rounded-full px-3.5 text-[13px] font-medium ${on ? "bg-foreground text-background" : "border border-border text-foreground hover:bg-default-soft"}`}
              >
                {f.label}
                {f.count != null ? (
                  <span className="ml-1.5 tabular-nums opacity-70">
                    {f.count.toLocaleString("en-PH")}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="flex min-h-6 items-center gap-3 text-[13px] text-muted tabular-nums">
        {chosen.length ? (
          <div
            className="flex flex-wrap items-center gap-2"
            data-testid="list-bulk"
          >
            <span className="font-medium text-foreground">
              {chosen.length} selected
            </span>
            {actions.map((a) => (
              <button
                key={a.label}
                type="button"
                onClick={() => a.run(chosen)}
                className="h-8 rounded-lg border border-border px-3 font-medium text-foreground hover:bg-default-soft"
              >
                {a.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPicked(new Set())}
              className="h-8 px-2 hover:text-foreground"
            >
              Clear
            </button>
          </div>
        ) : (
          <p data-testid="list-count" aria-live="polite">
            {loading && rows === null
              ? `Loading ${noun.many}…`
              : total
                ? `Showing ${from}–${to} of ${total.toLocaleString("en-PH")} ${total === 1 ? noun.one : noun.many}`
                : null}
          </p>
        )}
      </div>

      {rows && rows.length === 0 && !loading ? (
        <div
          className="grid justify-items-start gap-3 rounded-xl border border-border px-5 py-8"
          data-testid="list-empty"
        >
          <p className="text-[17px] font-semibold text-foreground">
            {query ? `No ${noun.one} named “${query}”` : `No ${noun.many} yet`}
          </p>
          <div className="flex flex-wrap gap-2">
            {onAdd ? (
              <button
                type="button"
                data-testid="list-add-named"
                onClick={() => onAdd(query)}
                className="inline-flex h-12 items-center gap-2 rounded-xl bg-foreground px-5 text-[15px] font-semibold text-background hover:opacity-90"
              >
                <PlusIcon />
                {query ? `Add “${query}” as a new ${noun.one}` : add}
              </button>
            ) : null}
            {query ? (
              <button
                type="button"
                onClick={() => onSearch("")}
                className="inline-flex h-12 items-center rounded-xl border border-border px-5 text-[15px] font-medium text-foreground hover:bg-default-soft"
              >
                Clear search
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {rows && rows.length ? (
        <div
          className="overflow-hidden rounded-xl border border-border bg-surface"
          data-testid="list-table"
          role="table"
          aria-label={noun.many}
        >
          <div
            role="row"
            className="hidden items-center gap-x-4 border-b border-separator px-4 py-2 text-[12px] font-medium text-muted sm:grid"
            style={{ gridTemplateColumns: grid }}
          >
            <span role="columnheader">
              <input
                type="checkbox"
                aria-label={`Select all ${noun.many} on this page`}
                checked={allPicked}
                onChange={() =>
                  setPicked(allPicked ? new Set() : new Set(keys))
                }
                className="size-4"
              />
            </span>
            {[primary, ...rest].map((c) => (
              <span
                key={c.key}
                role="columnheader"
                className={c.align === "right" ? "text-right" : ""}
              >
                {c.label}
              </span>
            ))}
            {rowEnd ? <span role="columnheader" /> : null}
          </div>
          <ul className="divide-y divide-separator">
            {rows.map((r) => {
              const key = rowKey(r);
              const body = (
                <>
                  <span className="min-w-0 truncate text-[15px] font-medium text-foreground">
                    {primary.render(r)}
                  </span>
                  {rest.map((c) => (
                    <span
                      key={c.key}
                      className={`min-w-0 truncate text-[13px] text-muted ${c.align === "right" ? "sm:text-right" : ""}`}
                    >
                      {c.render(r)}
                    </span>
                  ))}
                </>
              );
              const cls = "grid min-w-0 grid-cols-1 gap-y-0.5 sm:contents";
              return (
                <li
                  key={key}
                  role="row"
                  className={`grid ${rowEnd ? "grid-cols-[1.25rem_minmax(0,1fr)_auto]" : "grid-cols-[1.25rem_minmax(0,1fr)]"} items-center gap-x-3 sm:gap-x-4 px-4 py-3 hover:bg-default-soft sm:[grid-template-columns:var(--cols)]`}
                  style={{ ["--cols" as string]: grid }}
                >
                  <input
                    type="checkbox"
                    aria-label={`Select ${primary.text?.(r) ?? key}`}
                    checked={picked.has(key)}
                    onChange={() => toggle(key)}
                    className="size-4"
                  />
                  {rowHref ? (
                    <Link href={rowHref(r)} className={cls}>
                      {body}
                    </Link>
                  ) : (
                    <span className={cls}>{body}</span>
                  )}
                  {rowEnd ? (
                    <span className="justify-self-end">{rowEnd(r)}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {pages > 1 ? (
        <nav
          aria-label="Pages"
          className="flex flex-wrap items-center justify-center gap-1"
          data-testid="list-pages"
        >
          <PageButton disabled={page <= 1} onClick={() => onPage(page - 1)}>
            Prev
          </PageButton>
          {pageNumbers(page, pages).map((n, i) =>
            n === "…" ? (
              <span key={`gap${i}`} className="px-1 text-muted">
                …
              </span>
            ) : (
              <PageButton
                key={n}
                current={n === page}
                onClick={() => onPage(n)}
              >
                {n}
              </PageButton>
            ),
          )}
          <PageButton disabled={page >= pages} onClick={() => onPage(page + 1)}>
            Next
          </PageButton>
        </nav>
      ) : null}
    </div>
  );
}

function PageButton({
  children,
  onClick,
  disabled,
  current,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  current?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-current={current ? "page" : undefined}
      onClick={onClick}
      className={`h-10 min-w-10 rounded-lg px-3 text-[14px] font-medium tabular-nums disabled:opacity-40 ${current ? "bg-foreground text-background" : "text-foreground hover:bg-default-soft"}`}
    >
      {children}
    </button>
  );
}
