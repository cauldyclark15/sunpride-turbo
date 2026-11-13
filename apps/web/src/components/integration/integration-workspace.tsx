"use client";
import { formatDate, formatDateTime, formatStatus } from "../../lib/format";

import { useState } from "react";
import { Button } from "@heroui/react";
import { Card, FormField, WorkspaceIcon } from "@sunpride/ui";
import { apiFetch, mutate, useApi, useLive } from "../../lib/api";
import { usePermissions } from "../../lib/auth";

type Event = {
  id: string;
  label?: string;
  kind: string;
  direction: string;
  status: string;
  attempts: number;
  owner: string | null;
  openedAt: number;
  error: string | null;
  escalated: boolean;
  documentNumber: string | null;
};
export type Queue = {
  asOf: number;
  sample?: boolean;
  rows: Event[];
  next: string | null;
  counts: {
    failed: number;
    stuck: number;
    today: number;
    prior: number;
    oldest: number | null;
  };
};
type Trace = {
  event: Event;
  history: {
    action: string;
    actor: string | null;
    at: number;
    facts: { reason?: string; documentNumber?: string };
  }[];
  conflicts: { reason: string }[];
};
const labels: Record<string, string> = {
  dead_letter: "Needs a decision",
  failed: "Retry scheduled",
  pending: "Waiting to send",
  processing: "Sending",
  completed: "Accepted by SAP",
};
export function queueAge(at: number, now: number) {
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  return minutes < 60
    ? `${minutes} min`
    : minutes < 1440
      ? `${Math.floor(minutes / 60)} hr`
      : `${Math.floor(minutes / 1440)} days`;
}

