import { Fragment } from "react";
const PRIVILEGE_WORDS: Record<string, string> = {
  senior: "Senior citizen",
  pwd: "PWD",
  solo_parent: "Solo parent",
  athlete: "Athlete",
  uniformed: "Uniformed personnel",
};
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
  // IP-BIR: a senior/PWD/solo-parent/athlete/uniformed sale shows its discount and removed VAT as their own lines.
  const privilege =
    BigInt(
      /^\d{1,15}$/.test(String(t.privilegeDiscountMinor ?? ""))
        ? String(t.privilegeDiscountMinor)
        : "0",
    ) > 0n ||
    BigInt(
      /^\d{1,15}$/.test(String(t.vatRemovedMinor ?? ""))
        ? String(t.vatRemovedMinor)
        : "0",
    ) > 0n;
  const extra: (readonly [string, string])[] = privilege
    ? [
        [
          `${PRIVILEGE_WORDS[String(t.privilegeType)] ?? "Statutory"} discount`,
          "privilegeDiscountMinor",
        ],
        ["VAT removed on discounted sales", "vatRemovedMinor"],
      ]
    : [];
  return (
    <dl className="grid grid-cols-2 gap-1">
      {labels.map(([label, key]) => (
        <Fragment key={key}>
          <dt>{label}</dt>
          <dd>{money(t[key])}</dd>
        </Fragment>
      ))}
      {extra.map(([label, key]) => (
        <Fragment key={key}>
          <dt>{label}</dt>
          <dd>{money(t[key])}</dd>
        </Fragment>
      ))}
      {privilege ? (
        <p className="col-span-2 text-xs text-muted">
          Sales amounts above are before the discount. Amount paid:{" "}
          {money(t.totalMinor)}.
        </p>
      ) : null}
    </dl>
  );
}
