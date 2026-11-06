import { Peso } from "../peso";
import type { ReceiptModel } from "./receipt-types";

const n = (v: string | null | undefined) => Number(v ?? 0);
const when = (iso: string) =>
  new Intl.DateTimeFormat("en-PH", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Manila",
  }).format(new Date(iso));
const MISSING_WORDS: Record<string, string> = {
  ptuNumber: "Permit to Use (PTU) number",
  minNumber: "Machine ID (MIN)",
  machineSerial: "Machine serial number",
  accreditationNumber: "BIR accreditation number",
};

function Row({
  label,
  centavos,
  strong,
  negative,
}: {
  label: string;
  centavos: number;
  strong?: boolean;
  negative?: boolean;
}) {
  return (
    <div className={`flex justify-between gap-3 ${strong ? "font-bold" : ""}`}>
      <span>{label}</span>
      <span>
        {negative ? "−" : ""}
        <Peso centavos={centavos} />
      </span>
    </div>
  );
}

/**
 * The receipt exactly as printed: same model the handheld printer renders.
 * Every BIR field shows here: seller TIN, PTU/MIN/serial, invoice range, buyer name/TIN/address,
 * VATable / VAT / VAT-exempt / zero-rated, privilege discount lines, SC/PWD name and ID, change.
 */
export function ReceiptPreview({ model }: { model: ReceiptModel }) {
  const t = model.totals;
  const r = model.registration;
  const reprint = model.copy.kind === "reprint";
  return (
    <article
      aria-label={`${model.title} ${model.documentNumber}`}
      className="mx-auto w-full max-w-sm rounded-2xl border border-field-border bg-white p-5 font-mono text-[13px] leading-5 text-foreground shadow-sm"
    >
      {model.banner ? (
        <p className="mb-2 rounded-lg bg-warning-soft px-2 py-1 text-center font-bold">
          {model.banner}
        </p>
      ) : null}
      {model.status === "voided" ? (
        <p className="mb-2 rounded-lg bg-danger-soft px-2 py-1 text-center font-bold">
          VOID
        </p>
      ) : null}
      {reprint ? (
        <p className="mb-2 text-center font-bold">{model.copy.label}</p>
      ) : null}
      <header className="text-center">
        <p className="font-bold">{model.seller.entityName}</p>
        <p>{model.seller.branchName}</p>
        <p>{model.seller.address}</p>
        <p>
          {model.seller.tinLabel}: {model.seller.tin}
        </p>
        {r.minNumber ? <p>MIN: {r.minNumber}</p> : null}
        {r.machineSerial ? <p>Serial no.: {r.machineSerial}</p> : null}
        {r.ptuNumber ? (
          <p>
            PTU no.: {r.ptuNumber}
            {r.ptuIssuedOn ? ` (${r.ptuIssuedOn})` : ""}
          </p>
        ) : null}
        {r.accreditationNumber ? (
          <p>Accreditation no.: {r.accreditationNumber}</p>
        ) : null}
      </header>
      <hr className="my-3 border-dashed border-field-border" />
      <p className="text-center text-base font-bold">{model.title}</p>
      <p className="text-center">No. {model.documentNumber}</p>
      <p className="text-center text-xs">
        Series {model.range.firstNumber} to {model.range.lastNumber}
      </p>
      <p>Date: {when(model.issuedAt)}</p>
      {model.cashier ? <p>Cashier: {model.cashier}</p> : null}
      {model.place.store ? <p>Store: {model.place.store}</p> : null}
      {model.place.truck ? <p>Van: {model.place.truck}</p> : null}
      <hr className="my-3 border-dashed border-field-border" />
      <section aria-label="Buyer">
        <p>Sold to: {model.buyer.name ?? "—"}</p>
        <p>TIN: {model.buyer.tin ?? "—"}</p>
        <p>Address: {model.buyer.address ?? "—"}</p>
      </section>
      <hr className="my-3 border-dashed border-field-border" />
      <ul className="grid gap-2" aria-label="Items">
        {model.lines.map((l) => (
          <li key={l.n}>
            <div className="flex justify-between gap-3">
              <span>{l.description}</span>
              <span>
                <Peso centavos={n(l.grossMinor)} /> {l.taxLetter}
              </span>
            </div>
            <div className="text-xs text-muted">
              {l.qtyText} × <Peso centavos={n(l.unitPriceMinor)} />
              {l.freeQty > 0 ? ` + ${l.freeQty} free` : ""}
              {n(l.promoDiscountMinor) > 0 ? " · promo applied" : ""}
            </div>
          </li>
        ))}
      </ul>
      <hr className="my-3 border-dashed border-field-border" />
      <section aria-label="Totals" className="grid gap-1">
        <Row label="Sales" centavos={n(t.grossMinor)} />
        {model.discountLines.map((d) => (
          <Row
            key={d.kind}
            label={d.label}
            centavos={n(d.amountMinor)}
            negative
          />
        ))}
        <Row label="Amount due" centavos={n(t.totalDueMinor)} strong />
        {model.tenders.map((x) => (
          <Row
            key={x.method}
            label={`${x.label} received`}
            centavos={n(x.tenderedMinor ?? x.amountMinor)}
          />
        ))}
        <Row label="Change" centavos={n(t.changeMinor)} strong />
      </section>
      <hr className="my-3 border-dashed border-field-border" />
      <section aria-label="Tax" className="grid gap-1">
        <Row label="VATable sales" centavos={n(t.vatableSalesMinor)} />
        <Row label="VAT (12%)" centavos={n(t.vatMinor)} />
        <Row label="VAT-exempt sales" centavos={n(t.vatExemptSalesMinor)} />
        <Row label="Zero-rated sales" centavos={n(t.zeroRatedSalesMinor)} />
        {n(t.privilegeDiscountMinor) + n(t.vatRemovedMinor) > 0 ? (
          <p className="text-xs text-muted">
            Sales amounts are shown before the senior/PWD discount.
          </p>
        ) : null}
      </section>
      {model.privilege ? (
        <section
          aria-label="Discount holder"
          className="mt-3 rounded-lg bg-default-soft p-2"
        >
          <p className="font-bold">{model.privilege.label} discount</p>
          <p>Name: {model.privilege.holderName}</p>
          <p>ID no.: {model.privilege.idNumber}</p>
          <p className="mt-3">Signature: ______________________</p>
        </section>
      ) : null}
      <footer className="mt-3 grid gap-1 text-center text-xs text-muted">
        {model.footer.map((f) => (
          <p key={f}>{f}</p>
        ))}
        {reprint ? null : <p>{model.copy.label}</p>}
      </footer>
      {!model.compliance.complete ? (
        <p role="alert" className="mt-3 rounded-lg bg-warning-soft p-2 text-xs">
          This receipt is missing legal details:{" "}
          {model.compliance.missing
            .map((k) => MISSING_WORDS[k] ?? k)
            .join(", ")}
          . Ask the office to add them before using it as a BIR document.
        </p>
      ) : null}
    </article>
  );
}
