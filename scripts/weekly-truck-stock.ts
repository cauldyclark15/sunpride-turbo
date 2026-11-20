#!/usr/bin/env bun
/** SP-0227: preparation only. Print worksheets; never post stock or settle cash. */
import { resolve } from "node:path";
import { format } from "prettier";

export type StockLine = {
  productCode: string;
  productName: string;
  uom: string;
  decimalPlaces: number;
  requestedBase: number;
  servedBase: number | null;
  posSoldBase: number | null;
  countedBase: number | null;
  referenceUnitPriceMinor: number | null;
  posNetSalesMinor: number | null;
  batch: string;
  expiry: string;
  reason: string;
};
export type StockWeek = {
  reference: string;
  approvedPlanReference: string;
  weekStart: string;
  salesman: string;
  truck: string;
  issuingDepot: string;
  sapOrderReference: string;
  lines: StockLine[];
};

function text(value: unknown, label: string, required = false): string {
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    /[\u0000-\u001f]/u.test(value) ||
    (required && !value.trim())
  )
    throw new Error(`Enter ${label} (up to 200 characters).`);
  return value.trim();
}
function quantity(
  value: unknown,
  label: string,
  nullable = true,
): number | null {
  if (value === null && nullable) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`Enter a nonnegative whole number for ${label}.`);
  return value;
}

