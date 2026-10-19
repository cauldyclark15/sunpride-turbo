"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";

export type DrillColumn<T> = {
  key: string;
  label: string;
  align?: "left" | "right";
  render: (row: T) => ReactNode;
  /** Sort value; omit to make the column unsortable. */
  sort?: (row: T) => number | string | null;
  /** Hidden in the stacked phone layout (the row's title cell already says it). */
  primary?: boolean;
  /** Let long text wrap (cells stay on one line otherwise). */
  wrap?: boolean;
};

export type Crumb = { label: string; href: string; current: boolean };

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  if (items.length <= 1) return null;
  return (
    <nav aria-label="Drill path" className="text-[13px]">
      <ol className="flex flex-wrap items-center gap-1 text-muted">
        {items.map((item, index) => (
          <li key={item.href} className="inline-flex items-center gap-1">
            {index ? <span aria-hidden>›</span> : null}
            {item.current ? (
              <span aria-current="page" className="font-medium text-foreground">
                {item.label}
              </span>
            ) : (
              <Link href={item.href} className="hover:text-foreground">
                {item.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

const toolClass =
  "inline-flex h-8 items-center rounded-lg border border-border bg-surface px-3 text-[13px] font-medium text-foreground hover:bg-default-soft";

/** CSV (the server's `format=csv` of the same filters) and print. */
export function ExportTools({ csvHref }: { csvHref: string }) {
  return (
    <span className="ck-noprint inline-flex gap-2">
      <a href={csvHref} download data-csv className={toolClass}>
        Download CSV
      </a>
      <button
        type="button"
        onClick={() => window.print()}
        className={toolClass}
      >
        Print
      </button>
    </span>
  );
}

function compare(a: number | string | null, b: number | string | null) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

/**
 * Sortable table whose rows drill down. On a phone the rows stack into
 * labelled cards (`ck-table` in cockpit.css). CSV export and print sit in
 * the toolbar; the CSV is the server's `format=csv` of the same filters.
 */
export function DrillTable<T>({
  label,
  columns,
  rows,
  rowKey,
  rowHref,
  csvHref,
  empty,
  initialSort,
  footer,
}: {
  label: string;
  columns: DrillColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  rowHref?: (row: T) => string | null;
  csvHref?: string;
  empty?: ReactNode;
  initialSort?: { key: string; dir: "asc" | "desc" };
  footer?: ReactNode;
}) {
  const router = useRouter();
  const [sort, setSort] = useState(initialSort ?? null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((c) => c.key === sort.key);
    if (!column?.sort) return rows;
    const pick = column.sort;
    const out = [...rows].sort((a, b) => compare(pick(a), pick(b)));
    return sort.dir === "desc" ? out.reverse() : out;
  }, [rows, columns, sort]);

  return (
    <div className="min-w-0">
      {csvHref ? (
        <div className="ck-noprint mb-2 flex justify-end px-4 sm:px-5">
          <ExportTools csvHref={csvHref} />
        </div>
      ) : null}
      {sorted.length === 0 && empty ? (
        <div className="px-4 pb-4 sm:px-5">{empty}</div>
      ) : (
        <div className="ck-scroll overflow-x-auto">
          <table
            className="ck-table w-full border-collapse text-[13px]"
            aria-label={label}
          >
            <thead>
              <tr className="border-y border-separator text-left">
                {columns.map((column) => {
                  const active = sort?.key === column.key;
                  return (
                    <th
                      key={column.key}
                      scope="col"
                      aria-sort={
                        active
                          ? sort?.dir === "asc"
                            ? "ascending"
                            : "descending"
                          : undefined
                      }
                      className={`${column.wrap ? "" : "whitespace-nowrap"} px-3 py-2 align-bottom text-[11px] font-semibold uppercase leading-tight tracking-wider text-muted first:min-w-44 first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5 ${
                        column.align === "right" ? "text-right" : ""
                      }`}
                    >
                      {column.sort ? (
                        <button
                          type="button"
                          className={`inline-flex items-center gap-1 uppercase hover:text-foreground ${column.align === "right" ? "flex-row-reverse text-right" : "text-left"}`}
                          onClick={() =>
                            setSort((prior) => ({
                              key: column.key,
                              dir:
                                prior?.key === column.key &&
                                prior.dir === "desc"
                                  ? "asc"
                                  : "desc",
                            }))
                          }
                        >
                          {column.label}
                          {active ? (
                            <span aria-hidden className="text-[10px]">
                              {sort?.dir === "asc" ? "▲" : "▼"}
                            </span>
                          ) : null}
                        </button>
                      ) : (
                        column.label
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => {
                const href = rowHref?.(row) ?? null;
                return (
                  <tr
                    key={rowKey(row)}
                    data-href={href ?? undefined}
                    onClick={
                      href
                        ? (event) => {
                            if (
                              (event.target as HTMLElement).closest("a,button")
                            )
                              return;
                            router.push(href, { scroll: false });
                          }
                        : undefined
                    }
                    className={`border-b border-separator align-top last:border-b-0 ${
                      href ? "cursor-pointer hover:bg-default-soft/60" : ""
                    }`}
                  >
                    {columns.map((column, index) => (
                      <td
                        key={column.key}
                        data-label={column.label}
                        data-primary={column.primary ? "" : undefined}
                        className={`px-3 py-2.5 tabular-nums first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5 ${
                          column.align === "right" ? "text-right" : ""
                        } ${index === 0 || column.wrap ? "" : "sm:whitespace-nowrap"}`}
                      >
                        {index === 0 && href ? (
                          <Link
                            href={href}
                            scroll={false}
                            className="font-medium text-foreground hover:underline"
                          >
                            {column.render(row)}
                          </Link>
                        ) : (
                          column.render(row)
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {footer}
    </div>
  );
}
