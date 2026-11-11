"use client";

import { useRef, useState } from "react";
import { splitCsv } from "@/lib/csv";
import {
  importTargets,
  setTarget,
  useTargets,
  type ImportTargetsResult,
} from "../api";
import { formatDayTime, formatPhp } from "../format";
import { EmptyState, PanelError, Panel } from "../kit";
import { manilaToday } from "../period";
import type { TargetLevel, TargetsResponse } from "../types";
import {
  buttonClass,
  primaryButtonClass,
  Segmented,
  usePageQuery,
} from "./shared";

const LEVELS: Array<{ id: TargetLevel; label: string }> = [
  { id: "company", label: "Company" },
  { id: "channel", label: "Channel" },
  { id: "territory", label: "Territory" },
  { id: "agent", label: "Agent" },
];

export const TARGET_CSV_HEADER = ["level", "key", "amount_php"] as const;

export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const index = y * 12 + (m - 1) + by;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

export function monthLabel(month: string) {
  return new Intl.DateTimeFormat("en-PH", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(Date.parse(`${month}-01T00:00:00Z`));
}

/** Pesos typed by a person → integer centavos; null when it is not a valid amount. */
export function parsePesos(text: string): number | null {
  const clean = text.replace(/[₱,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
}

export type ParsedTargets = {
  rows: Array<{ level: TargetLevel; key: string; amountCentavos: number }>;
  errors: Array<{ row: number; message: string }>;
};

/** `level,key,amount_php` CSV → import rows. Every row is checked again by the server. */
export function parseTargetsCsv(text: string): ParsedTargets {
  const lines = splitCsv(text).filter((cells) => cells.some((c) => c.trim()));
  const errors: ParsedTargets["errors"] = [];
  const rows: ParsedTargets["rows"] = [];
  const header = (lines[0] ?? []).map((c) => c.trim().toLowerCase());
  if (header.join(",") !== TARGET_CSV_HEADER.join(",")) {
    errors.push({
      row: 1,
      message: `The first line must be: ${TARGET_CSV_HEADER.join(",")}`,
    });
    return { rows, errors };
  }
  lines.slice(1).forEach((cells, index) => {
    const row = index + 2;
    const level = (cells[0] ?? "").trim().toLowerCase();
    const key = (cells[1] ?? "").trim();
    const amount = parsePesos(cells[2] ?? "");
    if (!LEVELS.some((l) => l.id === level))
      errors.push({
        row,
        message: `Level must be company, channel, territory or agent.`,
      });
    else if (!key) errors.push({ row, message: "Key is empty." });
    else if (amount === null)
      errors.push({
        row,
        message: "Amount must be pesos, for example 1250000 or 1,250,000.50.",
      });
    else
      rows.push({ level: level as TargetLevel, key, amountCentavos: amount });
  });
  if (!rows.length && !errors.length)
    errors.push({ row: 2, message: "No target rows found." });
  return { rows, errors };
}

function newKey() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function TargetCell({
  month,
  level,
  row,
  canEdit,
  highlight,
}: {
  month: string;
  level: TargetLevel;
  row: TargetsResponse["rows"][number] | undefined;
  canEdit: boolean;
  highlight: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const intent = useRef<string | null>(null);
  if (!row) return <span className="text-muted">—</span>;
  const start = () => {
    intent.current = newKey();
    setText(
      row.amountCentavos === null ? "" : String(row.amountCentavos / 100),
    );
    setError(null);
    setEditing(true);
  };
  const save = async () => {
    const amount = parsePesos(text);
    if (amount === null) {
      setError("Type pesos, for example 1250000.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await setTarget(
        { month, level, key: row.key, amountCentavos: amount },
        intent.current ?? newKey(),
      );
      setEditing(false);
    } catch (raw) {
      setError(
        raw instanceof Error ? raw.message : "The target was not saved.",
      );
    } finally {
      setPending(false);
    }
  };
  if (editing)
    return (
      <span className="flex flex-col items-end gap-1">
        <span className="flex items-center gap-1">
          <span className="text-muted">₱</span>
          <input
            autoFocus
            inputMode="decimal"
            aria-label={`Target for ${row.label}, ${monthLabel(month)}`}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void save();
              if (event.key === "Escape") setEditing(false);
            }}
            className="!min-h-11 h-11 w-32 !rounded-lg !px-2 text-right !text-[16px] tabular-nums lg:!min-h-8 lg:h-8 lg:!text-[13px]"
          />
        </span>
        <span className="flex gap-1">
          <button
            type="button"
            className={buttonClass}
            onClick={() => setEditing(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className={primaryButtonClass}
            disabled={pending}
            onClick={() => void save()}
          >
            {pending ? "Saving…" : "Save"}
          </button>
        </span>
        {error ? (
          <span role="alert" className="text-[12px] text-[#b4101f]">
            {error}
          </span>
        ) : null}
      </span>
    );
  const value =
    row.amountCentavos === null ? (
      <span className={canEdit ? "font-medium text-[#a15c07]" : "text-muted"}>
        {canEdit ? "Set target" : "Not set"}
      </span>
    ) : (
      formatPhp(row.amountCentavos)
    );
  return canEdit ? (
    <button
      type="button"
      onClick={start}
      title={
        row.setBy
          ? `Set by ${row.setBy}, ${formatDayTime(row.setAt)}`
          : "Not set yet"
      }
      className={`rounded-md border-b border-dashed border-foreground/30 px-1.5 py-0.5 text-right tabular-nums hover:border-foreground hover:bg-default-soft ${highlight ? "ring-2 ring-[#d97706]" : ""}`}
    >
      {value}
    </button>
  ) : (
    <span title={row.setBy ? `Set by ${row.setBy}` : undefined}>{value}</span>
  );
}

function ImportPanel({ month, canEdit }: { month: string; canEdit: boolean }) {
  const [parsed, setParsed] = useState<ParsedTargets | null>(null);
  const [result, setResult] = useState<ImportTargetsResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const intent = useRef<string>(newKey());
  if (!canEdit) return null;
  const template = `data:text/csv;charset=utf-8,${encodeURIComponent(
    "\uFEFFlevel,key,amount_php\nchannel,gt,6200000\nagent,p02,1700000\n",
  )}`;
  return (
    <Panel
      title="Import targets"
      question={`One file for ${monthLabel(month)}. All rows are saved, or none are.`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <label className={`${buttonClass} cursor-pointer`}>
          Choose CSV file
          <input
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              setResult(null);
              setFailure(null);
              intent.current = newKey();
              setParsed(file ? parseTargetsCsv(await file.text()) : null);
            }}
          />
        </label>
        <a
          href={template}
          download={`targets-${month}.csv`}
          className="text-[13px] font-medium text-muted underline underline-offset-2 hover:text-foreground"
        >
          Download template
        </a>
      </div>
      {parsed ? (
        <div className="mt-3 grid gap-2 text-[13px]">
          <p className="text-foreground">
            {parsed.rows.length} {parsed.rows.length === 1 ? "row" : "rows"}{" "}
            ready
            {parsed.errors.length
              ? `, ${parsed.errors.length} to fix first`
              : ""}
            .
          </p>
          {parsed.errors.length ? (
            <ul className="grid gap-1 text-[#b4101f]">
              {parsed.errors.slice(0, 8).map((e) => (
                <li key={`${e.row}${e.message}`}>
                  Line {e.row}: {e.message}
                </li>
              ))}
            </ul>
          ) : (
            <button
              type="button"
              className={`${primaryButtonClass} justify-self-start`}
              disabled={pending}
              onClick={async () => {
                setPending(true);
                setFailure(null);
                try {
                  setResult(
                    await importTargets(
                      { month, rows: parsed.rows },
                      intent.current,
                    ),
                  );
                } catch (raw) {
                  setFailure(
                    raw instanceof Error
                      ? raw.message
                      : "The import did not go through.",
                  );
                } finally {
                  setPending(false);
                }
              }}
            >
              {pending ? "Importing…" : `Import ${parsed.rows.length} targets`}
            </button>
          )}
          {failure ? (
            <PanelError label="the target import" message={failure} />
          ) : null}
          {result ? (
            result.errors?.length ? (
              <ul className="grid gap-1 text-[#b4101f]">
                {result.errors.map((e) => (
                  <li key={`${e.row}${e.message}`}>
                    Line {e.row}: {e.message}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[#1f7a43]">
                Imported {result.imported ?? parsed.rows.length} targets.
              </p>
            )
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}

/** Whether the grid's cells are editable: the caller can set targets and the server says this
 * level is writable for their scope (a regional manager cannot set company/channel targets). */
export function levelEditable(
  canEdit: boolean,
  data: Pick<TargetsResponse, "editable"> | undefined,
) {
  return canEdit && data?.editable !== false;
}

/** Month × level target grid with inline edit and CSV import (ANALYTICS_V2 §1 targets). */
export function TargetsEditor({ canEdit }: { canEdit: boolean }) {
  const { params, set } = usePageQuery();
  const level = (
    LEVELS.some((l) => l.id === params.get("level"))
      ? params.get("level")
      : "channel"
  ) as TargetLevel;
  const month = /^\d{4}-\d{2}$/.test(params.get("month") ?? "")
    ? params.get("month")!
    : manilaToday().slice(0, 7);
  const highlight = params.get("key");
  const months = [shiftMonth(month, -1), month, shiftMonth(month, 1)];
  const prev = useTargets(months[0]!, level);
  const current = useTargets(months[1]!, level);
  const next = useTargets(months[2]!, level);
  const results = [prev, current, next];
  const keys = current.data?.rows ?? prev.data?.rows ?? [];
  const editable = levelEditable(canEdit, current.data);
  return (
    <div className="grid gap-4">
      <Panel
        title="Sales targets"
        question={
          editable
            ? "Click an amount to change it. Every change is dated and kept in the history."
            : canEdit
              ? "Company and channel targets are set by a company-wide manager. Choose Territory or Agent to set your team's targets."
              : "Targets are set by managers and administrators."
        }
        flush
        actions={
          <>
            <Segmented
              label="Level"
              value={level}
              options={LEVELS}
              onChange={(id) => set({ level: id, key: null })}
            />
            <span className="inline-flex items-center gap-1">
              <button
                type="button"
                aria-label="Earlier months"
                className={buttonClass}
                onClick={() => set({ month: shiftMonth(month, -1) })}
              >
                ‹
              </button>
              <button
                type="button"
                aria-label="Later months"
                className={buttonClass}
                onClick={() => set({ month: shiftMonth(month, 1) })}
              >
                ›
              </button>
            </span>
          </>
        }
      >
        {current.error && !current.data ? (
          <div className="px-4 pb-4 sm:px-5">
            <PanelError
              label="targets"
              message={current.error.message}
              onRetry={() => void current.refetch()}
            />
          </div>
        ) : !current.data ? (
          <p className="px-5 pb-4 text-[13px] text-muted">Loading targets…</p>
        ) : !keys.length ? (
          <div className="px-4 pb-4 sm:px-5">
            <EmptyState
              variant="setup"
              title={`No ${level}s to set targets for`}
            >
              Add them in Setup first.
            </EmptyState>
          </div>
        ) : (
          <div className="ck-scroll overflow-x-auto">
            <table
              className="ck-table w-full border-collapse text-[13px]"
              aria-label="Targets by month"
            >
              <thead>
                <tr className="border-y border-separator text-left">
                  <th
                    scope="col"
                    className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted sm:px-5"
                  >
                    {LEVELS.find((l) => l.id === level)?.label}
                  </th>
                  {months.map((m) => (
                    <th
                      key={m}
                      scope="col"
                      className={`px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider last:pr-4 sm:last:pr-5 ${m === month ? "text-foreground" : "text-muted"}`}
                    >
                      {monthLabel(m)}
                      {m === month ? (
                        <span className="block text-[10px] font-medium normal-case tracking-normal text-muted">
                          Import goes here
                        </span>
                      ) : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {keys.map((row) => (
                  <tr
                    key={row.key}
                    data-target-row={row.key}
                    className="border-b border-separator"
                  >
                    <td className="px-4 py-2 font-medium text-foreground sm:px-5">
                      {row.label}
                    </td>
                    {months.map((m, i) => (
                      <td
                        key={m}
                        data-label={monthLabel(m)}
                        className="px-3 py-1.5 text-right tabular-nums last:pr-4 sm:last:pr-5"
                      >
                        {results[i]!.data ? (
                          <TargetCell
                            month={m}
                            level={level}
                            row={results[i]!.data!.rows.find(
                              (r) => r.key === row.key,
                            )}
                            canEdit={editable}
                            highlight={m === month && highlight === row.key}
                          />
                        ) : (
                          <span className="text-muted">…</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
                <tr className="bg-surface-secondary/50">
                  <td className="px-4 py-2 text-[12px] font-semibold uppercase tracking-wider text-muted sm:px-5">
                    Total
                  </td>
                  {results.map((r, i) => (
                    <td
                      key={months[i]}
                      data-label={monthLabel(months[i]!)}
                      className="px-3 py-2 text-right font-semibold tabular-nums text-foreground last:pr-4 sm:last:pr-5"
                    >
                      {r.data ? formatPhp(r.data.total) : "—"}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <ImportPanel month={month} canEdit={canEdit} />
    </div>
  );
}
