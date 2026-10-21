"use client";

import { useState, useEffect, type FormEvent } from "react";
import { mutate, useApi, useLive } from "../../lib/api";
import { Panel } from "../cockpit/kit";
import { FiscalAudit } from "./audit";
import { FiscalPosting, type FiscalSapPosting } from "./posting";
import { ApprovalGrant, OverrideFacts } from "./override-facts";
import { FiscalTaxSummary } from "./tax-summary";
import {
  authorityMinor,
  authorityPeso,
  fiscalMoney as formatPhp,
} from "./authority-money";

type Row = Record<string, string | number | boolean | null>;
type Registration = Row & {
  id: string;
  branch_name: string;
  entity_name: string;
  document_type: string;
  status: string;
  org_unit_id: string;
};
type Document = {
  id: string;
  document_number: string;
  document_type: string;
  branch_name: string;
  sap_posting?: FiscalSapPosting | null;
  journal: { kind: string; reason: string }[];
  snapshot: {
    totalMinor: string;
    tax: { vatMinor: string };
    registration: { sample: boolean };
  };
};
type Register = {
  registrations: Registration[];
  series: Row[];
  allocations: (Row & {
    closure?: {
      outcome: string;
      first_unissued: string;
      last_serial: string;
    } | null;
  })[];
  overrides: Row[];
  rules: Row[];
  documents: Document[];
  units: { id: string; name: string }[];
  vehicles: { id: string; name: string }[];
  tenders: {
    id: string;
    method: string;
    kind: string;
    amount_centavos: number;
    trip_number: string;
    seller: string;
    decision: string | null;
    facts: { reference?: string };
  }[];
  tenderTotals?: {
    method: string;
    captured_centavos: string;
    awaiting_count: number;
    refused_count: number;
  }[];
  tenderRules?: {
    id: string;
    branch_name: string;
    method: string;
    label: string;
    enabled: boolean;
    effective_from: string;
    effective_to: string | null;
  }[];
  devices?: { id: string; name: string }[];
  canAudit?: boolean;
  canManage: boolean;
  canDecide: boolean;
  truncated: boolean;
};
const labels: Record<string, string> = {
  sales_invoice: "Sales Invoice",
  official_receipt: "Official Receipt",
  credit_memo: "Credit memo",
  delivery_receipt: "Delivery receipt",
  sample_not_filed: "Sample, not filed",
  acknowledged: "Acknowledged",
  approved: "Approved",
  draft: "Draft",
  filed: "Filed",
  suspended: "Suspended",
  expired: "Expired",
  cash: "Cash",
  gcash: "GCash",
  maya: "Maya",
  card: "Card",
  check: "Cheque",
  bank_transfer: "Bank transfer",
  credit: "On account",
};
const word = (value: unknown) =>
  labels[String(value)] ?? String(value ?? "Not set").replaceAll("_", " ");
const overrideWord = (value: unknown) =>
  value === "credit" ? "Credit" : word(value);
const button =
  "rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50";
