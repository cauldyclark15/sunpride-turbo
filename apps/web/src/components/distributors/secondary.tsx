"use client";
import { useState } from "react";
import type {
  Command,
  Reconciliation,
  Secondary as SecondaryData,
  Workspace,
} from "./types";
import {
  ActionForm,
  Cell,
  Empty,
  Field,
  fieldClass,
  fileInput,
  manilaToday,
  money,
  Panel,
  State,
  Table,
  usePartnerQuery,
  value,
  when,
  words,
} from "./kit";
import { useSession } from "../../lib/auth/session";

export function Secondary({
  workspace,
  command,
  canWrite,
}: {
  workspace: Workspace;
  command: Command;
  canWrite: boolean;
}) {
  const id = workspace.distributor.id,
    query = usePartnerQuery<SecondaryData>(id, "secondary");
  const [mapKind, setMapKind] = useState("outlet");
  const options =
    mapKind === "outlet"
      ? workspace.outlets.map((x) => ({ id: x.id, label: x.name }))
      : mapKind === "location"
        ? workspace.locations.map((x) => ({ id: x.id, label: x.name }))
        : workspace.catalog.map((x) => ({ id: x.productId, label: x.name }));
  return (
    <>
      <p className="text-sm text-muted">
        Retailer invoices and returns are recorded at line level, using shared
        stores. Files and API connections use the same mappings and
        deduplication rules.
      </p>
      {canWrite ? (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <ActionForm
            title="Upload distributor invoices"
            submitLabel="Stage this file"
            detail="CSV uses the published header; JSON accepts canonical rows or nested invoice_json. Source reference must stay the same on retry."
            onSubmit={async (f) => {
              const file = fileInput(f),
                sourceKey = value(f, "source");
              if (file.size > 700000)
                throw new Error("Use a file below 700 KB.");
              const coverage =
                f.get("complete") === "on"
                  ? {
                      complete: true,
                      from: value(f, "from"),
                      to: value(f, "to"),
                    }
                  : {};
              const content = await file.text();
              if (file.name.toLowerCase().endsWith(".csv"))
                await command("secondary/stage", {
                  adapter: "csv",
                  sourceKey,
                  csv: content,
                  ...coverage,
                });
              else {
                const parsed = JSON.parse(content) as {
                  rows?: unknown[];
                  invoices?: unknown[];
                };
                await command(
                  "secondary/stage",
                  parsed.invoices
                    ? {
                        adapter: "invoice_json",
                        sourceKey,
                        invoices: parsed.invoices,
                        ...coverage,
                      }
                    : {
                        adapter: "canonical",
                        sourceKey,
                        rows: parsed.rows,
                        ...coverage,
                      },
                );
              }
            }}
          >
            <Field label="Source file reference">
              <input
                name="source"
                required
                className={fieldClass}
                placeholder="Your system's unique export reference"
              />
            </Field>
            <Field label="Invoice file">
              <input
                name="file"
                required
                type="file"
                accept=".csv,.json"
                className={fieldClass}
              />
            </Field>
            <a
              className="text-sm underline"
              href="/samples/distributors/secondary-sales.csv"
              download
            >
              Download sample invoice CSV
            </a>
            <a
              className="text-sm underline"
              href="/samples/distributors/secondary-invoices.json"
              download
            >
              Download sample nested API payload
            </a>
            <label className="text-sm">
              <input type="checkbox" name="complete" /> This export includes
              every invoice and return for the period below
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Complete period starts">
                <input
                  name="from"
                  type="date"
                  defaultValue={manilaToday()}
                  className={fieldClass}
                />
              </Field>
              <Field label="Complete period ends">
                <input
                  name="to"
                  type="date"
                  defaultValue={manilaToday()}
                  className={fieldClass}
                />
              </Field>
            </div>
          </ActionForm>
          <ActionForm
            title="Map an external code"
            submitLabel="Save mapping"
            detail="Map only to this distributor's assigned catalog, shared outlets or locations. Source rows remain unchanged."
            onSubmit={async (f) => {
              await command("maps", {
                kind: mapKind,
                externalCode: value(f, "code"),
                entityId: value(f, "entity"),
              });
            }}
          >
            <Field label="Code type">
              <select
                className={fieldClass}
                value={mapKind}
                onChange={(e) => setMapKind(e.target.value)}
              >
                <option value="outlet">Retailer</option>
                <option value="product">Product</option>
                <option value="location">Warehouse or van</option>
              </select>
            </Field>
            <Field label="Your system's code">
              <input name="code" required className={fieldClass} />
            </Field>
            <Field label="Map to">
              <select name="entity" required className={fieldClass}>
                {options.map((o) => (
                  <option value={o.id} key={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
          </ActionForm>
        </div>
      ) : null}
      <State query={query}>
        {(s) => (
          <>
            <Panel title="Import and rejection queue">
              {s.runs.length ? (
                <Table
                  headers={[
                    "Source",
                    "Posted / duplicate",
                    "Needs mapping",
                    "Rejected",
                    "Next action",
                  ]}
                >
                  {s.runs.map((r) => (
                    <tr key={r.id}>
                      <Cell>
                        {r.source_key}
                        <p className="text-xs text-muted">{words(r.adapter)}</p>
                      </Cell>
                      <Cell>
                        {r.posted} / {r.lines}
                      </Cell>
                      <Cell>{r.mapping}</Cell>
                      <Cell>{r.rejected}</Cell>
                      <Cell>
                        {canWrite ? (
                          <ActionForm
                            title="Validate and post"
                            submitLabel="Process or retry"
                            onSubmit={() =>
                              command("secondary/process", { runId: r.id })
                            }
                          >
                            <p className="text-xs text-muted">
                              Valid rows post once; mapping and rejection
                              reasons stay in the queue.
                            </p>
                          </ActionForm>
                        ) : (
                          "Ask a data operator"
                        )}
                      </Cell>
                    </tr>
                  ))}
                </Table>
              ) : (
                <Empty>No files staged. Download a sample file to start.</Empty>
              )}
              {s.runsTruncated ? (
                <p className="text-sm text-muted">
                  Showing the most recent 200 import runs.
                </p>
              ) : null}
              {s.queue.map((r) => (
                <div
                  key={r.id}
                  className="rounded-lg border border-border p-3 text-sm"
                >
                  <p className="font-medium">
                    {String(r.raw.invoiceNumber ?? "Invoice")} · line{" "}
                    {String(r.raw.lineKey ?? r.ordinal + 1)}
                  </p>
                  <p>{r.reason ?? "Ready for validation"}</p>
                  <p className="text-xs text-muted">
                    {words(r.status)} · source rows cannot be edited; remap or
                    upload a corrected revision.
                  </p>
                </div>
              ))}
              {s.queueTruncated ? (
                <p className="text-sm text-muted">
                  Showing the first 200 outstanding lines. More lines need
                  attention.
                </p>
              ) : null}
            </Panel>
            <Panel title="Secondary invoice lines">
              {s.rows.length ? (
                <Table
                  headers={[
                    "Invoice",
                    "Shared retailer",
                    "Product",
                    "Pieces",
                    "Amount",
                    "Stage",
                  ]}
                >
                  {s.rows.map((r) => (
                    <tr key={r.id}>
                      <Cell>
                        {r.invoice_number}
                        <p className="text-xs text-muted">
                          Line {r.line_key} · revision {r.revision} ·{" "}
                          {when(r.sale_date)}
                        </p>
                      </Cell>
                      <Cell>{r.outlet_name}</Cell>
                      <Cell>{r.product_name}</Cell>
                      <Cell>{r.quantity_base}</Cell>
                      <Cell>{money(r.amount_centavos)}</Cell>
                      <Cell>{words(r.kind)}</Cell>
                    </tr>
                  ))}
                </Table>
              ) : (
                <Empty>No accepted secondary invoices yet.</Empty>
              )}
              {s.next ? (
                <p className="text-sm text-muted">
                  More than 200 invoice lines exist. The connector API exposes
                  the continuation cursor; this is a partial view.
                </p>
              ) : (
                <a
                  className="text-sm underline"
                  href={`/api/v1/distributors/secondary?distributorId=${id}&format=csv`}
                >
                  Export accepted invoice lines
                </a>
              )}
            </Panel>
          </>
        )}
      </State>
    </>
  );
}
export function Reconcile({
  workspace,
  command,
  canWrite,
}: {
  workspace: Workspace;
  command: Command;
  canWrite: boolean;
}) {
  const [from, setFrom] = useState(manilaToday()),
    [to, setTo] = useState(manilaToday());
  const { profile } = useSession();
  const query = usePartnerQuery<Reconciliation>(
    workspace.distributor.id,
    `reconciliation?from=${from}&to=${to}`,
  );
  return (
    <>
      <Panel
        title="Does primary stock reconcile to retailer offtake?"
        detail="End-of-day opening stock + net primary shipments, transfers and adjustments − net secondary sales = closing stock. Missing snapshots stay unknown."
      >
        <div className="grid max-w-xl gap-4 sm:grid-cols-2">
          <Field label="Period starts">
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className={fieldClass}
            />
          </Field>
          <Field label="Period ends">
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className={fieldClass}
            />
          </Field>
        </div>
      </Panel>
      <State query={query}>
        {(r) => (
          <Panel
            title="Reconciliation exceptions first"
            detail={`Tolerance: ${r.toleranceBase} pieces. Opening ${r.openingPresent ? "received" : "missing"}; closing ${r.closingPresent ? "received" : "missing"}.`}
          >
            {r.rows.length ? (
              <Table
                headers={[
                  "Product",
                  "Opening",
                  "Primary net",
                  "Secondary net",
                  "Closing",
                  "Variance / next action",
                ]}
              >
                {[...r.rows]
                  .sort(
                    (a, b) =>
                      Number(a.status === "balanced") -
                      Number(b.status === "balanced"),
                  )
                  .map((row) => (
                    <tr key={row.productId}>
                      <Cell>{row.name}</Cell>
                      <Cell>{row.openingBase ?? "Unknown"}</Cell>
                      <Cell>{row.primaryBase}</Cell>
                      <Cell>{row.secondaryBase}</Cell>
                      <Cell>{row.closingBase ?? "Unknown"}</Cell>
                      <Cell>
                        <p className="font-medium">
                          {row.varianceBase ?? "Unknown"} pieces ·{" "}
                          {words(row.status)}
                        </p>
                        <p className="mt-1 text-xs text-muted">
                          {row.nextAction}
                        </p>
                        {row.review ? (
                          <p className="mt-2 text-xs">
                            {row.review.explanation} · {row.review.ownerName}
                            {row.review.stale
                              ? " · Sources changed; review again"
                              : ""}
                          </p>
                        ) : null}
                        {canWrite && row.status !== "incomplete" ? (
                          <ActionForm
                            title="Explain and assign"
                            submitLabel="Save review"
                            onSubmit={async (f) => {
                              await command("reconciliation/review", {
                                from,
                                to,
                                productId: row.productId,
                                contentHash: row.contentHash,
                                explanation: value(f, "explanation"),
                                assignedTo: profile?.id,
                                status: value(f, "status"),
                              });
                            }}
                          >
                            <Field label="Explanation">
                              <input
                                name="explanation"
                                required
                                className={fieldClass}
                              />
                            </Field>
                            <Field label="Review decision">
                              <select name="status" className={fieldClass}>
                                <option value="explained">
                                  Explained · assigned to me
                                </option>
                                <option value="accepted">
                                  Accepted · reviewed by me
                                </option>
                                <option value="disputed">
                                  Disputed · follow up by me
                                </option>
                              </select>
                            </Field>
                          </ActionForm>
                        ) : null}
                      </Cell>
                    </tr>
                  ))}
              </Table>
            ) : (
              <Empty>
                No source facts for this period. Synchronize primary movements
                and submit the exact stock snapshots.
              </Empty>
            )}
            <a
              className="text-sm underline"
              href={`/api/v1/distributors/reconciliation?distributorId=${workspace.distributor.id}&from=${from}&to=${to}&format=csv`}
            >
              Export this inventory bridge
            </a>
          </Panel>
        )}
      </State>
    </>
  );
}
