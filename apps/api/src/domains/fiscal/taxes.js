import { integer, refuse } from "../van/model.js";
/** F-109/F-111: acknowledge payment, never recognize invoice tax a second time.
 * @param {any} invoiceTax */
export function collectionTaxReference(invoiceTax) {
  return {
    tax: null,
    taxRecognition: "payment_application_only",
    invoiceTax: invoiceTax ?? null,
  };
}
/** F-109: split governed line totals without changing the selling amount or repricing.
 * Positive-rate VAT, exempt and zero-rated are distinct; zero rate alone cannot name a treatment.
 * @param {any[]} lines @param {string} totalMinor */
export function invoiceTaxSnapshot(lines, totalMinor) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 100)
    refuse("Invoice tax lines need setup");
  let vatable = 0n,
    vat = 0n,
    exempt = 0n,
    zero = 0n,
    total = 0n;
  const rates = new Set(),
    details = [];
  for (const [i, l] of lines.entries()) {
    const gross = integer(l.totalMinor),
      bps = l.taxBasisPoints,
      kind = l.taxTreatment;
    if (
      !Number.isSafeInteger(bps) ||
      bps < 0 ||
      bps > 10000 ||
      typeof l.taxCode !== "string" ||
      !l.taxCode.length ||
      l.taxCode.length > 200 ||
      !["vatable", "exempt", "zero_rated"].includes(kind) ||
      (kind === "vatable") !== bps > 0
    )
      refuse("Each invoice line needs its governed tax treatment");
    let net = gross;
    if (kind === "vatable") {
      if (l.sourceTaxInclusive === false) {
        const sourceGross = integer(l.sourceSellingUnitMinor),
          sourceNet = integer(l.sourceNetUnitMinor);
        if (
          sourceNet > sourceGross ||
          (sourceGross === 0n && (sourceNet !== 0n || gross !== 0n))
        )
          refuse("SAP tax quote needs setup");
        net =
          sourceGross === 0n
            ? 0n
            : (gross * sourceNet + sourceGross / 2n) / sourceGross;
      } else if (l.sourceTaxInclusive === true) {
        const denominator = BigInt(10000 + bps);
        net = (gross * 10000n + denominator / 2n) / denominator;
      } else refuse("SAP tax quote needs setup");
      vatable += net;
      vat += gross - net;
      rates.add(bps);
    } else if (kind === "exempt") exempt += gross;
    else zero += gross;
    total += gross;
    details.push({
      lineNumber: i + 1,
      treatment: kind,
      taxCode: l.taxCode,
      rateBasisPoints: bps,
      netMinor: String(net),
      vatMinor: String(kind === "vatable" ? gross - net : 0n),
      totalMinor: String(gross),
      sourceKey: l.sapConditionKey ?? null,
      sourceVersion: l.sapConditionVersion ?? null,
    });
  }
  if (total !== integer(totalMinor) || vatable + vat + exempt + zero !== total)
    refuse("Invoice tax totals do not reconcile");
  return {
    inclusive: true,
    rateBasisPoints:
      rates.size === 1 ? [...rates][0] : rates.size === 0 ? 0 : null,
    vatableSalesMinor: String(vatable),
    vatMinor: String(vat),
    vatExemptMinor: String(exempt),
    zeroRatedMinor: String(zero),
    totalMinor: String(total),
    lines: details,
  };
}
