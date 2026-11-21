"use client";

import { Button } from "@heroui/react";
import {
  Card,
  DataTable,
  FormField,
  Notice,
  StatusPill,
  WorkspaceIcon,
  type DataColumn,
  type StatusTone,
} from "@sunpride/ui";
import { useState } from "react";
import { apiFetch, useApi, useMutate } from "../../lib/api";
import { formatDateTime, formatStatus } from "../../lib/format";
import { formatPhp } from "../cockpit/format";

/**
 * SP-0228 Cash remittances: salesmen send the cash they collected through Palawan, Cebuana,
 * GCash or a bank deposit and record it from the Field app with the receipt photo. Finance
 * checks the receipt and confirms or rejects it here. (Weekly truck stock reconciliation will
 * use the confirmed amounts later.)
 */

/** Mirrors `CHANNELS` in apps/api/src/domains/remittances/index.js (parity-tested). */
export const REMITTANCE_CHANNELS = [
  { code: "palawan", label: "Palawan Express" },
  { code: "cebuana", label: "Cebuana Lhuillier" },
  { code: "gcash", label: "GCash" },
  { code: "bank_deposit", label: "Bank deposit" },
  { code: "other", label: "Other" },
] as const;

export const REMITTANCE_STATUS = {
  submitted: "Waiting for Finance",
  confirmed: "Confirmed",
  rejected: "Rejected",
} as const;
const TONES: Record<string, StatusTone> = {
  submitted: "warning",
  confirmed: "success",
  rejected: "danger",
};

export type Remittance = {
  id: string;
  salesmanProfileId: string;
  salesman: string;
  orgUnitId: string;
  branch: string;
  amountMinor: number;
  channel: string;
  channelOther: string | null;
  referenceNumber: string;
  remittedAt: number;
  submittedAt: number;
  note: string | null;
  status: keyof typeof REMITTANCE_STATUS;
  rejectReason: string | null;
  reviewedBy: string | null;
  reviewedAt: number | null;
};
export type RemittanceList = {
  items: Remittance[];
  salesmen: { id: string; name: string }[];
  branches: { id: string; name: string }[];
  canReview: boolean;
};
export type RemittanceFilters = {
  from: string;
  to: string;
  unit: string;
  salesman: string;
  status: string;
};

export function channelLabel(r: Pick<Remittance, "channel" | "channelOther">) {
  if (r.channel === "other" && r.channelOther) return r.channelOther;
  return (
    REMITTANCE_CHANNELS.find((c) => c.code === r.channel)?.label ??
    formatStatus(r.channel)
  );
}

export function statusLabel(status: string) {
  return formatStatus(status, REMITTANCE_STATUS);
}

const receiptUrl = (id: string) =>
  `/api/v1/remittances/${encodeURIComponent(id)}/receipt`;

