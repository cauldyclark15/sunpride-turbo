/**
 * IP-BIR: printer-neutral receipt model for a sales invoice / official receipt / credit memo.
 * One shape for the web preview and the handheld printer. Built ONLY from the immutable fiscal document
 * snapshot plus the registration's BIR identifiers, so a reprint always carries the original's facts.
 *
 * Money is integer centavos as decimal strings ("2786" = ₱27.86). No device text, no UUID shown to people.
 * contentHash = sha256 of the model without its `copy` block and void status: an original and any reprint share it.
 */
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { PRIVILEGE_RATE_BPS } from "./privilege.js";
import { privilegeLabel } from "./legal-sale.js";
import { refuse } from "../van/model.js";

export const NOT_FILED_BANNER = "NOT FILED - SAMPLE";
const TITLES = /** @type {Record<string,string>} */ ({
  sales_invoice: "SALES INVOICE",
  official_receipt: "OFFICIAL RECEIPT",
  credit_memo: "CREDIT MEMO",
  delivery_receipt: "DELIVERY RECEIPT",
});
const s = (/** @type {any} */ v, d = "0") =>
  v === undefined || v === null || v === "" ? d : String(v);
const big = (/** @type {any} */ v) => BigInt(s(v));
const dateOnly = (/** @type {any} */ v) =>
  v ? new Date(v).toISOString().slice(0, 10) : null;
const letter = (/** @type {any} */ t) =>
  t === "exempt" ? "E" : t === "zero_rated" ? "Z" : "V";

/** @param {any} q */
function qtyOf(q) {
  const caseBase = q.caseBase ? Number(q.caseBase) : 0;
  const scale = Number(q.quantityScale ?? 1) || 1;
  const paid = Number(q.paidBase ?? q.quantityBase ?? 0);
  if (caseBase > 1 && scale === 1) {
    const cases = Math.floor(paid / caseBase),
      pcs = paid % caseBase;
    const text = [cases ? `${cases} cs` : "", pcs || !cases ? `${pcs} pc` : ""]
      .filter(Boolean)
      .join(" ");
    return { qty: paid, qtyText: text, uom: q.uomCode ?? "PC" };
  }
  const qty = paid / scale;
  return {
    qty,
    qtyText: `${qty} ${q.uomCode ?? ""}`.trim(),
    uom: q.uomCode ?? "",
  };
}

/** Normalise store and van snapshot lines into one line shape. @param {any} snap */
function printLines(snap) {
  return (snap.lines ?? []).map(
    (/** @type {any} */ l, /** @type {number} */ i) => {
      const van = l.grossMinor !== undefined;
      if (van) {
        const q = qtyOf(l);
        return {
          n: i + 1,
          productCode: l.code ?? null,
          description: l.name ?? l.code ?? "Item",
          ...q,
          freeQty: Number(l.freeBase ?? 0),
          unitPriceMinor: s(l.unitPriceMinor),
          grossMinor: s(l.grossMinor),
          promoDiscountMinor: s(l.discountMinor),
          payableMinor: s(l.totalMinor),
          taxLetter: letter(l.taxTreatment),
          privilegeType: l.privilegeType ?? null,
        };
      }
      const gross =
        BigInt(l.lineTotalCentavos ?? 0) + BigInt(l.discountCentavos ?? 0);
      const privTotal =
        BigInt(l.privilegeDiscountCentavos ?? 0) +
        BigInt(l.vatRemovedCentavos ?? 0);
      return {
        n: i + 1,
        productCode: l.productCode ?? null,
        description: l.description ?? l.productCode ?? "Item",
        qty: Number(l.quantity ?? 0),
        qtyText: `${l.quantity ?? 0} ${l.uom ?? ""}`.trim(),
        uom: l.uom ?? "",
        freeQty: 0,
        unitPriceMinor: s(l.unitPriceCentavos),
        grossMinor: String(gross),
        promoDiscountMinor: String(
          BigInt(l.discountCentavos ?? 0) - privTotal < 0n
            ? 0n
            : BigInt(l.discountCentavos ?? 0) - privTotal,
        ),
        payableMinor: s(l.lineTotalCentavos),
        taxLetter: letter(l.taxTreatment),
        privilegeType: l.privilegeType ?? null,
      };
    },
  );
}

