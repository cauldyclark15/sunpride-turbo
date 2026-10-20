"use client";
import { useState } from "react";
import { useApi } from "../../lib/api";
import type { Deduction, DeductionQueue, Options } from "./model";
import { deductionExport } from "./export";
import {
  ExportActions,
  Field,
  Form,
  Notice,
  action,
  dateText,
  inputClass,
  label,
  panel,
  php,
  text,
  useCommand,
} from "./kit";

export function DeductionWorkspace({
  options,
  canEdit,
  canApprove,
}: {
  options: Options;
  canEdit: boolean;
  canApprove: boolean;
}) {
  const query = useApi<DeductionQueue>(
      ["mt", "deductions"],
      "/api/v1/mt/deductions",
    ),
    cmd = useCommand(),
    [binding, setBinding] = useState(options.bindings[0]?.id ?? "");
  const [filter, setFilter] = useState("open");
  const rows = query.data?.rows.filter(
    (r) =>
      filter === "all" ||
      (filter === "overdue"
        ? r.overdue_days > 0 && r.status !== "resolved"
        : r.status !== "resolved"),
  );
  return (
    <div className="grid gap-5">
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          ["Open deductions", php(query.data?.summary.openCentavos)],
          ["Past SLA", query.data?.summary.overdue ?? "Loading…"],
          [
            "Claim or dispute needed",
            query.data?.summary.unlinked ?? "Loading…",
          ],
        ].map(([k, v]) => (
          <div className={panel} key={k}>
            <p className="text-sm text-muted">{k}</p>
            <p className="mt-2 text-2xl font-semibold">{v}</p>
            <p className="mt-2 text-xs text-muted">
              {k === "Past SLA"
                ? "Target: no overdue cases. Assign an owner and follow up."
                : "Current work queue · open a case below for the next action."}
            </p>
          </div>
        ))}
      </div>
      {query.data?.flow ? (
        <section className={panel}>
          <h2 className="font-semibold">Are new deductions rising?</h2>
          <p className="mt-2 text-sm">
            Last 28 days: {php(query.data.flow.last28Centavos)} · Prior 28 days:{" "}
            {php(query.data.flow.prior28Centavos)}
          </p>
          <p className="mt-1 text-xs text-muted">
            Received deduction value, including resolved cases. This is not a
            historical open-balance comparison.
          </p>
          <div className="mt-4 grid grid-cols-4 gap-2 md:grid-cols-8">
            {query.data.flow.weekly.map((w) => (
              <div
                className="rounded-lg border border-border p-2 text-xs"
                key={w.from}
              >
                <p className="text-muted">{dateText(w.from)}</p>
                <p className="mt-2 font-medium">{php(w.amountCentavos)}</p>
                <p>{w.count} cases</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {query.error ? <Notice>{query.error.message}</Notice> : null}
      {cmd.error ? <Notice>{cmd.error}</Notice> : null}
      {canEdit ? (
        <details className={panel}>
          <summary className="cursor-pointer font-semibold">
            Capture a remittance deduction
          </summary>
          <div className="mt-4">
            <Form
              onSubmit={async (f) => {
                await cmd.run("/api/v1/mt/remittances/capture", {
                  bindingId: binding,
                  reference: text(f, "reference"),
                  receivedOn: text(f, "date"),
                  grossCentavos: Number(text(f, "gross")),
                  paidCentavos: Number(text(f, "paid")),
                  deductions: [
                    {
                      typeId: text(f, "type"),
                      amountCentavos: Number(text(f, "deduction")),
                      invoiceId: text(f, "invoice") || null,
                      ownerProfileId: text(f, "owner"),
                      claimReference: text(f, "claim") || null,
                    },
                  ],
                });
              }}
            >
              <div className="grid gap-3 md:grid-cols-3">
                <Field label="Account branch">
                  <select
                    className={inputClass}
                    value={binding}
                    onChange={(e) => setBinding(e.target.value)}
                  >
                    {options.bindings.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Remittance reference">
                  <input name="reference" required className={inputClass} />
                </Field>
                <Field label="Received on">
                  <input
                    name="date"
                    type="date"
                    required
                    className={inputClass}
                  />
                </Field>
                {[
                  ["gross", "Gross remittance"],
                  ["paid", "Cash received"],
                  ["deduction", "Deduction"],
                ].map(([k, s]) => (
                  <Field key={k} label={`${s} · centavos`}>
                    <input
                      name={k}
                      type="number"
                      min="0"
                      step="1"
                      required
                      className={inputClass}
                    />
                  </Field>
                ))}
                <Field label="Type">
                  <select name="type" required className={inputClass}>
                    {options.types.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label} · {t.sla_days} days
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Invoice">
                  <select name="invoice" className={inputClass}>
                    <option value="">Not linked yet</option>
                    {options.invoices
                      .filter((i) => i.binding_id === binding)
                      .map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.invoice_number}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="Owner">
                  <select name="owner" required className={inputClass}>
                    {options.owners.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Underlying claim reference">
                  <input name="claim" className={inputClass} />
                </Field>
              </div>
              <p className="text-sm text-muted">
                Paid plus all deductions must equal the gross remittance. This
                captures evidence; SAP settles the invoice.
              </p>
              <button className={action} disabled={cmd.pending}>
                Capture deduction
              </button>
            </Form>
          </div>
        </details>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Resolve exceptions first</h2>
        <select
          className="rounded-lg border border-border p-2 text-sm"
          aria-label="Queue filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="open">Open cases</option>
          <option value="overdue">Past SLA</option>
          <option value="all">All cases</option>
        </select>
      </div>
      {rows ? (
        <ExportActions name="account-deductions" rows={deductionExport(rows)} />
      ) : null}
      {rows?.map((r) => (
        <DeductionCase
          key={`${r.id}:${r.status}:${r.owner_profile_id}:${r.disputes.length}`}
          row={r}
          options={options}
          canEdit={canEdit}
          canApprove={canApprove}
        />
      ))}
      {rows?.length === 0 ? (
        <Notice>
          No cases in this view. There may be resolved cases in the archive.
        </Notice>
      ) : null}
    </div>
  );
}
export function DeductionCase({
  row: r,
  options,
  canEdit,
  canApprove,
}: {
  row: Deduction;
  options: Options;
  canEdit: boolean;
  canApprove: boolean;
}) {
  const cmd = useCommand();
  return (
    <article className={panel}>
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h3 className="font-semibold">
            {r.branchLabel} · {r.type_label}
          </h3>
          <p className="text-sm text-muted">
            {r.reference} · {r.invoice_number ?? "Invoice not linked"} ·{" "}
            {label(r.status)}
          </p>
        </div>
        <p className="text-xl font-semibold">{php(r.amountCentavos)}</p>
      </div>
      <p className="my-3 text-sm">
        {r.owner_name} · Age {r.age_days} days · Due {dateText(r.due_on)}
        {r.overdue_days > 0 && r.status !== "resolved"
          ? ` · ${r.overdue_days} days past SLA`
          : ""}
      </p>
      <p className="mb-3 text-sm text-muted">
        {r.claim_reference
          ? `Claim: ${r.claim_reference}`
          : "Next action: link the underlying claim or review the customer dispute."}
      </p>
      {cmd.error ? <Notice>{cmd.error}</Notice> : null}
      {r.status !== "resolved" && (canEdit || canApprove) ? (
        <details>
          <summary className="cursor-pointer text-sm underline">
            Assign, classify or resolve
          </summary>
          <div className="mt-3">
            <Form
              onSubmit={async (f) => {
                await cmd.run("/api/v1/mt/deductions/update", {
                  id: r.id,
                  ownerProfileId: text(f, "owner") || r.owner_profile_id,
                  typeId: text(f, "type") || r.type_id,
                  claimReference: text(f, "claim"),
                  note: text(f, "note"),
                  resolve: f.get("resolve") === "on",
                });
              }}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Owner">
                  <select
                    className={inputClass}
                    name="owner"
                    defaultValue={r.owner_profile_id}
                  >
                    {options.owners.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Deduction type">
                  <select
                    className={inputClass}
                    name="type"
                    defaultValue={r.type_id}
                  >
                    {options.types.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Claim reference">
                  <input
                    name="claim"
                    defaultValue={r.claim_reference ?? ""}
                    className={inputClass}
                  />
                </Field>
                <Field label="Work note">
                  <input name="note" required className={inputClass} />
                </Field>
              </div>
              {canApprove ? (
                <label className="text-sm">
                  <input
                    name="resolve"
                    type="checkbox"
                    defaultChecked={!canEdit}
                  />{" "}
                  Mark resolved after review
                </label>
              ) : null}
              <button className={action} disabled={cmd.pending}>
                Save case update
              </button>
            </Form>
          </div>
        </details>
      ) : null}
      {r.disputes.map((d) => (
        <div className="mt-4 border-t border-border pt-4 text-sm" key={d.id}>
          <p className="font-medium">
            Customer dispute · {d.reference} · {label(d.status)}
          </p>
          <p className="my-2">{d.message}</p>
          {d.response ? <p>Account team: {d.response}</p> : null}
          {d.status === "open" && canApprove ? (
            <Form
              onSubmit={async (f) => {
                await cmd.run("/api/v1/mt/disputes/respond", {
                  id: d.id,
                  deductionId: r.id,
                  status: text(f, "status"),
                  response: text(f, "response"),
                });
              }}
            >
              <Field label="Response visible to the customer">
                <textarea name="response" required className={inputClass} />
              </Field>
              <Field label="Decision">
                <select name="status" className={inputClass}>
                  <option value="accepted">
                    Accept dispute for SAP settlement review
                  </option>
                  <option value="rejected">
                    Reject dispute with explanation
                  </option>
                </select>
              </Field>
              <button className={action} disabled={cmd.pending}>
                Send response
              </button>
            </Form>
          ) : null}
        </div>
      ))}
      <details className="mt-4 text-sm">
        <summary className="cursor-pointer">Case history</summary>
        {r.events.map((e, i) => (
          <p className="mt-2" key={i}>
            {dateText(e.created_at)} · {label(e.action)} · {e.note}
          </p>
        ))}
      </details>
    </article>
  );
}
