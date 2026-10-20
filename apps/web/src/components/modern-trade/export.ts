import type { Deduction } from "./model";
/** Money exports use the already authorized DTO, never raw IDs or internal audit payloads. */
export function safeCsv(rows: unknown[][]) {
  return (
    "\uFEFF" +
    rows
      .map((row) =>
        row
          .map((value) => {
            const raw = String(value ?? ""),
              safe = /^[\s]*[=+@-]/.test(raw) ? `'${raw}` : raw;
            return `"${safe.replaceAll('"', '""')}"`;
          })
          .join(","),
      )
      .join("\r\n") +
    "\r\n"
  );
}
export function deductionExport(rows: Deduction[]) {
  return [
    [
      "Account branch",
      "Remittance",
      "Invoice",
      "Type",
      "Amount centavos",
      "Status",
      "Owner",
      "Age days",
      "Due on",
      "Claim",
    ],
    ...rows.map((r) => [
      r.branchLabel,
      r.reference,
      r.invoice_number ?? "",
      r.type_label,
      r.amountCentavos,
      r.status,
      r.owner_name,
      r.age_days,
      r.due_on.slice(0, 10),
      r.claim_reference ?? "",
    ]),
  ];
}