/** @param {any} snap */
function tendersOf(snap) {
  if (Array.isArray(snap.tenders))
    return snap.tenders.map((/** @type {any} */ t) => ({
      method: t.method,
      label: t.label ?? t.method,
      amountMinor: s(t.amountCentavos),
      tenderedMinor: t.tenderedCentavos ?? null,
      changeMinor: s(t.changeCentavos),
      reference: t.reference ?? null,
    }));
  const p = snap.payment;
  if (p)
    return [
      {
        method: p.kind,
        label: p.label ?? p.kind,
        amountMinor: s(p.amountMinor),
        tenderedMinor: p.tenderedMinor ?? null,
        changeMinor: s(p.changeMinor),
        reference: p.reference ?? null,
      },
    ];
  return [];
}

/**
 * Pure builder (no database): used by the route and by tests with fixture rows.
 * @param {{doc:any,series:any,registration:any,voided?:boolean,copy?:{kind:'original'|'reprint',number:number}}} q
 */
export function buildPrintModel({
  doc,
  series,
  registration: reg,
  voided = false,
  copy,
}) {
  const snap = doc.snapshot ?? {};
  const tax = snap.tax ?? {};
  const type = reg.document_type;
  const notFiled = reg.sample === true || reg.status !== "approved";
  const missing = [];
  if (!notFiled) {
    if (!reg.ptu_number) missing.push("ptuNumber");
    if (!reg.min_number) missing.push("minNumber");
    if (!reg.machine_serial) missing.push("machineSerial");
    if (!reg.accreditation_number) missing.push("accreditationNumber");
  }
  const claim = snap.discountClaim ?? null;
  /** @type {string|null} */ const priv = tax.privilegeType ?? null;
  const totalDue = big(snap.totalMinor ?? tax.totalMinor ?? snap.totalCentavos);
  /** @type {any[]} */ const lines = printLines(snap);
  const gross = lines.reduce((n, l) => n + big(l.grossMinor), 0n);
  const promo = lines.reduce((n, l) => n + big(l.promoDiscountMinor), 0n);
  const privDisc = big(tax.privilegeDiscountMinor);
  const vatRemoved = big(tax.vatRemovedMinor);
  const discountLines = [];
  if (promo > 0n)
    discountLines.push({
      kind: "promo",
      label: "Promo discount",
      amountMinor: String(promo),
    });
  if (priv && vatRemoved > 0n)
    discountLines.push({
      kind: "vat_removed",
      label: `Less: VAT on ${privilegeLabel(priv).toLowerCase()} sale`,
      amountMinor: String(vatRemoved),
    });
  if (priv && privDisc > 0n)
    discountLines.push({
      kind: "privilege",
      privilegeType: priv,
      label: `${privilegeLabel(priv)} discount (${/** @type {Record<string,number>} */ (PRIVILEGE_RATE_BPS)[priv] / 100}%)`,
      amountMinor: String(privDisc),
    });
  /** @type {any[]} */ const tenders = tendersOf(snap);
  const tendered = tenders.reduce(
    (n, t) => n + big(t.tenderedMinor ?? t.amountMinor),
    0n,
  );
  const change = tenders.reduce((n, t) => n + big(t.changeMinor), 0n);
  const b = snap.buyer ?? {
    name: snap.customer?.name ?? null,
    tin: null,
    address: snap.customer?.address ?? null,
  };
  const prov =
    reg.pos_provider && typeof reg.pos_provider === "object"
      ? reg.pos_provider
      : {};
  const footer = [];
  if (notFiled)
    footer.push(`${NOT_FILED_BANNER} - NOT VALID AS A BIR DOCUMENT`);
  else
    footer.push(
      "THIS DOCUMENT SHALL BE VALID FOR FIVE (5) YEARS FROM THE DATE OF THE PERMIT TO USE",
    );
  if (prov.name)
    footer.push(
      `POS provider: ${[prov.name, prov.address, prov.tin ? `TIN ${prov.tin}` : ""].filter(Boolean).join(", ")}`,
    );
  if (prov.accreditationNumber || reg.accreditation_number)
    footer.push(
      `BIR accreditation no. ${prov.accreditationNumber ?? reg.accreditation_number}${prov.accreditationDate || reg.accreditation_date ? `, issued ${prov.accreditationDate ?? dateOnly(reg.accreditation_date)}` : ""}`,
    );
  if (reg.ptu_number)
    footer.push(
      `PTU no. ${reg.ptu_number}${reg.ptu_issued_on ? `, issued ${dateOnly(reg.ptu_issued_on)}` : ""}`,
    );
  const body = {
    version: 1,
    documentId: doc.id,
    documentType: type,
    title: TITLES[type] ?? "DOCUMENT",
    documentNumber: doc.document_number,
    issuedAt: new Date(doc.issued_at).toISOString(),
    status: voided ? "voided" : "valid",
    banner: notFiled ? NOT_FILED_BANNER : null,
    notFiled,
    seller: {
      entityName: reg.entity_name,
      branchName: reg.branch_name,
      address: reg.address,
      tin: reg.tin,
      tinLabel:
        Number(reg.tax_basis_points) > 0 ? "VAT REG TIN" : "NON-VAT TIN",
    },
    registration: {
      ptuNumber: reg.ptu_number ?? null,
      ptuIssuedOn: dateOnly(reg.ptu_issued_on),
      minNumber: reg.min_number ?? null,
      machineSerial: reg.machine_serial ?? null,
      accreditationNumber: reg.accreditation_number ?? null,
      accreditationDate: dateOnly(reg.accreditation_date),
      permitReference: reg.permit_reference ?? null,
      status: reg.status,
    },
    range: {
      prefix: series.prefix,
      firstSerial: s(series.first_serial),
      lastSerial: s(series.last_serial),
      firstNumber: `${series.prefix}-${s(series.first_serial).padStart(9, "0")}`,
      lastNumber: `${series.prefix}-${s(series.last_serial).padStart(9, "0")}`,
    },
    buyer: {
      name: b.name ?? null,
      tin: b.tin ?? null,
      address: b.address ?? null,
      signatureLine: Boolean(claim),
    },
    cashier: snap.cashier ?? snap.seller?.name ?? null,
    place: {
      store: snap.store ?? null,
      register: snap.register ?? null,
      terminal: snap.terminal ?? null,
      truck: snap.truck?.plateNumber ?? snap.truck?.code ?? null,
      tripNumber: snap.tripNumber ?? null,
    },
    lines,
    discountLines,
    totals: {
      grossMinor: String(gross),
      promoDiscountMinor: String(promo),
      privilegeDiscountMinor: String(privDisc),
      vatRemovedMinor: String(vatRemoved),
      totalDueMinor: String(totalDue),
      vatableSalesMinor: s(tax.vatableSalesMinor),
      vatMinor: s(tax.vatMinor),
      vatExemptSalesMinor: s(tax.vatExemptMinor),
      zeroRatedSalesMinor: s(tax.zeroRatedMinor),
      tenderedMinor: String(tendered),
      changeMinor: String(change),
      itemCount: lines.length,
    },
    tenders,
    privilege: claim
      ? {
          type: claim.type,
          label: claim.label ?? privilegeLabel(claim.type),
          holderName: claim.holderName,
          idNumber: claim.idNumber,
          applied: claim.applied !== false,
        }
      : null,
    footer,
    compliance: { complete: missing.length === 0, missing },
  };
  const { status: _status, ...hashed } = body; // void state is not part of the document's content
  const contentHash = sha256Hex(canonicalJson(hashed));
  const c = copy ?? { kind: "original", number: 0 };
  return {
    ...body,
    copy: {
      kind: c.kind,
      number: c.number,
      label: c.kind === "reprint" ? `REPRINT - COPY ${c.number}` : "ORIGINAL",
    },
    contentHash,
  };
}

/** Load a document by fiscal document id OR by the sale/collection id it was issued for, then build its model.
 * @param {any} db @param {string} id @param {{copy?:{kind:'original'|'reprint',number:number}}} [o] */
export async function loadPrintModel(db, id, o = {}) {
  const [doc] =
    await db`select * from fiscal_documents where id=${id} or source_id=${id} order by (id=${id}) desc limit 1`;
  if (!doc) refuse("That receipt was not found", "not_found");
  const [series] =
    await db`select * from fiscal_series where id=${doc.series_id}`;
  const [registration] =
    await db`select * from fiscal_registrations where id=${series.registration_id}`;
  const [{ n }] =
    await db`select count(*)::int as n from fiscal_document_events where document_id=${doc.id} and kind='void'`;
  return {
    model: buildPrintModel({
      doc,
      series,
      registration,
      voided: n > 0,
      copy: o.copy,
    }),
    doc,
    orgUnitId: registration.org_unit_id,
  };
}
