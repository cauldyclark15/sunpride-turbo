"use client";
import { useState } from "react";
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const money = (v: unknown) =>
  /^\d{1,13}$/.test(String(v))
    ? new Intl.NumberFormat("en-PH", {
        style: "currency",
        currency: "PHP",
      }).format(Number(v) / 100)
    : "Not recorded";
function units(q: unknown, s: unknown) {
  try {
    const qty = BigInt(String(q)),
      scale = BigInt(String(s));
    if (qty < 0n || scale <= 0n) return "Not recorded";
    const whole = qty / scale;
    let rem = qty % scale,
      tail = "";
    for (let i = 0; i < 6 && rem; i++) {
      rem *= 10n;
      tail += String(rem / scale);
      rem %= scale;
    }
    return rem ? `${qty}/${scale}` : String(whole) + (tail ? "." + tail : "");
  } catch {
    return "Not recorded";
  }
}
/** F-110/F-124: the reviewer sees the exact proposed line reductions, not opaque identifiers. */
export function OverrideFacts({ value }: { value: unknown }) {
  const f = object(value);
  if (f.kind === "commercial_discount")
    return (
      <section className="space-y-2 text-sm">
        <p>
          {String(f.sourceNumber)} · {String(f.customerCode)}
        </p>
        <p>
          Published original {money(f.subtotalCentavos)} · final{" "}
          {money(f.totalCentavos)} · governed free-goods value{" "}
          {money(f.giftValueCentavos)}
        </p>
        <p>
          Exact source quotation; current requester role, channel and value band
          are checked again before posting. Finance review does not change a
          governed base price.
        </p>
        {Array.isArray(f.lines) &&
          f.lines.slice(0, 100).map((value: unknown, i: number) => {
            const l = object(value);
            return (
              <p key={i}>
                {String(l.productName)} · {String(l.quantity)} {String(l.uom)} ·
                unit {money(l.unitPriceCentavos)} · net {money(l.totalCentavos)}
              </p>
            );
          })}
      </section>
    );
  if (f.kind === "sap_credit_exception")
    return (
      <section className="grid gap-2 text-sm">
        <p>
          One-document SAP credit exception ·{" "}
          {String(f.customerName ?? f.customerCode)}
        </p>
        <p>
          Requested amount {money(f.amountCentavos)} · account limit{" "}
          {money(f.limitCentavos)}
        </p>
        <p>
          SAP exposure at request {money(f.exposureCentavos)} · projected{" "}
          {money(f.projectedExposureCentavos)}
        </p>
        <p>
          Source {f.source === "sample" ? "SAMPLE mock SAP" : "SAP"} ·{" "}
          {Number.isFinite(Number(f.checkedAt))
            ? new Date(Number(f.checkedAt)).toLocaleString("en-PH", {
                timeZone: "Asia/Manila",
              })
            : "Check time unavailable"}
        </p>
        <p>Reason: {String(f.reason)}</p>
        <p>
          Finance approval alone does not permit this document. SAP must
          separately acknowledge the exception; its ordinary account limit
          remains unchanged.
        </p>
      </section>
    );
  if (f.version === 4 && f.kind === "stock" && Array.isArray(f.lines))
    return (
      <section className="overflow-x-auto">
        <p>
          {String(f.sourceNumber ?? "Stock correction")} · conservative current
          stock valuation for authority only
        </p>
        <table className="w-full text-left text-xs">
          <thead>
            <tr>
              <th>Product / stock location</th>
              <th>Before</th>
              <th>Proposed</th>
              <th>Value for approval</th>
            </tr>
          </thead>
          <tbody>
            {f.lines.slice(0, 100).map((value, i) => {
              const l = object(value);
              return (
                <tr key={i}>
                  <td>
                    {String(l.productName)} · {String(l.locationName)}
                  </td>
                  <td>
                    {units(l.expectedBase, l.quantityScale)} {String(l.uomCode)}
                  </td>
                  <td>
                    {units(l.countedBase, l.quantityScale)} {String(l.uomCode)}
                  </td>
                  <td>{money(l.valueMinor)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p>
          Total value for authority: {money(f.totalMinor)}. Actual inventory
          posting remains the canonical stock document.
        </p>
      </section>
    );
  if (![2, 3].includes(Number(f.version)) || !Array.isArray(f.lines))
    return (
      <p className="text-xs text-muted-foreground">
        Older request format. Check the source transaction in audit history
        before deciding.
      </p>
    );
  return (
    <div className="overflow-x-auto">
      {f.version === 3 && (
        <p>
          Requested {String(f.kind)} exception. Credit approval does not change
          SAP’s limit or replace its live reservation.
        </p>
      )}
      <table className="w-full text-left text-xs">
        <thead>
          <tr>
            <th>Product</th>
            <th>Quantity</th>
            {f.kind === "price" && <th>Original governed unit price</th>}
            <th>Unit price</th>
            <th>Before</th>
            <th>Reduction</th>
            <th>After</th>
          </tr>
        </thead>
        <tbody>
          {f.lines.slice(0, 100).map((v, i) => {
            const l = object(v);
            return (
              <tr key={i}>
                <td>
                  {String(l.productName ?? "Product")}
                  <br />
                  {String(l.productCode ?? "")}
                </td>
                <td>
                  {units(l.quantityBase, l.quantityScale)}{" "}
                  {String(l.uomCode ?? "")}
                </td>
                {f.kind === "price" && (
                  <td>{money(l.originalUnitPriceMinor)}</td>
                )}
                <td>{money(l.unitPriceMinor)}</td>
                <td>{money(l.grossMinor)}</td>
                <td>{money(l.discountMinor)}</td>
                <td>{money(l.totalMinor)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2">
        Proposed cart total: {money(f.totalMinor)}. A changed product, quantity,
        price, reduction or reason needs a fresh matching approval.
      </p>
    </div>
  );
}
/** This certificate contains no login token or private key; it authorizes only the reviewed request. */
export function ApprovalGrant({ grant }: { grant: string }) {
  const [message, setMessage] = useState("");
  return (
    <section className="grid gap-2 rounded-xl border border-border p-4 text-sm">
      <h3>Exact-cart offline approval</h3>
      <p>
        Only the requester can use this code. They can also select Check
        approval on the phone while online. It expires with this request and the
        server rechecks authority on upload.
      </p>
      <label>
        Approval code
        <textarea
          readOnly
          value={grant}
          onFocus={(e) => e.currentTarget.select()}
          rows={3}
          className="mt-1 w-full rounded border border-border p-2 text-xs"
        />
      </label>
      <button
        type="button"
        className="w-fit rounded border border-border px-3 py-2"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(grant);
            setMessage("Copied. Share only with the requester.");
          } catch {
            setMessage("Select the code and copy it using your browser.");
          }
        }}
      >
        Copy approval code
      </button>
      <p aria-live="polite">{message}</p>
    </section>
  );
}