/** F-005 owner question: which documents have not reached SAP, and who will resolve them? */
export function IntegrationQueue({
  data,
  now = data.asOf,
  onSelect,
}: {
  data: Queue;
  now?: number;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted">
        {data.sample ? (
          <span className="mr-2 rounded border border-border px-2 py-1 text-xs">
            Sample SAP
          </span>
        ) : null}
        SAP remains the financial record. Fix the source of a rejection, then
        replay the same document. Nothing is re-keyed.
      </p>
      <div className="grid gap-3 sm:grid-cols-4">
        {[
          ["Failed posts", data.counts.failed, "Target: none"],
          ["Stuck in queue", data.counts.stuck, "Target: none over 5 minutes"],
          [
            "Processed, last 24 hours",
            data.counts.today,
            `${data.counts.prior} in the previous 24 hours`,
          ],
          [
            "Oldest waiting",
            data.counts.oldest === null
              ? "None"
              : queueAge(data.counts.oldest, now),
            data.counts.oldest === null
              ? "No documents waiting"
              : "Open the record and assign an owner",
          ],
        ].map(([label, value, note]) => (
          <section
            key={label}
            className="rounded-lg border border-border bg-surface p-4"
          >
            <p className="text-xs text-muted">{label}</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
            <p className="mt-2 text-xs text-muted">{note}</p>
          </section>
        ))}
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border text-xs text-muted">
            <tr>
              {["Document", "State", "Owner", "Age", "Next action"].map((x) => (
                <th key={x} className="p-3 font-medium">
                  {x}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.id} className="border-b border-border last:border-0">
                <td className="p-3">
                  <p className="font-medium capitalize">
                    {row.label ?? row.kind}
                  </p>
                  <p className="mt-1 max-w-md text-xs text-muted">
                    {row.documentNumber ??
                      row.error ??
                      (row.direction === "inbound"
                        ? "Master replication"
                        : "Durable posting instruction")}
                  </p>
                </td>
                <td className="p-3">
                  {row.direction === "inbound" && row.status === "completed"
                    ? "Replicated from SAP"
                    : (labels[row.status] ?? "Needs review")}
                  {row.escalated ? (
                    <span className="ml-2 text-xs">Escalated</span>
                  ) : null}
                </td>
                <td className="p-3">{row.owner ?? "Unassigned"}</td>
                <td className="p-3 tabular-nums">
                  {queueAge(row.openedAt, now)}
                </td>
                <td className="p-3">
                  <Button
                    size="sm"
                    variant="outline"
                    onPress={() => onSelect(row.id)}
                  >
                    Open trace
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.rows.length === 0 ? (
          <p className="p-6 text-sm text-muted">
            No records in this queue. Use All records to inspect successful
            posts.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function IntegrationWorkspace() {
  const { can } = usePermissions();
  const [filter, setFilter] = useState("attention");
  const [masterKind, setMasterKind] = useState("material");
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [owner, setOwner] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const query = { status: filter, cursor: cursor ?? undefined };
  const queue = useApi<Queue>(
    can("integration.read") ? ["integration", "queue", query] : null,
    ({ signal }) => apiFetch("/api/v1/integration/events", { query, signal }),
  );
  const owners = useApi<{ rows: { id: string; name: string }[] }>(
    can("integration.manage") ? ["integration", "owners"] : null,
    "/api/v1/integration/owners",
  );
  const trace = useApi<Trace>(
    selected ? ["integration", "trace", selected] : null,
    ({ signal }) =>
      apiFetch("/api/v1/integration/trace", {
        query: { id: selected },
        signal,
      }),
  );
  const mappings = useApi<{
    rows: {
      name: string;
      kind: string;
      plant: string | null;
      storageLocation: string | null;
      status: string;
    }[];
  }>(
    can("integration.read") ? ["integration", "mappings"] : null,
    "/api/v1/integration/mappings",
  );
  const replicas = useApi<{
    truncated: boolean;
    rows: {
      name: string;
      source: string;
      version: number;
      effectiveFrom: number;
      effectiveTo: number | null;
      receivedAt: number;
      deleted: boolean;
      data: Record<string, unknown>;
    }[];
  }>(
    can("integration.read") ? ["integration", "replicas", masterKind] : null,
    ({ signal }) =>
      apiFetch("/api/v1/integration/replicas", {
        query: { kind: masterKind },
        signal,
      }),
  );
  useLive(["integration"], [["integration"]]);
  async function action(kind: string) {
    if (!selected || reason.trim().length < 3) {
      setNotice("Enter a reason for the resolution history.");
      return;
    }
    if (
      kind === "retry" &&
      !window.confirm(
        "Replay the original document with its existing SAP effect reference?",
      )
    )
      return;
    setBusy(true);
    setNotice("");
    try {
      await mutate(
        `/api/v1/integration/${kind}`,
        {
          id: selected,
          reason: reason.trim(),
          ...(kind === "assign" ? { ownerProfileId: owner || null } : {}),
        },
        { invalidate: [["integration"]] },
      );
      setNotice(
        kind === "retry"
          ? "Queued for retry. The original document reference is unchanged."
          : "Resolution saved.",
      );
      setReason("");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "The change was not saved");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <FormField label="Queue">
          <select
            className="min-w-48 rounded border border-border bg-surface py-2 pl-3 pr-8"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setCursor(null);
            }}
          >
            <option value="attention">Needs attention</option>
            <option value="dead_letter">Needs a decision</option>
            <option value="all">All records</option>
            <option value="completed">Accepted by SAP</option>
          </select>
        </FormField>
        <Button
          variant="outline"
          onPress={() => {
            void queue.refetch();
          }}
        >
          Refresh
        </Button>
      </div>
      {queue.error ? (
        <p role="alert" className="text-sm text-danger">
          {queue.error.message}
        </p>
      ) : queue.data ? (
        <IntegrationQueue
          data={queue.data}
          onSelect={(id) => {
            setSelected(id);
            setNotice("");
            setReason("");
          }}
        />
      ) : (
        <p className="text-sm text-muted">Loading the durable queue…</p>
      )}
      <div className="flex gap-2">
        {cursor ? (
          <Button size="sm" variant="outline" onPress={() => setCursor(null)}>
            First page
          </Button>
        ) : null}
        {queue.data?.next ? (
          <Button
            size="sm"
            variant="outline"
            onPress={() => setCursor(queue.data!.next)}
          >
            Next page
          </Button>
        ) : null}
      </div>
      {selected ? (
        <Card
          label="Document trace and resolution"
          icon={<WorkspaceIcon name="operations" />}
        >
          {trace.error ? (
            <p role="alert">{trace.error.message}</p>
          ) : trace.data ? (
            <div className="grid gap-4">
              <p className="text-sm">
                {labels[trace.data.event.status]} · {trace.data.event.attempts}{" "}
                delivery{" "}
                {trace.data.event.attempts === 1 ? "attempt" : "attempts"}
                {trace.data.event.documentNumber
                  ? ` · SAP document: ${trace.data.event.documentNumber}`
                  : ""}
              </p>
              {trace.data.conflicts.map((c, i) => (
                <p key={i} role="alert" className="text-sm">
                  Quarantined: {c.reason}. The original document was not
                  overwritten.
                </p>
              ))}
              <ol className="grid gap-2 text-sm">
                {trace.data.history.map((h, i) => (
                  <li key={i}>
                    <span className="font-medium capitalize">
                      {h.action.replaceAll("_", " ")}
                    </span>{" "}
                    · {formatDateTime(h.at)} · {h.actor ?? "Integration worker"}
                    {h.facts.reason ? ` — ${h.facts.reason}` : ""}
                    {h.facts.documentNumber
                      ? ` — ${h.facts.documentNumber}`
                      : ""}
                  </li>
                ))}
              </ol>
              {can("integration.manage") ? (
                <div className="grid gap-3 border-t border-border pt-4">
                  <FormField label="Resolution reason">
                    <input
                      value={reason}
                      maxLength={500}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="What was corrected or who will act?"
                    />
                  </FormField>
                  <FormField label="Responsible operator">
                    <select
                      className="min-w-48 rounded border border-border bg-surface py-2 pl-3 pr-8"
                      value={owner}
                      onChange={(e) => setOwner(e.target.value)}
                    >
                      <option value="">Unassigned</option>
                      {owners.data?.rows.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  </FormField>
                  <div className="flex flex-wrap gap-2">
                    {trace.data.event.status !== "completed" ? (
                      <Button
                        isDisabled={busy}
                        onPress={() => {
                          void action("retry");
                        }}
                      >
                        Retry original document
                      </Button>
                    ) : null}
                    <Button
                      variant="outline"
                      isDisabled={busy}
                      onPress={() => {
                        void action("assign");
                      }}
                    >
                      Reassign
                    </Button>
                    <Button
                      variant="outline"
                      isDisabled={busy}
                      onPress={() => {
                        void action("escalate");
                      }}
                    >
                      Escalate
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted">
                  An administrator can retry, reassign or escalate this record.
                </p>
              )}
            </div>
          ) : (
            <p>Loading trace…</p>
          )}
        </Card>
      ) : null}
      <details className="rounded-lg border border-border bg-surface p-4">
        <summary className="cursor-pointer text-sm font-medium">
          SAP master replicas and depot / van mappings
        </summary>
        <div className="mt-4 grid gap-4">
          <p className="text-sm text-muted">
            Read-only SAP facts. Correct a material, pack, price or plant
            mapping in SAP, then ingest its next version. Operational stock
            quantities remain local; stock value comes from the SAP snapshot.
          </p>
          {mappings.error ? (
            <p role="alert">{mappings.error.message}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    {[
                      "Location",
                      "Type",
                      "SAP plant",
                      "Storage location",
                      "Action",
                    ].map((x) => (
                      <th className="p-2 font-medium" key={x}>
                        {x}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {mappings.data?.rows.map((r, i) => (
                    <tr key={i} className="border-t border-border">
                      <td className="p-2">{r.name}</td>
                      <td className="p-2">{formatStatus(r.kind)}</td>
                      <td className="p-2">{r.plant ?? "Unknown"}</td>
                      <td className="p-2">{r.storageLocation ?? "Unknown"}</td>
                      <td className="p-2">{formatStatus(r.status)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <FormField label="SAP master family">
            <select
              className="min-w-48 rounded border border-border bg-surface py-2 pl-3 pr-8"
              value={masterKind}
              onChange={(e) => setMasterKind(e.target.value)}
            >
              <option value="material">Materials and packs</option>
              <option value="condition">Prices, conditions and tax</option>
              <option value="customer">Customers</option>
              <option value="ar">AR open items</option>
              <option value="location">Plants and storage locations</option>
              <option value="stock">Stock value snapshots</option>
            </select>
          </FormField>
          {replicas.error ? (
            <p role="alert">{replicas.error.message}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    {[
                      "Record",
                      "Source",
                      "Version",
                      "Effective from",
                      "Received",
                      "SAP facts",
                    ].map((x) => (
                      <th className="p-2 font-medium" key={x}>
                        {x}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {replicas.data?.rows.map((r, i) => (
                    <tr key={i} className="border-t border-border">
                      <td className="p-2">
                        {r.name}
                        {r.deleted ? " · Retired" : ""}
                      </td>
                      <td className="p-2">{r.source}</td>
                      <td className="p-2">{r.version}</td>
                      <td className="p-2">{formatDate(r.effectiveFrom)}</td>
                      <td className="p-2">{formatDate(r.receivedAt)}</td>
                      <td className="max-w-sm p-2 text-xs text-muted">
                        {masterKind === "material"
                          ? `${r.data.storageCondition}; ${r.data.shelfLifeDays} days shelf life`
                          : masterKind === "condition"
                            ? `₱${(Number(r.data.unitPriceCentavos) / 100).toFixed(2)} / ${r.data.uom}; ${r.data.taxCode}; ${r.data.customerCode ?? r.data.channelKey ?? "Base price"}`
                            : masterKind === "stock"
                              ? `₱${(Number(r.data.valueCentavos) / 100).toFixed(2)} at ${r.data.locationCode}`
                              : masterKind === "ar"
                                ? `₱${(Number(r.data.amountCentavos) / 100).toFixed(2)}; due ${formatDate(Number(r.data.dueAt))}`
                                : "SAP-owned master"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {replicas.data?.truncated ? (
                <p className="mt-2 text-xs text-muted">
                  Showing the first 50 source records; more records are retained
                  in the replica.
                </p>
              ) : null}
            </div>
          )}
        </div>
      </details>
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
