"use client";
import { useState } from "react";
import { useApi } from "../../lib/api";
import { filePayload, downloadDocument } from "./documents";
import type { Intake, Options } from "./model";
import { OcrReview } from "./ocr-review";
import {
  ExportActions,
  Field,
  Form,
  Notice,
  action,
  dateText,
  inputClass,
  panel,
  php,
  text,
  useCommand,
} from "./kit";

export function IntakeConsole({
  options,
  canEdit,
}: {
  options: Options;
  canEdit: boolean;
}) {
  const query = useApi<{ rows: Intake[] }>(
    ["mt", "intake"],
    "/api/v1/mt/intake",
  );
  const [selected, setSelected] = useState<string | null>(null),
    cmd = useCommand();
  const current = query.data?.rows.find((r) => r.id === selected);
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(260px,1fr)_minmax(0,2fr)]">
      <aside className="grid content-start gap-4">
        {canEdit ? (
          <section className={panel}>
            <h2 className="mb-4 text-lg font-semibold">
              Receive a purchase order
            </h2>
            <Form
              onSubmit={async (f) => {
                const file = f.get("document");
                if (!(file instanceof File) || !file.size) return;
                if (file.size > 450000) {
                  return;
                }
                const r = await cmd.run("/api/v1/mt/intake/preview", {
                  bindingId: text(f, "binding"),
                  format: text(f, "format"),
                  ...(await filePayload(file)),
                });
                if (r) setSelected(r.id);
              }}
            >
              <Field label="Account branch">
                <select
                  name="binding"
                  required
                  className={inputClass}
                  style={{ paddingRight: "2.5rem", textOverflow: "ellipsis" }}
                >
                  {options.bindings.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Document format">
                <select name="format" className={inputClass}>
                  <option value="csv">CSV / portal export</option>
                  <option value="edi">Sample EDI-like file</option>
                  <option value="email">Structured email</option>
                  <option value="ocr">Scanned document · manual review</option>
                </select>
              </Field>
              <Field label="Original document · maximum 450 KB">
                <input
                  name="document"
                  type="file"
                  required
                  accept=".csv,.txt,.eml,.edi,.pdf,.png,.jpg"
                  onChange={(e) =>
                    e.currentTarget.setCustomValidity(
                      (e.currentTarget.files?.[0]?.size ?? 0) > 450000
                        ? "Choose a document under 450 KB"
                        : "",
                    )
                  }
                />
              </Field>
              <button className={action} disabled={cmd.pending}>
                Preview purchase order
              </button>
            </Form>
            <p className="mt-3 text-xs text-muted">
              Upload a retailer export or structured email. Scans need manual
              review; you can download the unchanged original.
            </p>
          </section>
        ) : null}
        {cmd.error ? <Notice>{cmd.error}</Notice> : null}
        {query.error ? <Notice>{query.error.message}</Notice> : null}
        <section className={panel}>
          <h2 className="font-semibold">Intake queue</h2>
          {query.data ? (
            <ExportActions
              name="purchase-orders"
              rows={[
                ["PO number", "Account branch", "Status", "Received on"],
                ...query.data.rows.map((r) => [
                  r.po_number,
                  r.branchLabel,
                  r.status,
                  dateText(r.created_at),
                ]),
              ]}
            />
          ) : null}
          <p className="mb-3 text-sm text-muted">
            Review exceptions before confirming. Existing orders stay in the
            Orders workspace.
          </p>
          {query.data?.rows.map((r) => (
            <button
              className="grid w-full gap-1 border-b border-border py-3 text-left text-sm"
              key={r.id}
              onClick={() => setSelected(r.id)}
            >
              <span className="font-medium">
                {r.po_number || "PO number needs review"}
              </span>
              <span>
                {r.branchLabel} ·{" "}
                {r.status === "confirmed" ? "Confirmed" : "Needs review"}
              </span>
              <span className="text-xs text-muted">
                {dateText(r.created_at)}
              </span>
            </button>
          ))}
          {query.data?.rows.length === 0 ? (
            <p className="text-sm text-muted">
              No purchase orders received yet.
            </p>
          ) : null}
        </section>
      </aside>
      <section className={panel}>
        {current ? (
          <IntakeEditor
            key={`${current.id}:${current.revision}`}
            row={current}
            canEdit={canEdit}
          />
        ) : (
          <div className="py-12 text-center">
            <h2 className="text-xl font-semibold">Which PO needs attention?</h2>
            <p className="mt-2 text-sm text-muted">
              Upload a document or choose a purchase order to review its lines
              and exceptions.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
export function IntakeEditor({
  row,
  canEdit,
}: {
  row: Intake;
  canEdit: boolean;
}) {
  const [lines, setLines] = useState(row.lines),
    cmd = useCommand();
  const [headerDirty, setHeaderDirty] = useState(false);
  const dirty =
    headerDirty || JSON.stringify(lines) !== JSON.stringify(row.lines);
  const editable = canEdit && row.status === "review";
  const priceReviewComplete =
    lines.length > 0 &&
    lines.every(
      (l) => l.approvedUnitPriceCentavos != null && l.grossCentavos != null,
    );
  const rawGross = priceReviewComplete
    ? lines.reduce((n, l) => n + (l.grossCentavos ?? 0), 0)
    : null;
  const grossTotal =
    rawGross !== null && Number.isSafeInteger(rawGross) ? rawGross : null;
  async function original() {
    await downloadDocument("/api/v1/mt/intake/document", row.id);
  }
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">
            {row.po_number || "Review purchase order"}
          </h2>
          <p className="text-sm text-muted">{row.branchLabel}</p>
        </div>
        {canEdit ? (
          <button
            className={action}
            onClick={() => void original().catch(() => undefined)}
          >
            Download original
          </button>
        ) : null}
      </div>
      <OcrReview extraction={row.extraction} />
      {row.exceptions.map((e, i) => (
        <Notice key={i}>{e}</Notice>
      ))}
      {cmd.error ? <Notice>{cmd.error}</Notice> : null}
      <Form
        onSubmit={async (f) => {
          await cmd.run("/api/v1/mt/intake/fix", {
            id: row.id,
            revision: row.revision,
            poNumber: text(f, "po"),
            serviceDate: text(f, "date"),
            lines: lines.map((l) => ({
              productCode: l.productCode,
              uom: l.uom,
              quantity: l.quantity,
              requestedPriceCentavos: l.requestedPriceCentavos,
            })),
          });
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="PO number">
            <input
              className={inputClass}
              name="po"
              defaultValue={row.po_number ?? ""}
              onChange={() => setHeaderDirty(true)}
              readOnly={!editable}
              required
            />
          </Field>
          <Field label="Requested delivery date">
            <input
              className={inputClass}
              type="date"
              name="date"
              defaultValue={row.service_date?.slice(0, 10) ?? ""}
              onChange={() => setHeaderDirty(true)}
              readOnly={!editable}
              required
            />
          </Field>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {[
                  "Product code",
                  "Unit",
                  "Quantity",
                  "PO price · PHP centavos (optional)",
                  "Validation",
                ].map((s) => (
                  <th className="p-2 font-medium" key={s}>
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i} className="border-t border-border">
                  {(
                    [
                      "productCode",
                      "uom",
                      "quantity",
                      "requestedPriceCentavos",
                    ] as const
                  ).map((k) => (
                    <td key={k} className="min-w-24 p-2">
                      <input
                        aria-label={`${k === "requestedPriceCentavos" ? "PO price" : k} line ${i + 1}`}
                        className={inputClass}
                        value={l[k] ?? ""}
                        readOnly={!editable}
                        type={
                          k === "quantity" || k === "requestedPriceCentavos"
                            ? "number"
                            : "text"
                        }
                        min="0"
                        step={k === "quantity" ? "0.001" : "1"}
                        onChange={(e) =>
                          setLines(
                            lines.map((x, n) =>
                              n === i
                                ? {
                                    ...x,
                                    [k]:
                                      k === "quantity"
                                        ? Number(e.target.value)
                                        : k === "requestedPriceCentavos"
                                          ? e.target.value === ""
                                            ? null
                                            : Number(e.target.value)
                                          : e.target.value,
                                  }
                                : x,
                            ),
                          )
                        }
                      />
                      {k === "productCode" && l.productName ? (
                        <p className="mt-1 text-xs text-muted">
                          {l.productName}
                        </p>
                      ) : null}
                    </td>
                  ))}
                  <td className="min-w-36 p-2">
                    {l.exceptions.length ? l.exceptions.join(" · ") : "Ready"}
                    <p className="mt-2 text-xs text-muted">
                      {dirty ? (
                        "Save changes to recheck prices"
                      ) : row.status === "confirmed" &&
                        l.approvedUnitPriceCentavos == null ? (
                        "See commercial order for final prices"
                      ) : (
                        <>
                          Approved unit: {php(l.approvedUnitPriceCentavos)}
                          <br />
                          Gross before offers: {php(l.grossCentavos)}
                        </>
                      )}
                    </p>
                  </td>
                  {editable ? (
                    <td>
                      <button
                        type="button"
                        className={action}
                        onClick={() =>
                          setLines(lines.filter((_, n) => n !== i))
                        }
                      >
                        Remove
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-sm font-medium">
          Gross before offers:{" "}
          {dirty
            ? "Save changes to recheck"
            : grossTotal === null
              ? "Revalidate to review prices"
              : php(grossTotal)}
          . Final offers and credit are checked in Orders.
        </p>
        {editable ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={action}
              onClick={() =>
                setLines([
                  ...lines,
                  {
                    productCode: "",
                    uom: "PC",
                    quantity: 1,
                    requestedPriceCentavos: null,
                    exceptions: [],
                  },
                ])
              }
            >
              Add line
            </button>
            <button disabled={cmd.pending} className={action}>
              Save fixes & validate
            </button>
            <button
              type="button"
              disabled={
                cmd.pending ||
                dirty ||
                !priceReviewComplete ||
                row.exceptions.length > 0 ||
                row.lines.some((l) => l.exceptions.length > 0)
              }
              className={`${action} bg-foreground text-background`}
              onClick={() =>
                void cmd.run("/api/v1/mt/intake/confirm", {
                  id: row.id,
                  revision: row.revision,
                })
              }
            >
              Confirm into Orders
            </button>
          </div>
        ) : null}
      </Form>
      <p className="text-xs text-muted">
        Empty PO price means use the approved account price. Save any edits
        before confirming; confirmation rechecks the current approved
        conditions.
      </p>
      {row.order_id ? (
        <a
          className="text-sm underline"
          href={`/orders?orderId=${row.order_id}`}
        >
          Open the commercial order →
        </a>
      ) : null}
    </div>
  );
}