/** Missing counts remain unknown, never zero. Quantities are scaled integer units. */
export function parseWeek(input: unknown): StockWeek {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Supply one weekly worksheet object.");
  const p = input as Record<string, unknown>;
  const weekStart = text(p.weekStart, "Monday date", true);
  const date = new Date(`${weekStart}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(weekStart) ||
    !Number.isFinite(+date) ||
    date.toISOString().slice(0, 10) !== weekStart ||
    date.getUTCDay() !== 1
  )
    throw new Error("Use a valid Monday date (YYYY-MM-DD).");
  if (!Array.isArray(p.lines) || !p.lines.length || p.lines.length > 40)
    throw new Error("Supply 1 to 40 stock lines per worksheet pack.");
  const lines = p.lines.map((value: unknown): StockLine => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Each stock line must be an object.");
    const l = value as Record<string, unknown>;
    const decimalPlaces = quantity(l.decimalPlaces, "decimal places", false)!;
    if (decimalPlaces > 3) throw new Error("Use 0 to 3 decimal places.");
    return {
      productCode: text(l.productCode, "product code", true),
      productName: text(l.productName, "product name", true),
      uom: text(l.uom, "unit", true),
      decimalPlaces,
      requestedBase: quantity(l.requestedBase, "requested quantity", false)!,
      servedBase: quantity(l.servedBase, "served quantity"),
      posSoldBase: quantity(l.posSoldBase, "net POS quantity sold"),
      countedBase: quantity(l.countedBase, "counted remainder"),
      referenceUnitPriceMinor: quantity(
        l.referenceUnitPriceMinor,
        "reference price",
      ),
      posNetSalesMinor: quantity(l.posNetSalesMinor, "net POS sales"),
      batch: text(l.batch ?? "", "batch"),
      expiry: text(l.expiry ?? "", "expiry"),
      reason: text(l.reason ?? "", "reason"),
    };
  });
  const identities = lines.map((l) =>
    [l.productCode, l.uom, l.batch, l.expiry].join("\u0000"),
  );
  if (new Set(identities).size !== identities.length)
    throw new Error("Combine duplicate product, unit, batch and expiry lines.");
  // Product/UOM price and scale must agree even when stock is split across batches.
  const units = new Map<string, StockLine>();
  for (const l of lines) {
    const key = `${l.productCode}\u0000${l.uom}`;
    const previous = units.get(key);
    if (
      previous &&
      (previous.decimalPlaces !== l.decimalPlaces ||
        previous.referenceUnitPriceMinor !== l.referenceUnitPriceMinor)
    )
      throw new Error(
        "Keep the same scale and reference price for each product and unit.",
      );
    units.set(key, l);
  }
  return {
    reference: text(p.reference, "request reference", true),
    approvedPlanReference: text(
      p.approvedPlanReference,
      "approved plan reference",
      true,
    ),
    weekStart,
    salesman: text(p.salesman, "salesman", true),
    truck: text(p.truck, "truck", true),
    issuingDepot: text(p.issuingDepot, "issuing depot", true),
    sapOrderReference: text(p.sapOrderReference ?? "", "SAP order reference"),
    lines,
  };
}

export function scaled(value: bigint | null, decimals: number): string {
  if (value === null) return "Not recorded";
  const negative = value < 0n;
  const digits = (negative ? -value : value)
    .toString()
    .padStart(decimals + 1, "0");
  return `${negative ? "−" : ""}${decimals ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}` : digits}`;
}
/** Both alternatives remain visible; neither becomes an approved cashier charge. */
export function reconciliation(line: StockLine) {
  const counted = line.countedBase === null ? null : BigInt(line.countedBase);
  const served = line.servedBase === null ? null : BigInt(line.servedBase);
  const sold = line.posSoldBase === null ? null : BigInt(line.posSoldBase);
  const requestedBasis =
    counted === null ? null : BigInt(line.requestedBase) - counted;
  const servedBasis =
    served === null || counted === null ? null : served - counted;
  const price =
    line.referenceUnitPriceMinor === null
      ? null
      : BigInt(line.referenceUnitPriceMinor);
  const scale = 10n ** BigInt(line.decimalPlaces);
  const amount = (q: bigint | null) => {
    if (q === null || price === null || q < 0n) return null;
    const minor = q * price;
    // No invented financial rounding policy: an inexact centavo amount stays unavailable.
    return minor % scale === 0n ? minor / scale : null;
  };
  return {
    shortServed: served === null ? null : BigInt(line.requestedBase) - served,
    requestedBasis,
    servedBasis,
    posDifference:
      servedBasis === null || sold === null ? null : servedBasis - sold,
    requestedAmount: amount(requestedBasis),
    servedAmount: amount(servedBasis),
  };
}

const escape = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const blank = "________________";
const number = (v: number | null, places: number) =>
  scaled(v === null ? null : BigInt(v), places);
const money = (v: bigint | null) =>
  v === null ? "Not determined" : `PHP ${scaled(v, 2)}`;

/** Static, self-contained HTML: no network, scripts, credentials or persistence. */
export function renderWorksheets(week: StockWeek | null): string {
  const meta = week ?? {
    reference: blank,
    approvedPlanReference: blank,
    weekStart: blank,
    salesman: blank,
    truck: blank,
    issuingDepot: blank,
    sapOrderReference: blank,
  };
  const headers = `<dl>${[
    ["Request reference", meta.reference],
    ["Approved plan reference", meta.approvedPlanReference],
    ["Week starting Monday", meta.weekStart],
    ["Salesman", meta.salesman],
    ["Truck", meta.truck],
    ["Issuing depot / plant", meta.issuingDepot],
    ["SAP sales order", meta.sapOrderReference || blank],
  ]
    .map(([k, v]) => `<div><dt>${escape(k!)}</dt><dd>${escape(v!)}</dd></div>`)
    .join("")}</dl>`;
  const table = (columns: string[], cells: (l: StockLine) => string[]) => {
    const body = week
      ? week.lines
          .map(
            (l) =>
              `<tr>${cells(l)
                .map((v) => `<td>${escape(v)}</td>`)
                .join("")}</tr>`,
          )
          .join("")
      : Array.from(
          { length: 5 },
          () =>
            `<tr>${columns.map(() => "<td class=blank>&nbsp;</td>").join("")}</tr>`,
        ).join("");
    return `<table><thead><tr>${columns.map((c) => `<th scope=col>${escape(c)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table>`;
  };
  const identity = (l: StockLine) => [
    l.productCode,
    l.productName,
    l.uom,
    [l.batch, l.expiry].filter(Boolean).join(" / ") || "—",
  ];
  const base = ["Product code", "Product", "Unit", "Batch / expiry"];
  const page = (
    title: string,
    explanation: string,
    body: string,
    signatures: string,
  ) =>
    `<section class=sheet><p class=warning>WORKSHEET ONLY · PENDING SUNPRIDE CONFIRMATION · NOT A STOCK POSTING OR CASH SETTLEMENT</p><h1>${title}</h1><p>${explanation}</p>${headers}${body}<p class=signatures>${signatures}</p><footer>SP-0227 · Client meeting, 20 November 2026 · This is a preparation form, not an approved operating rule.</footer></section>`;
  const request = page(
    "1. Weekly stock request",
    "After plan approval: the sales encoder uses this request to create the SAP sales order. A plan reference written here is not proof that the plan has been approved.",
    table([...base, "Requested"], (l) => [
      ...identity(l),
      number(l.requestedBase, l.decimalPlaces),
    ]),
    "Requested by: __________________ Date: __________ · Plan checked by: __________________ · Encoder: __________________",
  );
  const served = page(
    "2. Monday loading — quantity actually served",
    "Record actual stock received next to requested stock. Do not treat the requested quantity as received. Keep the issuing depot and SAP sales order reference with the stock-in record.",
    table(
      [...base, "Requested", "Actually served", "Requested − served"],
      (l) => [
        ...identity(l),
        number(l.requestedBase, l.decimalPlaces),
        number(l.servedBase, l.decimalPlaces),
        scaled(reconciliation(l).shortServed, l.decimalPlaces),
      ],
    ),
    "Served by: __________________ · Received by: __________________ Date/time: __________________ · Stock-in reference: __________________",
  );
  const count = page(
    "3. Saturday weekly count and return",
    "Count at the depot or plant that issued the stock. POS quantity is net of returns and voids for this same week and request; it is a cross-check, not a physical count. Reasons are free text for discussion; no reason list has been approved.",
    table(
      [
        ...base,
        "Requested",
        "Served",
        "Net POS sold",
        "Counted remainder",
        "Served − counted − POS sold",
        "Reason / condition",
      ],
      (l) => [
        ...identity(l),
        number(l.requestedBase, l.decimalPlaces),
        number(l.servedBase, l.decimalPlaces),
        number(l.posSoldBase, l.decimalPlaces),
        number(l.countedBase, l.decimalPlaces),
        scaled(reconciliation(l).posDifference, l.decimalPlaces),
        l.reason || blank,
      ],
    ) +
      `<p>Return destination (same issuing depot / plant): ${escape(meta.issuingDepot)}</p><p>Return received quantity, batch, condition and storage status: _______________________________________________________</p><p>Do not automatically receive expired or damaged goods into saleable stock. Confirm the reason and disposition before posting. The next week uses a new stock request.</p>`,
    "Counted by: __________________ · Witnessed by: __________________ · Cold storage received by: __________________ · Stock-out / receipt references: __________________",
  );
  const cashier = page(
    "4. Cashier comparison — basis not confirmed",
    "NOT PAYABLE. Sunpride must confirm requested versus actually served as the cashier basis when loading is partial. Both alternatives are shown only for comparison; no amount is selected. A supplied reference price is not a confirmed cashier valuation rule.",
    table(
      [
        ...base,
        "Requested − counted",
        "Served − counted",
        "Reference price / unit",
        "Requested basis amount",
        "Served basis amount",
        "Net POS sales",
      ],
      (l) => {
        const r = reconciliation(l);
        return [
          ...identity(l),
          scaled(r.requestedBasis, l.decimalPlaces),
          scaled(r.servedBasis, l.decimalPlaces),
          money(
            l.referenceUnitPriceMinor === null
              ? null
              : BigInt(l.referenceUnitPriceMinor),
          ),
          money(r.requestedAmount),
          money(r.servedAmount),
          money(
            l.posNetSalesMinor === null ? null : BigInt(l.posNetSalesMinor),
          ),
        ];
      },
    ) +
      `<p>Amounts are unavailable when counts or price are missing, the result is negative, or centavos require a rounding rule. Negative quantity differences require investigation, not automatic write-off. Never total mixed product quantities.</p><p>Net POS sales can differ because of pricing, discounts, returns, voids, credit and taxes. This comparison is not proof of cash collected or remitted; reconcile those separately.</p><p>Confirmed cashier basis and valuation rule: ______________________________ · Confirmed by / date: ______________________________</p>`,
    "Prepared by: __________________ · Cashier reviewed by: __________________ · Differences investigated by: __________________",
  );
  return `<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width, initial-scale=1"><title>Weekly truck stock — preparation worksheets</title><style>
    @page { size: A4 landscape; margin: 12mm; }
    * { box-sizing: border-box; } body { font: 12px/1.45 Arial,sans-serif; color:#17212b; margin:0; background:#e9edf0; }
    .sheet { width:273mm; margin:16px auto; padding:12mm; background:white; break-after:page; } .sheet:last-child { break-after:auto; }
    h1 { font-size:23px; margin:10px 0; } p { margin:10px 0; } .warning { font-weight:bold; border:2px solid #7b3e00; padding:8px; color:#6b3500; }
    dl { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin:16px 0; } dt { color:#495867; font-size:10px; } dd { margin:0; overflow-wrap:anywhere; }
    table { width:100%; border-collapse:collapse; table-layout:fixed; font-size:10px; } th,td { border:1px solid #9ba5ae; padding:7px 4px; text-align:left; vertical-align:top; overflow-wrap:anywhere; }
    th { background:#edf1f4; } thead { display:table-header-group; } tr { break-inside:avoid; } td.blank { height:34px; }
    .signatures { margin-top:25px; line-height:2.2; } footer { border-top:1px solid #9ba5ae; margin-top:20px; padding-top:6px; font-size:10px; color:#495867; }
    @media print { body { background:white; } .sheet { width:auto; margin:0; padding:0; } }
  </style></head><body>${request}${served}${count}${cashier}</body></html>`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (
      !["--input", "--output"].includes(args[i]!) ||
      !args[i + 1] ||
      options.has(args[i]!)
    )
      throw new Error(
        "Usage: bun scripts/weekly-truck-stock.ts [--input worksheet.json] --output worksheet.html",
      );
    options.set(args[i]!, args[i + 1]!);
  }
  const output = options.get("--output");
  if (!output) throw new Error("Supply --output for the printable HTML file.");
  if (
    options.get("--input") &&
    resolve(options.get("--input")!) === resolve(output)
  )
    throw new Error("Output must not overwrite the input worksheet.");
  const input = options.get("--input");
  const week = input ? parseWeek(await Bun.file(input).json()) : null;
  await Bun.write(
    output,
    await format(renderWorksheets(week), { parser: "html" }),
  );
  console.log(`Preparation worksheet written: ${resolve(output)}`);
}