function csvCell(value: string) {
  return /[",\n\r]/.test(value) || /^[=+\-@]/.test(value)
    ? `"${(/^[=+\-@]/.test(value) ? `'${value}` : value).replaceAll('"', '""')}"`
    : value;
}

/** The CSV Finance downloads: one row per remittance, plain headings. */
export function remittancesCsv(items: readonly Remittance[]) {
  const header = [
    "Remitted",
    "Salesman",
    "Branch",
    "Amount (PHP)",
    "Sent through",
    "Reference number",
    "Status",
    "Reason rejected",
    "Checked by",
    "Checked",
    "Note",
  ];
  const rows = items.map((r) => [
    formatDateTime(r.remittedAt),
    r.salesman,
    r.branch,
    (r.amountMinor / 100).toFixed(2),
    channelLabel(r),
    r.referenceNumber,
    statusLabel(r.status),
    r.rejectReason ?? "",
    r.reviewedBy ?? "",
    r.reviewedAt ? formatDateTime(r.reviewedAt) : "",
    r.note ?? "",
  ]);
  return [header, ...rows]
    .map((row) => row.map((cell) => csvCell(String(cell))).join(","))
    .join("\r\n");
}

/** Query string for the list; empty filters are left out. */
export function remittanceQuery(f: RemittanceFilters) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
}

type Decide = (
  id: string,
  decision: "confirm" | "reject",
  reason?: string,
) => Promise<void>;

function ReviewActions({ row, decide }: { row: Remittance; decide: Decide }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(decision: "confirm" | "reject") {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await decide(row.id, decision, reason.trim() || undefined);
      setRejecting(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        <Button
          className="h-8"
          isDisabled={busy}
          onPress={() => void run("confirm")}
        >
          Confirm
        </Button>
        <Button
          className="h-8"
          variant="secondary"
          isDisabled={busy}
          onPress={() => setRejecting((v) => !v)}
        >
          Reject
        </Button>
      </div>
      {rejecting && (
        <div className="flex flex-wrap items-end gap-2">
          <FormField label="Why reject?">
            <input
              aria-label="Reason for rejecting"
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Reference number not found"
            />
          </FormField>
          <Button
            className="h-8"
            variant="danger"
            isDisabled={busy}
            onPress={() => void run("reject")}
          >
            Reject remittance
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function RemittancesView({
  data,
  filters,
  onFilters,
  decide,
  onPhoto,
}: {
  data: RemittanceList;
  filters: RemittanceFilters;
  onFilters: (next: RemittanceFilters) => void;
  decide: Decide;
  onPhoto: (id: string) => void;
}) {
  const waiting = data.items.filter((r) => r.status === "submitted");
  const columns: DataColumn<Remittance>[] = [
    {
      key: "when",
      label: "Remitted",
      render: (r) => formatDateTime(r.remittedAt),
    },
    {
      key: "salesman",
      label: "Salesman",
      render: (r) => (
        <span className="flex flex-col">
          <span>{r.salesman}</span>
          <span className="text-[12px] text-muted">{r.branch}</span>
        </span>
      ),
    },
    {
      key: "amount",
      label: "Amount",
      align: "right",
      render: (r) => formatPhp(r.amountMinor, { cents: true }),
    },
    {
      key: "channel",
      label: "Sent through",
      render: (r) => (
        <span className="flex flex-col">
          <span>{channelLabel(r)}</span>
          <span className="font-mono text-[12px]">{r.referenceNumber}</span>
          {r.note && (
            <span className="text-[12px] text-muted">{r.note}</span>
          )}
        </span>
      ),
    },
    {
      key: "receipt",
      label: "Receipt",
      render: (r) => (
        <button
          type="button"
          className="text-sm underline"
          onClick={() => onPhoto(r.id)}
        >
          View receipt
        </button>
      ),
    },
    {
      key: "status",
      label: "Status",
      render: (r) => (
        <span className="flex flex-col gap-1">
          <StatusPill tone={TONES[r.status] ?? "neutral"}>
            {statusLabel(r.status)}
          </StatusPill>
          {r.rejectReason && (
            <span className="text-[12px]">{r.rejectReason}</span>
          )}
          {r.reviewedBy && r.reviewedAt && (
            <span className="text-[12px] text-muted">
              {r.reviewedBy} · {formatDateTime(r.reviewedAt)}
            </span>
          )}
        </span>
      ),
    },
    ...(data.canReview
      ? [
          {
            key: "actions",
            label: "",
            render: (r: Remittance) =>
              r.status === "submitted" ? (
                <ReviewActions row={r} decide={decide} />
              ) : null,
          },
        ]
      : []),
  ];
  const set = (patch: Partial<RemittanceFilters>) =>
    onFilters({ ...filters, ...patch });
  function download() {
    const blob = new Blob([remittancesCsv(data.items)], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cash-remittances${filters.from ? `-${filters.from}` : ""}${filters.to ? `-to-${filters.to}` : ""}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <Card label="Cash remittances" icon={<WorkspaceIcon name="document" />}>
      <div className="grid gap-4 p-4">
        <p className="text-sm text-muted">
          Cash that salesmen sent through Palawan, Cebuana, GCash or a bank
          deposit, with the receipt photo they took. Salesmen should remit the
          same day or the next day. Check each receipt, then confirm it or
          reject it with a reason.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <FormField label="From">
            <input
              type="date"
              aria-label="From date"
              value={filters.from}
              onChange={(e) => set({ from: e.target.value })}
            />
          </FormField>
          <FormField label="To">
            <input
              type="date"
              aria-label="To date"
              value={filters.to}
              onChange={(e) => set({ to: e.target.value })}
            />
          </FormField>
          {data.branches.length > 1 || filters.unit ? (
            <FormField label="Branch">
              <select
                aria-label="Branch"
                value={filters.unit}
                onChange={(e) => set({ unit: e.target.value })}
              >
                <option value="">All branches</option>
                {data.branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </FormField>
          ) : null}
          <FormField label="Salesman">
            <select
              aria-label="Salesman"
              value={filters.salesman}
              onChange={(e) => set({ salesman: e.target.value })}
            >
              <option value="">All salesmen</option>
              {data.salesmen.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Status">
            <select
              aria-label="Status"
              value={filters.status}
              onChange={(e) => set({ status: e.target.value })}
            >
              <option value="">Any status</option>
              {Object.entries(REMITTANCE_STATUS).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </FormField>
          <Button
            className="h-10"
            variant="secondary"
            isDisabled={data.items.length === 0}
            onPress={download}
          >
            Download CSV
          </Button>
        </div>
        <p className="text-sm" role="status">
          {data.items.length} shown · {waiting.length} waiting for Finance ·{" "}
          {formatPhp(
            waiting.reduce((sum, r) => sum + r.amountMinor, 0),
            { cents: true },
          )}{" "}
          not yet confirmed
        </p>
        <DataTable
          columns={columns}
          rows={data.items}
          empty={
            <Notice title="No cash remittances for these filters yet. Salesmen record them in the Field app under Remit cash." />
          }
        />
      </div>
    </Card>
  );
}

function ReceiptDialog({ id, onClose }: { id: string; onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-label="Receipt photo"
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="grid max-h-full gap-2 rounded-xl bg-background p-3"
        onClick={(e) => e.stopPropagation()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- private, cookie-authorized image */}
        <img
          src={receiptUrl(id)}
          alt="Remittance receipt"
          className="max-h-[80vh] max-w-full object-contain"
        />
        <div className="flex justify-between gap-2">
          <a
            className="text-sm underline"
            href={receiptUrl(id)}
            target="_blank"
            rel="noreferrer"
          >
            Open full size
          </a>
          <Button className="h-8" onPress={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}

export function RemittancesWorkspace() {
  const [filters, setFilters] = useState<RemittanceFilters>({
    from: "",
    to: "",
    unit: "",
    salesman: "",
    status: "submitted",
  });
  const [photo, setPhoto] = useState<string | null>(null);
  const query = useApi<RemittanceList>(["remittances", filters], ({ signal }) =>
    apiFetch(`/api/v1/remittances${remittanceQuery(filters)}`, { signal }),
  );
  const { mutate } = useMutate();
  const decide: Decide = async (id, decision, reason) => {
    await mutate(
      `/api/v1/remittances/${encodeURIComponent(id)}/${decision}`,
      decision === "reject" ? { reason } : {},
      { invalidate: [["remittances"]] },
    );
  };
  if (query.error)
    return <Notice tone="danger" title={query.error.message} />;
  if (!query.data) return <Notice title="Loading cash remittances…" />;
  return (
    <>
      <RemittancesView
        data={query.data}
        filters={filters}
        onFilters={setFilters}
        decide={decide}
        onPhoto={setPhoto}
      />
      {photo && <ReceiptDialog id={photo} onClose={() => setPhoto(null)} />}
    </>
  );
}
