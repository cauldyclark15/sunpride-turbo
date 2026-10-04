"use client";

import { Button } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import {
  Card,
  FormField,
  Pager,
  UnderlineTabs,
  WorkspaceIcon,
} from "@sunpride/ui";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import {
  CALL_SHEET_HEADER_LABELS,
  CALL_SHEET_MEASURES,
  callSheetCsv,
  manilaMonth,
  monthLabel,
  quantityText,
  weekRange,
  type CallSheetHeaderField,
  type CallSheetReport,
} from "../../lib/call-sheet";
import { PanelErrorBoundary } from "../panel-error-boundary";
import "./call-sheet-print.css";

const PAGE_SIZE = 20;
const SHORT_LABELS: Record<string, string> = {
  order: "Order",
  beginningInventory: "Beg. inv.",
  take: "Take",
  delivered: "Deliv.",
  offtake: "Off-take",
  endInventory: "End inv.",
};

export function CallSheetsWorkspace() {
  const [outletId, setOutletId] = useState<Id<"outlets"> | null>(null);
  return (
    <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
      <AccountPicker selected={outletId} onSelect={setOutletId} />
      {outletId ? (
        <PanelErrorBoundary key={outletId} label="Call sheet">
          <CallSheetAccount outletId={outletId} />
        </PanelErrorBoundary>
      ) : (
        <Card label="Call sheet" icon={<WorkspaceIcon name="field" />}>
          <p className="text-sm text-muted">
            Choose an account, or open one by outlet code, to see its monthly
            call sheet.
          </p>
        </Card>
      )}
    </div>
  );
}

