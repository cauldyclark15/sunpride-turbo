import { Fragment } from "react";
const money = (value: unknown) =>
  /^\d{1,13}$/.test(String(value))
    ? new Intl.NumberFormat("en-PH", {
        style: "currency",
        currency: "PHP",
      }).format(Number(value) / 100)
    : "Not recorded";
/** F-109: a payment OR is not another invoice-tax recognition; unknown is never displayed as zero. */
export function FiscalTaxSummary({
  documentType,
  tax,
}: {
  documentType: string;
  tax: unknown;
}) {
  if (documentType === "official_receipt")
    return (
      <p>
        Payment applied to the original invoice. No new invoice tax is
        recognized by this collection.
      </p>
    );
  if (tax === null || typeof tax !== "object" || Array.isArray(tax))
    return (
      <p>
        Tax snapshot is unavailable. Review the original document before
        printing.
      </p>
    );
  const t = tax as Record<string, unknown>;
  const labels = [
    ["VATable sales", "vatableSalesMinor"],
    ["VAT", "vatMinor"],
    ["VAT exempt", "vatExemptMinor"],
    ["Zero rated", "zeroRatedMinor"],
  ] as const;
  return (
    <dl className="grid grid-cols-2 gap-1">
      {labels.map(([label, key]) => (
        <Fragment key={key}>
          <dt>{label}</dt>
          <dd>{money(t[key])}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