type Field = {
  name: string;
  label: string;
  value?: string;
  options?: { id: string; label: string }[];
  type?: string;
  optional?: boolean;
  step?: string;
};
function CommandForm({
  title,
  fields,
  onSubmit,
}: {
  title: string;
  fields: Field[];
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const form = e.currentTarget;
    const body = Object.fromEntries(new FormData(form));
    try {
      await onSubmit(body);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="grid gap-3 md:grid-cols-2">
      <h3 className="text-sm font-semibold md:col-span-2">{title}</h3>
      {fields.map((f) => (
        <label key={f.name} className="grid gap-1 text-sm">
          <span>{f.label}</span>
          {f.options ? (
            <select
              name={f.name}
              required={!f.optional}
              defaultValue={f.value ?? ""}
            >
              <option value="">Choose…</option>
              {f.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              name={f.name}
              type={f.type ?? "text"}
              step={f.step}
              defaultValue={f.value}
              required={!f.optional}
            />
          )}
        </label>
      ))}
      <button disabled={busy} className={`${button} justify-self-start`}>
        {busy ? "Saving…" : "Save"}
      </button>
    </form>
  );
}
export function FiscalWorkspace({
  decisionsOnly = false,
  moneyOnly = false,
}: {
  decisionsOnly?: boolean;
  moneyOnly?: boolean;
}) {
  const [branch, setBranch] = useState("");
  const [day, setDay] = useState("");
  const result = useApi<Register>(
    ["fiscal", "register", branch, day],
    "/api/v1/fiscal/register?" +
      new URLSearchParams({
        ...(branch ? { branchId: branch } : {}),
        ...(day ? { day } : {}),
      }).toString(),
  );
  useLive(["fiscal"], [["fiscal"]]);
  const [message, setMessage] = useState("");
  const [approvalGrant, setApprovalGrant] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editingRule, setEditingRule] = useState<Row | null>(null);
  useEffect(() => {
    if (editingRule)
      document
        .getElementById("authority-editor")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [editingRule]);
  const data = result.data;
  async function command(path: string, body: Record<string, unknown>) {
    setMessage("");
    setApprovalGrant(null);
    for (const key of [
      "effectiveFrom",
      "effectiveTo",
      "filedAt",
      "acknowledgedAt",
    ])
      if (body[key]) body[key] = new Date(String(body[key])).toISOString();
    try {
      if (path === "authority/save") {
        body.minCentavos = authorityMinor(body.minAmount);
        body.maxCentavos = authorityMinor(body.maxAmount);
        body.selfLimitCentavos = authorityMinor(body.ownAmount);
        body.approverRoles = String(body.approverGroup ?? "").split(",");
        body.offlineAllowed = body.offlineAllowed === "true";
        delete body.minAmount;
        delete body.maxAmount;
        delete body.ownAmount;
        delete body.approverGroup;
      }
      if (path === "overrides/decide")
        body.offline = body.offline === "true" || body.offline === true;
      const saved = await mutate<{ offlineGrant?: string }>(
        `/api/v1/fiscal/${path}`,
        body,
        {
          invalidate: [["fiscal"]],
        },
      );
      setMessage("Saved. The register has been updated.");
      if (saved?.offlineGrant) setApprovalGrant(saved.offlineGrant);
      await result.refetch();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not save. Try again.",
      );
    }
  }
  if (result.error)
    return (
      <p role="alert">Fiscal register could not load. {result.error.message}</p>
    );
  if (!data) return <p>Loading fiscal register…</p>;
  const branches = data.units.map((u) => ({ id: u.id, label: u.name }));
  const types = Object.entries(labels)
    .filter(([id]) =>
      [
        "sales_invoice",
        "official_receipt",
        "credit_memo",
        "delivery_receipt",
      ].includes(id),
    )
    .map(([id, label]) => ({ id, label }));
  const doc = data.documents.find((d) => d.id === selected);
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="grid gap-1 text-sm">
          Branch
          <select value={branch} onChange={(e) => setBranch(e.target.value)}>
            <option value="">All branches in my scope</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
        <div className="grid gap-1 text-sm">
          <span>Document and tender service date</span>
          <div className="flex flex-wrap items-center gap-2">
            {day ? (
              <input
                aria-label="Chosen service date"
                type="date"
                value={day}
                onChange={(e) => setDay(e.target.value)}
              />
            ) : (
              <span>All service dates</span>
            )}
            <button
              type="button"
              className={button}
              onClick={() =>
                setDay(
                  day
                    ? ""
                    : new Date(Date.now() + 8 * 60 * 60 * 1000)
                        .toISOString()
                        .slice(0, 10),
                )
              }
            >
              {day ? "All service dates" : "Choose a service date"}
            </button>
          </div>
        </div>
      </div>
      {message ? (
        <p
          role="status"
          className="rounded-lg border border-border p-3 text-sm"
        >
          {message}
        </p>
      ) : null}
      {data.truncated ? (
        <p role="alert">
          This view has more than 500 records. This is a partial list, not a
          complete reconciliation. Choose a branch and service date to narrow
          it.
        </p>
      ) : null}
      {approvalGrant ? <ApprovalGrant grant={approvalGrant} /> : null}
      {!moneyOnly ? (
        <Panel
          title="Overrides to decide"
          question="Which transaction needs a second person's authority?"
        >
          {data.overrides.filter((r) => !r.decision).length === 0 ? (
            <p className="text-sm text-muted">
              No overrides waiting in this view.
            </p>
          ) : (
            data.overrides
              .filter((r) => !r.decision)
              .map((r) => (
                <div
                  key={String(r.id)}
                  className="grid gap-2 border-b border-border py-3 text-sm"
                >
                  <strong>
                    {overrideWord(r.kind)} · {r.requester} ·{" "}
                    {formatPhp(r.amount_centavos)}
                  </strong>
                  <p>
                    {r.reason} · {r.channel} ·{" "}
                    {r.requires_second
                      ? "Second approval required"
                      : "Within own limit; reason recorded"}
                  </p>
                  <OverrideFacts value={r.facts} />
                  {data.canDecide ? (
                    <CommandForm
                      title="Decision"
                      fields={[
                        {
                          name: "decision",
                          label: "Decision",
                          options: [
                            { id: "approved", label: "Approve" },
                            { id: "rejected", label: "Refuse" },
                          ],
                        },
                        { name: "reason", label: "Decision reason" },
                        {
                          name: "offline",
                          label: "Use while offline",
                          value: "false",
                          options: [
                            { id: "false", label: "Online approval only" },
                            {
                              id: "true",
                              label:
                                "Issue exact-cart offline code (policy must allow)",
                            },
                          ],
                        },
                      ]}
                      onSubmit={(b) =>
                        command("overrides/decide", { ...b, id: r.id })
                      }
                    />
                  ) : null}
                </div>
              ))
          )}
        </Panel>
      ) : null}
      {!decisionsOnly ? (
        <Panel
          title="Van money by tender"
          question="Net van captures in these branch/date filters, not office or field receipts. Captured is not bank-cleared money; non-cash needs independent confirmation."
        >
          <p className="text-xs text-muted">
            Basis: {day || "All service dates"}. Van captures only.
          </p>
          {!data.tenderTotals ? (
            <p>Captured totals unavailable. Refresh before using this view.</p>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-3">
            {(data.tenderTotals ?? []).map((summary) => (
              <div
                key={summary.method}
                className="rounded-xl border border-border p-3"
              >
                <p>{word(summary.method)}</p>
                <strong>{formatPhp(summary.captured_centavos)}</strong>
                <p className="text-xs text-muted">
                  Net captured · {summary.awaiting_count} awaiting confirmation
                  · {summary.refused_count} refused
                </p>
              </div>
            ))}
          </div>
          {data.truncated ? (
            <p className="text-xs text-muted">
              Tender totals cover all matching records; the item lists are
              capped. Narrow the branch and date to review individual entries.
            </p>
          ) : null}
          {data.canDecide
            ? data.tenders
                .filter(
                  (t) =>
                    !t.decision &&
                    !["cash", "credit"].includes(String(t.method)),
                )
                .map((t) => (
                  <details
                    key={String(t.id)}
                    className="border-b border-border py-3 text-sm"
                  >
                    <summary>
                      {t.seller} · {word(t.method)} ·{" "}
                      {formatPhp(t.amount_centavos)} · {t.trip_number}
                    </summary>
                    <p>Reference: {t.facts.reference ?? "Missing"}</p>
                    <CommandForm
                      title="Confirm against provider statement"
                      fields={[
                        {
                          name: "decision",
                          label: "Decision",
                          options: [
                            { id: "confirmed", label: "Confirmed" },
                            { id: "rejected", label: "Refused" },
                          ],
                        },
                        { name: "reason", label: "Evidence and reason" },
                      ]}
                      onSubmit={(b) =>
                        command("tenders/confirm", { ...b, paymentId: t.id })
                      }
                    />
                  </details>
                ))
            : null}
        </Panel>
      ) : null}
      {!decisionsOnly && !moneyOnly ? (
        <>
          <Panel
            title="BIR compliance register"
            question="Can this branch issue documents? Sample registrations are not filed or authorized by BIR."
          >
            {data.registrations.map((r) => (
              <div key={r.id} className="border-b border-border py-3 text-sm">
                <strong>
                  {r.branch_name} · {word(r.document_type)}
                </strong>
                <p>
                  {word(r.status)} · {r.entity_name}
                </p>
                <p>
                  Applies to:{" "}
                  {r.device_id
                    ? String(r.device_name ?? "Retired or unavailable handheld")
                    : "All handhelds in this branch"}{" "}
                  · {r.device_app ? word(r.device_app) : "Branch documents"}
                  <br />
                  Permit: {r.permit_reference ?? "Not supplied"} · Evidence:{" "}
                  {r.evidence_reference ?? "Not supplied"}
                </p>
                {data.canManage ? (
                  <details className="mt-2">
                    <summary>Update filing or verify evidence</summary>
                    <CommandForm
                      title="Filing evidence (approval needs a different administrator)"
                      fields={[
                        {
                          name: "status",
                          label: "Status",
                          value: r.status,
                          options: (r.sample
                            ? ["sample_not_filed"]
                            : [
                                "draft",
                                "filed",
                                "acknowledged",
                                "approved",
                                "suspended",
                                "expired",
                              ]
                          ).map((id) => ({ id, label: word(id) })),
                        },
                        {
                          name: "applicationReference",
                          label: "Application reference",
                          value: String(r.application_reference ?? ""),
                          optional: true,
                        },
                        {
                          name: "permitReference",
                          label: "Permit reference",
                          value: String(r.permit_reference ?? ""),
                          optional: true,
                        },
                        {
                          name: "evidenceReference",
                          label: "Evidence URL or file reference",
                          value: String(r.evidence_reference ?? ""),
                          optional: true,
                        },
                        {
                          name: "filedAt",
                          label: "Filed on",
                          type: "datetime-local",
                          optional: true,
                        },
                        {
                          name: "acknowledgedAt",
                          label: "Acknowledged on",
                          type: "datetime-local",
                          optional: true,
                        },
                        {
                          name: "effectiveTo",
                          label: "Permit expiry (blank keeps current expiry)",
                          type: "datetime-local",
                          optional: true,
                        },
                      ]}
                      onSubmit={(b) =>
                        command("registrations/save", {
                          ...b,
                          id: r.id,
                          orgUnitId: r.org_unit_id,
                          entityName: r.entity_name,
                          branchName: r.branch_name,
                          tin: r.tin,
                          address: r.address,
                          documentType: r.document_type,
                          effectiveFrom: r.effective_from,
                        })
                      }
                    />
                  </details>
                ) : null}
              </div>
            ))}
            {data.canManage ? (
              <details className="mt-4">
                <summary className="cursor-pointer text-sm font-medium">
                  Add registration
                </summary>
                <CommandForm
                  title="Register applicability and filing evidence"
                  fields={[
                    {
                      name: "orgUnitId",
                      label: "Branch scope",
                      options: branches,
                    },
                    { name: "entityName", label: "Registered entity name" },
                    { name: "branchName", label: "Registered branch name" },
                    { name: "tin", label: "TIN" },
                    { name: "address", label: "Registered address" },
                    {
                      name: "taxBasisPoints",
                      label:
                        "Inclusive VAT basis points (1200 = 12%; 0 = exempt)",
                      type: "number",
                      value: "1200",
                    },
                    {
                      name: "deviceId",
                      label: "Specific handheld (blank = branch-wide)",
                      options: (data.devices ?? []).map((d) => ({
                        id: d.id,
                        label: d.name,
                      })),
                      optional: true,
                    },
                    { name: "documentType", label: "Document", options: types },
                    {
                      name: "status",
                      label: "Filing status",
                      options: [
                        "sample_not_filed",
                        "draft",
                        "filed",
                        "acknowledged",
                      ].map((id) => ({ id, label: word(id) })),
                    },
                    {
                      name: "applicationReference",
                      label: "Application reference",
                      optional: true,
                    },
                    {
                      name: "permitReference",
                      label: "Permit reference",
                      optional: true,
                    },
                    {
                      name: "evidenceReference",
                      label: "Evidence URL or file reference",
                      optional: true,
                    },
                    {
                      name: "effectiveFrom",
                      label: "Valid from",
                      type: "datetime-local",
                    },
                    {
                      name: "effectiveTo",
                      label: "Valid until",
                      type: "datetime-local",
                      optional: true,
                    },
                  ]}
                  onSubmit={(b) => command("registrations/save", b)}
                />
              </details>
            ) : null}
          </Panel>
          <Panel
            title="Tender policy"
            question="Which tenders may each branch accept? Changes are prospective; noncash still needs a provider reference and independent confirmation."
          >
            {(data.tenderRules ?? []).map((r) => (
              <p key={r.id} className="border-b border-border py-2 text-sm">
                {r.branch_name} · {r.label} ·{" "}
                {r.enabled ? "Enabled" : "Disabled"} ·{" "}
                {new Date(r.effective_from).toLocaleString()}
                {r.effective_to
                  ? ` until ${new Date(r.effective_to).toLocaleString()}`
                  : ""}
              </p>
            ))}
            {data.canManage ? (
              <details className="mt-3">
                <summary>Schedule a tender policy</summary>
                <CommandForm
                  title="Tender authorization"
                  fields={[
                    { name: "orgUnitId", label: "Branch", options: branches },
                    {
                      name: "method",
                      label: "Tender",
                      options: [
                        "cash",
                        "gcash",
                        "maya",
                        "card",
                        "check",
                        "bank_transfer",
                        "credit",
                      ].map((id) => ({ id, label: word(id) })),
                    },
                    {
                      name: "label",
                      label: "Name shown on handheld and invoice",
                    },
                    {
                      name: "referenceLabel",
                      label: "Provider-reference prompt (never card number)",
                      optional: true,
                    },
                    {
                      name: "enabled",
                      label: "May accept this tender",
                      options: [
                        { id: "true", label: "Enabled" },
                        { id: "false", label: "Disabled" },
                      ],
                    },
                    {
                      name: "effectiveFrom",
                      label: "Effective from (Manila service date)",
                      type: "date",
                    },
                  ]}
                  onSubmit={(b) =>
                    command("tenders/save", {
                      ...b,
                      effectiveFrom:
                        String(b.effectiveFrom) + "T00:00:00+08:00",
                    })
                  }
                />
              </details>
            ) : null}
          </Panel>
          <Panel
            title="Series and offline reconciliation"
            question="Every reserved number stays assigned to its handheld, including unused, voided and spoiled numbers."
          >
            {data.series.map((s) => (
              <div
                key={String(s.id)}
                className="border-b border-border py-3 text-sm"
              >
                <strong>
                  {s.prefix} · {s.branch_name} · {word(s.document_type)}
                </strong>
                <p>
                  Approved range {s.first_serial}–{s.last_serial} · Next
                  allocation starts {s.next_allocate}
                </p>
                {data.allocations
                  .filter((a) => a.series_id === s.id)
                  .map((a) => (
                    <p key={String(a.id)}>
                      {a.seller}: reserved {a.first_serial}–{a.last_serial} ·{" "}
                      {a.accounted} accounted ·{" "}
                      {a.closure
                        ? `${word(a.closure.outcome)} · tail ${a.closure.first_unissued}–${a.closure.last_serial} permanently retired`
                        : `${Number(a.last_serial) - Number(a.next_issue) + 1} still reserved on handheld`}
                    </p>
                  ))}
              </div>
            ))}
            {data.canManage ? (
              <details className="mt-4">
                <summary className="cursor-pointer text-sm font-medium">
                  Reconcile numbers or add a series
                </summary>
                <CommandForm
                  title="Reconcile a retired phone’s unused numbers"
                  fields={[
                    {
                      name: "allocationId",
                      label: "Reserved range",
                      options: data.allocations
                        .filter(
                          (a) =>
                            !a.closure &&
                            Number(a.next_issue) <= Number(a.last_serial),
                        )
                        .map((a) => ({
                          id: String(a.id),
                          label: `${a.seller} · ${a.prefix} · ${a.next_issue}–${a.last_serial}`,
                        })),
                    },
                    {
                      name: "outcome",
                      label: "Reconciliation outcome",
                      options: [
                        {
                          id: "unused_reconciled",
                          label: "Unused tail independently reconciled",
                        },
                        {
                          id: "lost_unreconciled",
                          label: "Lost phone — tail unaccounted for",
                        },
                      ],
                    },
                    { name: "reason", label: "Reason" },
                    {
                      name: "evidenceReference",
                      label: "Reconciliation evidence reference",
                    },
                  ]}
                  onSubmit={(b) => command("allocations/retire", b)}
                />
                <p className="my-3 text-sm">
                  Suspend or retire the phone first. A different administrator
                  records the outcome. Numbers are never recycled; lost numbers
                  stay explicitly unaccounted for.
                </p>
                <CommandForm
                  title="Approved serial range (never recycled)"
                  fields={[
                    {
                      name: "registrationId",
                      label: "Registration",
                      options: data.registrations.map((r) => ({
                        id: r.id,
                        label: `${r.branch_name} · ${word(r.document_type)} · ${word(r.status)}`,
                      })),
                    },
                    {
                      name: "vehicleId",
                      label: "Van (blank means branch series)",
                      options: data.vehicles.map((v) => ({
                        id: v.id,
                        label: v.name,
                      })),
                      optional: true,
                    },
                    { name: "prefix", label: "Unique series prefix" },
                    {
                      name: "firstSerial",
                      label: "First approved serial",
                      type: "number",
                    },
                    {
                      name: "lastSerial",
                      label: "Last approved serial",
                      type: "number",
                    },
                    {
                      name: "effectiveFrom",
                      label: "Valid from",
                      type: "datetime-local",
                    },
                  ]}
                  onSubmit={(b) =>
                    command("series/create", {
                      ...b,
                      vehicleId: b.vehicleId || null,
                    })
                  }
                />
              </details>
            ) : null}
          </Panel>
          <Panel
            title="Document journal"
            question="Open an invoice to inspect its frozen tax facts and every void or reprint."
          >
            {data.documents.map((d) => (
              <button
                key={d.id}
                onClick={() => setSelected(d.id)}
                className="flex w-full justify-between border-b border-border py-3 text-left text-sm"
              >
                <span>
                  {d.document_number} · {d.branch_name} ·{" "}
                  {word(d.document_type)}
                </span>
                <span>
                  {formatPhp(d.snapshot.totalMinor)} ·{" "}
                  {d.journal.map((e) => word(e.kind)).join(" / ")}
                </span>
              </button>
            ))}
            {doc ? (
              <div className="mt-4 rounded-xl border border-border p-4 text-sm">
                <h3>{doc.document_number}</h3>
                <p>
                  {doc.snapshot.registration.sample
                    ? "Sample, not filed — not a tax document"
                    : "Registered document"}
                </p>
                <FiscalTaxSummary
                  documentType={doc.document_type}
                  tax={doc.snapshot.tax}
                />
                <p>
                  <FiscalPosting posting={doc.sap_posting} />
                </p>
                {doc.journal.map((e, i) => (
                  <p key={i}>
                    {word(e.kind)} — {e.reason}
                  </p>
                ))}
                <button className={button} onClick={() => setSelected(null)}>
                  Close
                </button>
              </div>
            ) : null}
          </Panel>
          <Panel
            title="Price and discount authority"
            question="A reason is always required. Above the value band, a different authorized person must approve."
          >
            {data.rules.map((r) => (
              <p
                key={String(r.id)}
                className="border-b border-border py-3 text-sm"
              >
                {r.branch_name} · {word(r.role)} ·{" "}
                {r.channel === "*" ? "All channels" : word(r.channel)} ·{" "}
                {overrideWord(r.kind)}: {formatPhp(r.min_centavos)}–
                {formatPhp(r.max_centavos)}, own limit{" "}
                {formatPhp(r.self_limit_centavos)}
                {data.canManage ? (
                  <button
                    className={`${button} ml-3`}
                    onClick={() => setEditingRule(r)}
                  >
                    Schedule replacement
                  </button>
                ) : null}
              </p>
            ))}
            {data.canManage ? (
              <details
                id="authority-editor"
                className="mt-4"
                open={editingRule ? true : undefined}
              >
                <summary className="cursor-pointer text-sm font-medium">
                  {editingRule
                    ? "Schedule policy replacement"
                    : "Add effective authority band"}
                </summary>
                {editingRule ? (
                  <p className="my-2 text-sm">
                    The previous policy remains until the replacement starts.{" "}
                    <button
                      className={button}
                      onClick={() => setEditingRule(null)}
                    >
                      Start a new band instead
                    </button>
                  </p>
                ) : null}
                <CommandForm
                  key={String(editingRule?.id ?? "new")}
                  title="Amounts in ₱; a replacement takes effect in the future"
                  fields={[
                    {
                      name: "orgUnitId",
                      label: "Branch scope",
                      options: branches,
                      value: String(editingRule?.org_unit_id ?? ""),
                    },
                    {
                      name: "kind",
                      label: "Override",
                      value: String(editingRule?.kind ?? "discount"),
                      options: [
                        "price",
                        "credit",
                        "stock",
                        "discount",
                        "void",
                      ].map((id) => ({ id, label: overrideWord(id) })),
                    },
                    {
                      name: "role",
                      label: "Requester role",
                      value: String(editingRule?.role ?? "sales"),
                      options: [
                        "sales",
                        "manager",
                        "operations",
                        "admin",
                        "super_admin",
                      ].map((id) => ({ id, label: word(id) })),
                    },
                    {
                      name: "channel",
                      label: "Channel code (or * for fallback)",
                      value: String(editingRule?.channel ?? "*"),
                    },
                    {
                      name: "approverGroup",
                      label: "Approver roles",
                      value: String(
                        editingRule?.approver_roles ??
                          "manager,approver,super_admin",
                      ),
                      options: [
                        "manager",
                        "approver",
                        "super_admin",
                        "manager,approver",
                        "manager,super_admin",
                        "approver,super_admin",
                        "manager,approver,super_admin",
                      ].map((id) => ({
                        id,
                        label: id.split(",").map(word).join(" or "),
                      })),
                    },
                    {
                      name: "offlineAllowed",
                      label: "Offline pre-authorized code",
                      value:
                        editingRule?.offline_allowed === true
                          ? "true"
                          : "false",
                      options: [
                        { id: "false", label: "Online approval only" },
                        {
                          id: "true",
                          label: "May issue a one-use offline code",
                        },
                      ],
                    },
                    {
                      name: "minAmount",
                      label: "Minimum amount (₱)",
                      type: "number",
                      step: "0.01",
                      value: authorityPeso(editingRule?.min_centavos ?? 0),
                    },
                    {
                      name: "maxAmount",
                      label: "Maximum amount (₱)",
                      type: "number",
                      step: "0.01",
                      value: authorityPeso(
                        editingRule?.max_centavos ?? 999999999,
                      ),
                    },
                    {
                      name: "ownAmount",
                      label: "Own approval limit (₱)",
                      type: "number",
                      step: "0.01",
                      value: authorityPeso(
                        editingRule?.self_limit_centavos ?? 0,
                      ),
                    },
                    {
                      name: "effectiveFrom",
                      label: "Effective from",
                      type: "datetime-local",
                    },
                    {
                      name: "effectiveTo",
                      label: "Effective until",
                      type: "datetime-local",
                      optional: true,
                    },
                  ]}
                  onSubmit={(b) =>
                    command("authority/save", {
                      ...b,
                      ...(editingRule ? { replacesId: editingRule.id } : {}),
                    })
                  }
                />
              </details>
            ) : null}
          </Panel>
        </>
      ) : null}
      {!decisionsOnly && !moneyOnly ? (
        <FiscalAudit allowed={data?.canAudit === true} />
      ) : null}
    </div>
  );
}