function AccountPicker({
  selected,
  onSelect,
}: {
  selected: Id<"outlets"> | null;
  onSelect: (id: Id<"outlets">) => void;
}) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;
  const page = useQuery(api.callSheets.accounts.list, {
    paginationOpts: { numItems: PAGE_SIZE, cursor },
  });
  const [code, setCode] = useState("");
  const [lookup, setLookup] = useState("");
  const found = useQuery(
    api.callSheets.accounts.outletByCode,
    lookup ? { code: lookup } : "skip",
  );
  return (
    <Card
      label="Accounts"
      icon={<WorkspaceIcon name="field" />}
      count={page?.page.length}
      flush
    >
      <form
        className="flex items-end gap-2 border-b border-separator p-4"
        onSubmit={(event) => {
          event.preventDefault();
          setLookup(code.trim());
        }}
      >
        <FormField label="Outlet code" className="flex-1">
          <input
            aria-label="Outlet code"
            className="h-10 w-full"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="e.g. PG-001"
          />
        </FormField>
        <Button type="submit" variant="outline" className="h-10">
          Open
        </Button>
      </form>
      {lookup && found === null && (
        <p role="status" className="px-4 pt-3 text-sm text-muted">
          No outlet {lookup} in your area.
        </p>
      )}
      {lookup && found && (
        <button
          type="button"
          className="block w-full px-4 py-3 text-left text-sm hover:bg-default-soft"
          onClick={() => onSelect(found.id)}
        >
          <span className="font-medium">{found.code}</span> · {found.name}
        </button>
      )}
      {page === undefined ? (
        <p className="p-4 text-sm text-muted">Loading…</p>
      ) : page.page.length === 0 ? (
        <p className="p-4 text-sm text-muted">
          No call sheets set up yet in your area.
        </p>
      ) : (
        <ul className="divide-y divide-separator">
          {page.page.map((row) => (
            <li key={row.outletId}>
              <button
                type="button"
                aria-current={row.outletId === selected ? "true" : undefined}
                className={`grid w-full gap-0.5 px-4 py-3 text-left ${row.outletId === selected ? "bg-default-soft" : "hover:bg-default-soft"}`}
                onClick={() => onSelect(row.outletId)}
              >
                <span className="text-sm font-medium">{row.accountName}</span>
                <span className="text-[13px] text-muted">
                  {row.outletCode} · {row.lineCount} products
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Pager
        label="Call sheet accounts"
        page={cursors.length}
        canPrevious={cursors.length > 1}
        canNext={!!page && !page.isDone}
        onPrevious={() => setCursors((stack) => stack.slice(0, -1))}
        onNext={() =>
          page && setCursors((stack) => [...stack, page.continueCursor])
        }
      />
    </Card>
  );
}

function CallSheetAccount({ outletId }: { outletId: Id<"outlets"> }) {
  const detail = useQuery(api.callSheets.accounts.detail, { outletId });
  const [tab, setTab] = useState<"month" | "setup">("month");
  if (detail === undefined)
    return (
      <Card label="Call sheet">
        <p className="text-sm text-muted">Loading…</p>
      </Card>
    );
  const tabs: ["month" | "setup", string][] = detail.canEdit
    ? [
        ["month", "Month sheet"],
        ["setup", "Account setup"],
      ]
    : [["month", "Month sheet"]];
  return (
    <div className="grid gap-4">
      <UnderlineTabs
        items={tabs}
        activeId={tab}
        onChange={setTab}
        label="Call sheet views"
      />
      {tab === "setup" && detail.canEdit ? (
        <CallSheetEditor key={detail.account?.revision ?? 0} detail={detail} />
      ) : (
        <CallSheetMonth outletId={outletId} />
      )}
    </div>
  );
}

function CallSheetMonth({ outletId }: { outletId: Id<"outlets"> }) {
  const [localMonth, setLocalMonth] = useState(() => manilaMonth());
  const report = useQuery(api.callSheets.report.month, {
    outletId,
    localMonth,
  });
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-[180px] max-w-full">
          <FormField label="Month">
            <input
              type="month"
              aria-label="Month"
              className="h-10 w-full"
              value={localMonth}
              onChange={(event) => {
                if (event.target.value) setLocalMonth(event.target.value);
              }}
            />
          </FormField>
        </div>
        {report && (
          <>
            <Button
              variant="outline"
              className="h-10"
              onPress={() => download(report)}
            >
              Export CSV
            </Button>
            <Button
              variant="outline"
              className="h-10"
              onPress={() => window.print()}
            >
              Print / Save PDF
            </Button>
          </>
        )}
      </div>
      {report === undefined ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <CallSheetMonthView report={report} />
      )}
    </div>
  );
}

function download(report: CallSheetReport) {
  const blob = new Blob([callSheetCsv(report)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `call-sheet-${report.outlet.code}-${report.localMonth}.csv`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The Annex C sheet itself; also the print view. */
export function CallSheetMonthView({ report }: { report: CallSheetReport }) {
  return (
    <section
      className="call-sheet-print-view grid gap-4"
      aria-label="Call sheet"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">
          Call Sheet · {report.header.accountName}
        </h2>
        <p className="text-[13px] text-muted">
          {monthLabel(report.localMonth)} · {report.outlet.code} ·{" "}
          {report.capturedVisits === 1
            ? "1 visit captured"
            : `${report.capturedVisits} visits captured`}
        </p>
      </div>
      {!report.configured && (
        <p role="status" className="text-sm text-muted">
          No call sheet set up for this account yet. The field apps show it once
          the office adds the products.
        </p>
      )}
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        {CALL_SHEET_HEADER_LABELS.slice(1).map(([field, label]) => (
          <div key={field} className="flex gap-2">
            <dt className="min-w-36 text-muted">{label}</dt>
            <dd>{report.header[field] ?? "—"}</dd>
          </div>
        ))}
      </dl>
      {report.rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="call-sheet-grid min-w-full text-[13px] tabular-nums">
            <thead>
              <tr>
                <th rowSpan={2} className="px-2 py-1 text-left">
                  Barcode
                </th>
                <th rowSpan={2} className="px-2 py-1 text-left">
                  Product
                </th>
                <th rowSpan={2} className="px-2 py-1 text-left">
                  Code
                </th>
                <th rowSpan={2} className="px-2 py-1 text-left">
                  Pricing
                </th>
                {[1, 2, 3, 4].map((week) => (
                  <th
                    key={week}
                    colSpan={CALL_SHEET_MEASURES.length}
                    className="border-l border-separator px-2 py-1 text-center"
                  >
                    Week {week}{" "}
                    <span className="font-normal text-muted">
                      ({weekRange(report.localMonth, week)})
                    </span>
                  </th>
                ))}
              </tr>
              <tr>
                {[1, 2, 3, 4].flatMap((week) =>
                  CALL_SHEET_MEASURES.map(([measure, label], index) => (
                    <th
                      key={`${week}-${measure}`}
                      title={label}
                      className={`px-2 py-1 text-right font-normal text-muted ${index === 0 ? "border-l border-separator" : ""}`}
                    >
                      {SHORT_LABELS[measure]}
                    </th>
                  )),
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-separator">
              {report.rows.map((row) => (
                <tr key={row.productId}>
                  <td className="px-2 py-1 text-muted">{row.barcode ?? ""}</td>
                  <td className="px-2 py-1">
                    {row.name}
                    {!row.onSheet && (
                      <span className="ml-1 text-muted">(not on sheet)</span>
                    )}
                  </td>
                  <td className="px-2 py-1">{row.code}</td>
                  <td className="px-2 py-1">{row.pricing ?? ""}</td>
                  {row.weeks.flatMap((week) =>
                    CALL_SHEET_MEASURES.map(([measure], index) => (
                      <td
                        key={`${week.week}-${measure}`}
                        className={`px-2 py-1 text-right ${index === 0 ? "border-l border-separator" : ""}`}
                      >
                        {quantityText(week[measure])}
                      </td>
                    )),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

type Detail = FunctionReturnType<typeof api.callSheets.accounts.detail>;
type DraftLine = {
  productId: Id<"products">;
  code: string;
  name: string;
  uom: string;
  pricing: string;
  active: boolean;
};

export function CallSheetEditor({ detail }: { detail: Detail }) {
  const save = useMutation(api.callSheets.accounts.save);
  const [header, setHeader] = useState<Record<CallSheetHeaderField, string>>(
    () => {
      const source = detail.account?.header;
      return Object.fromEntries(
        CALL_SHEET_HEADER_LABELS.map(([field]) => [
          field,
          source?.[field] ??
            (field === "accountName"
              ? detail.outlet.name
              : field === "address"
                ? (detail.outlet.address ?? "")
                : ""),
        ]),
      ) as Record<CallSheetHeaderField, string>;
    },
  );
  const [lines, setLines] = useState<DraftLine[]>(() =>
    (detail.account?.lines ?? []).map((line) => ({
      ...line,
      pricing: line.pricing ?? "",
    })),
  );
  const [prefix, setPrefix] = useState("");
  const options = useQuery(
    api.callSheets.accounts.productSearch,
    prefix.trim().length >= 2 ? { prefix } : "skip",
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const chosen = new Set(lines.map((line) => line.productId));
  async function submit() {
    setBusy(true);
    setMessage("");
    try {
      const result = await save({
        outletId: detail.outlet.id,
        expectedRevision: detail.account?.revision ?? null,
        header: Object.fromEntries(
          Object.entries(header).filter(
            ([field, value]) => field === "accountName" || value.trim(),
          ),
        ) as { accountName: string },
        lines: lines.map((line) => ({
          productId: line.productId,
          ...(line.pricing.trim() ? { pricing: line.pricing.trim() } : {}),
        })),
      });
      setMessage(`Saved. Phones get revision ${result.revision} on next sync.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-4">
      <Card label="Account header" icon={<WorkspaceIcon name="field" />}>
        <div className="grid gap-3 sm:grid-cols-2">
          {CALL_SHEET_HEADER_LABELS.map(([field, label]) => (
            <FormField key={field} label={label}>
              <input
                aria-label={label}
                className="h-10 w-full"
                maxLength={200}
                value={header[field]}
                onChange={(event) =>
                  setHeader((current) => ({
                    ...current,
                    [field]: event.target.value,
                  }))
                }
              />
            </FormField>
          ))}
        </div>
      </Card>
      <Card label="Products" count={lines.length} flush>
        {lines.length === 0 ? (
          <p className="p-4 text-sm text-muted">
            Add the products this account carries. The field apps show them in
            this order.
          </p>
        ) : (
          <ul className="divide-y divide-separator">
            {lines.map((line, index) => (
              <li
                key={line.productId}
                className="flex flex-wrap items-center gap-3 px-4 py-2"
              >
                <span className="min-w-0 flex-1 text-sm">
                  <span className="font-medium">{line.code}</span> · {line.name}{" "}
                  <span className="text-muted">
                    {line.uom}
                    {line.active ? "" : " · inactive, remove before saving"}
                  </span>
                </span>
                <input
                  aria-label={`Pricing for ${line.code}`}
                  className="h-10 w-40"
                  placeholder="Pricing"
                  maxLength={200}
                  value={line.pricing}
                  onChange={(event) =>
                    setLines((current) =>
                      current.map((item, position) =>
                        position === index
                          ? { ...item, pricing: event.target.value }
                          : item,
                      ),
                    )
                  }
                />
                <Button
                  variant="ghost"
                  className="h-10"
                  onPress={() =>
                    setLines((current) =>
                      current.filter((_, position) => position !== index),
                    )
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="grid gap-2 border-t border-separator p-4">
          <FormField label="Add product by code">
            <input
              aria-label="Add product by code"
              className="h-10 w-full"
              placeholder="Type at least 2 characters, e.g. SUNP"
              value={prefix}
              onChange={(event) => setPrefix(event.target.value)}
            />
          </FormField>
          {options?.map((option) => (
            <button
              key={option.productId}
              type="button"
              disabled={chosen.has(option.productId) || lines.length >= 100}
              className="text-left text-sm disabled:text-muted"
              onClick={() =>
                setLines((current) => [
                  ...current,
                  { ...option, pricing: "", active: true },
                ])
              }
            >
              + {option.code} · {option.name} ({option.uom})
            </button>
          ))}
          {options && options.length === 0 && (
            <p className="text-sm text-muted">No active product matches.</p>
          )}
        </div>
      </Card>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          className="h-10"
          isDisabled={busy || !header.accountName.trim()}
          onPress={() => void submit()}
        >
          Save call sheet
        </Button>
        {message && (
          <p role="status" className="text-sm">
            {message}
          </p>
        )}
      </div>
    </div>
  );
}
