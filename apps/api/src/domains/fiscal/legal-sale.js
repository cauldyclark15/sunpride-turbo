/**
 * IP-BIR: the one place that turns a sale basket into legal facts, for the store till and the van.
 *   - discount claim (SC / PWD / solo parent / athlete / uniformed): validate, recompute with privilege.js, refuse a mismatch
 *   - per-line tax snapshot (VATable / VAT-exempt / zero-rated) with privilege lines kept as their own amounts
 *   - buyer name / TIN / address (outlet billing profile, overridable at the sale)
 *   - the append-only sale_discount_claims row
 * All money here is integer centavos. Wire strings are converted by the callers.
 */
import { computeLine, PRIVILEGE_TYPES, PRIVILEGE_LABELS } from "./privilege.js";
import { invoiceTaxSnapshot } from "./taxes.js";
import { refuse, text, uuid } from "../van/model.js";

const peso = (/** @type {number|bigint} */ c) =>
  `₱${(Number(c) / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** @typedef {{type:string,idNumber:string,holderName:string,eligibleProductIds:string[]|null}} Claim */
/** @typedef {{productId:string,description:string,grossCentavos:number,promoDiscountCentavos:number,taxTreatment:string|null,taxBasisPoints:number|null}} LegalLine */

/** Validate the wire claim. Returns null when there is no claim. @param {any} raw @returns {Claim|null} */
export function normalizeClaim(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw))
    refuse(
      "The discount details are not readable. Enter them again.",
      "discount_claim_invalid",
    );
  if (!PRIVILEGE_TYPES.includes(raw.type))
    refuse(
      "Choose the discount type: senior citizen, PWD, solo parent, athlete or uniformed personnel.",
      "discount_claim_invalid",
    );
  const idNumber = typeof raw.idNumber === "string" ? raw.idNumber.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9 \-/.]{2,39}$/.test(idNumber))
    refuse(
      `Enter the ${privilegeLabel(raw.type).toLowerCase()} ID number exactly as printed on the card (3 to 40 letters or digits).`,
      "discount_claim_invalid",
    );
  const holderName =
    typeof raw.holderName === "string" ? raw.holderName.trim() : "";
  if (
    holderName.length < 2 ||
    holderName.length > 120 ||
    /[\x00-\x1f]/.test(holderName)
  )
    refuse("Enter the name of the person on the ID.", "discount_claim_invalid");
  let eligibleProductIds = null;
  if (raw.eligibleProductIds !== undefined && raw.eligibleProductIds !== null) {
    if (
      !Array.isArray(raw.eligibleProductIds) ||
      raw.eligibleProductIds.length > 200
    )
      refuse("Choose which items get the discount.", "discount_claim_invalid");
    eligibleProductIds = raw.eligibleProductIds.map((/** @type {any} */ id) =>
      uuid(id),
    );
  }
  return { type: raw.type, idNumber, holderName, eligibleProductIds };
}

/** Optional buyer override from the sale. @param {any} raw */
export function parseBuyer(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw))
    refuse(
      "The buyer details are not readable. Enter them again.",
      "buyer_invalid",
    );
  const name = text(raw.name, 150);
  const address = text(raw.address, 400);
  const tin = text(raw.tin, 25);
  if (tin && !/^[0-9][0-9\- ]{8,23}$/.test(tin))
    refuse(
      "Enter the buyer TIN as digits, for example 123-456-789-000.",
      "buyer_invalid",
    );
  if (!name && !address && !tin) return null;
  return { name, tin, address };
}

/** Is the statutory discount switched on here? Default: store ON, van OFF (SPEC 6.2).
 * @param {any} db @param {{orgUnitId:string,surface:'store'|'van',routeId?:string|null,at:number}} q */
export async function surfaceEnabled(
  db,
  { orgUnitId, surface, routeId = null, at },
) {
  const [row] = await db`select enabled from privilege_discount_settings
    where org_unit_id=${orgUnitId} and surface=${surface} and effective_from<=${new Date(at)}
      and (route_id is null or route_id=${routeId})
    order by (route_id is not null) desc, effective_from desc, created_at desc limit 1`;
  return row ? row.enabled === true : surface === "store";
}

/** Buyer facts for the invoice: sale override > billing profile > outlet record.
 * @param {any} db @param {{outletId?:string|null,override?:any,fallbackName?:string|null,fallbackAddress?:string|null}} q */
export async function resolveBuyer(
  db,
  { outletId, override, fallbackName, fallbackAddress },
) {
  const [bp] = outletId
    ? await db`select * from outlet_billing_profiles where outlet_id=${outletId}`
    : [];
  const o = parseBuyer(override);
  return {
    name: o?.name ?? bp?.registered_name ?? fallbackName ?? null,
    tin: o?.tin ?? bp?.tin ?? null,
    address: o?.address ?? bp?.address ?? fallbackAddress ?? null,
    source: o ? "sale" : bp ? "billing_profile" : "outlet",
  };
}

/** Per-line result with no privilege (zero-value gift lines carry no tax). @param {LegalLine} l */
function zeroLine(l) {
  return {
    grossCentavos: l.grossCentavos,
    vatableCentavos: 0,
    vatCentavos: 0,
    vatExemptCentavos: 0,
    zeroRatedCentavos: 0,
    privilegeDiscountCentavos: 0,
    promoDiscountCentavos: l.promoDiscountCentavos,
    netCentavos: l.grossCentavos - l.promoDiscountCentavos,
    vatRemovedCentavos: 0,
    privilegeType: null,
  };
}

/**
 * Validate and recompute a discount claim. Without a claim returns { claim: null }.
 * @param {any} db
 * @param {{surface:'store'|'van',orgUnitId:string,routeId?:string|null,payload:any,at:number,lines:LegalLine[]}} q
 * @returns {Promise<any>}
 */
export async function prepareLegalSale(
  db,
  { surface, orgUnitId, routeId = null, payload, at, lines },
) {
  const claim = normalizeClaim(payload.discountClaim);
  const buyerOverride = payload.buyer ?? null;
  if (!claim)
    return {
      claim: null,
      buyerOverride,
      results: null,
      totals: null,
      assertMatches: () => {},
    };
  if (!(await surfaceEnabled(db, { orgUnitId, surface, routeId, at })))
    refuse(
      surface === "van"
        ? "Senior and PWD discounts are not switched on for this van route. Ask the office to turn them on."
        : "Senior and PWD discounts are not switched on for this till. Ask the office to turn them on.",
      "discount_not_enabled",
    );
  const eligible = claim.eligibleProductIds
    ? new Set(claim.eligibleProductIds)
    : null;
  if (eligible) {
    const known = new Set(lines.map((l) => l.productId));
    for (const id of eligible)
      if (!known.has(id))
        refuse(
          "The discount was set on an item that is not in this sale.",
          "discount_claim_invalid",
        );
  }
  const results = lines.map((l) => {
    if (l.grossCentavos === 0) return zeroLine(l);
    if (!l.taxTreatment)
      refuse(
        `${l.description} has no tax set-up, so the discount cannot be worked out. Ask the office to finish its price and tax set-up.`,
        "tax_setup_missing",
      );
    const takes = eligible ? eligible.has(l.productId) : true;
    return computeLine({
      unitPriceCentavos: l.grossCentavos,
      qty: 1,
      vatRateBps: l.taxBasisPoints ?? 0,
      taxTreatment: /** @type {any} */ (l.taxTreatment),
      privilege: takes ? { type: claim.type } : null,
      promoDiscountCentavos: l.promoDiscountCentavos,
    });
  });
  const sum = (/** @type {keyof ReturnType<typeof zeroLine>} */ k) =>
    results.reduce((a, r) => a + /** @type {number} */ (r[k]), 0);
  const totals = {
    gross: sum("grossCentavos"),
    promoDiscount: sum("promoDiscountCentavos"),
    privilegeDiscount: sum("privilegeDiscountCentavos"),
    vatRemoved: sum("vatRemovedCentavos"),
    total: sum("netCentavos"),
    applied: results.some((r) => r.privilegeType !== null),
  };
  const label = privilegeLabel(claim.type);
  /** Refuse when the phone's numbers differ from ours. @param {{totalCentavos?:bigint|number|string|null,privilegeDiscountCentavos?:any,vatRemovedCentavos?:any}} sent */
  const assertMatches = (sent) => {
    const same = (/** @type {any} */ a, /** @type {number} */ b) =>
      a === undefined || a === null || BigInt(a) === BigInt(b);
    let bad = false;
    try {
      bad =
        !same(sent.totalCentavos, totals.total) ||
        !same(sent.privilegeDiscountCentavos, totals.privilegeDiscount) ||
        !same(sent.vatRemovedCentavos, totals.vatRemoved);
    } catch {
      bad = true;
    }
    if (bad)
      refuse(
        `The ${label.toLowerCase()} discount does not match. The phone says ${
          sent.totalCentavos !== undefined &&
          sent.totalCentavos !== null &&
          /^\d+$/.test(String(sent.totalCentavos))
            ? peso(BigInt(sent.totalCentavos))
            : "a different total"
        } to pay; the system works out ${peso(totals.total)} (discount ${peso(totals.privilegeDiscount)}, VAT removed ${peso(totals.vatRemoved)}). Refresh prices and apply the discount again.`,
        "stock_conflict", // wire code the phone already treats as "refresh and try again"
      );
  };
  return { claim, buyerOverride, results, totals, assertMatches };
}

const BIG = (/** @type {any} */ v) => BigInt(v);
/** Plain label for a privilege type. @param {string|null|undefined} type */
export const privilegeLabel = (type) =>
  /** @type {Record<string,string>} */ (PRIVILEGE_LABELS)[type ?? ""] ??
  String(type ?? "");

/**
 * Per-line tax snapshot. Same shape as invoiceTaxSnapshot plus the privilege fields.
 *   totalMinor            = what the customer pays
 *   vatable+vat+exempt+zero = totalMinor + privilegeDiscountMinor  (buckets are shown before the privilege discount)
 * @param {Array<{totalMinor:string,grossMinor?:string,promoDiscountMinor?:string,taxBasisPoints:number,taxTreatment:string,taxCode:string,sourceTaxInclusive:boolean,sourceSellingUnitMinor?:string,sourceNetUnitMinor?:string,sapConditionKey?:any,sapConditionVersion?:any}>} lines
 * @param {{results?:any[]|null,claim?:Claim|null,totalMinor:string}} o
 */
export function buildTaxSnapshot(
  lines,
  { results = null, claim = null, totalMinor },
) {
  const anyPrivilege = Boolean(results?.some((r) => r.privilegeType));
  const gross = lines.reduce(
    (n, l) => n + BIG(l.grossMinor ?? l.totalMinor),
    0n,
  );
  const promo = lines.reduce(
    (n, l) => n + BIG(l.promoDiscountMinor ?? "0"),
    0n,
  );
  if (!lines.length)
    return {
      inclusive: true,
      rateBasisPoints: 0,
      vatableSalesMinor: "0",
      vatMinor: "0",
      vatExemptMinor: "0",
      zeroRatedMinor: "0",
      totalMinor,
      lines: [],
      grossMinor: "0",
      promoDiscountMinor: "0",
      privilegeDiscountMinor: "0",
      vatRemovedMinor: "0",
      privilegeType: null,
    };
  if (!anyPrivilege)
    return {
      ...invoiceTaxSnapshot(lines, totalMinor),
      grossMinor: String(gross),
      promoDiscountMinor: String(promo),
      privilegeDiscountMinor: "0",
      vatRemovedMinor: "0",
      privilegeType: null,
    };
  let vatable = 0n,
    vat = 0n,
    exempt = 0n,
    zero = 0n,
    disc = 0n,
    removed = 0n,
    total = 0n;
  const rates = new Set(),
    /** @type {any[]} */ details = [];
  lines.forEach((l, i) => {
    const r = results?.[i];
    if (r?.privilegeType) {
      vatable += BigInt(r.vatableCentavos);
      vat += BigInt(r.vatCentavos);
      exempt += BigInt(r.vatExemptCentavos);
      zero += BigInt(r.zeroRatedCentavos);
      disc += BigInt(r.privilegeDiscountCentavos);
      removed += BigInt(r.vatRemovedCentavos);
      if (r.vatableCentavos) rates.add(l.taxBasisPoints);
      details.push({
        lineNumber: i + 1,
        treatment: l.taxTreatment,
        taxCode: l.taxCode,
        rateBasisPoints: l.taxBasisPoints,
        netMinor: String(
          r.vatableCentavos + r.vatExemptCentavos + r.zeroRatedCentavos,
        ),
        vatMinor: String(r.vatCentavos),
        totalMinor: String(r.netCentavos),
        privilegeType: r.privilegeType,
        privilegeDiscountMinor: String(r.privilegeDiscountCentavos),
        vatRemovedMinor: String(r.vatRemovedCentavos),
        sourceKey: l.sapConditionKey ?? null,
        sourceVersion: l.sapConditionVersion ?? null,
      });
    } else {
      const s = invoiceTaxSnapshot([l], l.totalMinor);
      vatable += BIG(s.vatableSalesMinor);
      vat += BIG(s.vatMinor);
      exempt += BIG(s.vatExemptMinor);
      zero += BIG(s.zeroRatedMinor);
      if (BIG(s.vatableSalesMinor) > 0n) rates.add(l.taxBasisPoints);
      details.push({
        ...s.lines[0],
        lineNumber: i + 1,
        privilegeType: null,
        privilegeDiscountMinor: "0",
        vatRemovedMinor: "0",
      });
    }
    total += BIG(results?.[i]?.netCentavos ?? l.totalMinor);
  });
  if (
    total !== BIG(totalMinor) ||
    vatable + vat + exempt + zero !== total + disc
  )
    refuse("Invoice tax totals do not reconcile");
  return {
    inclusive: true,
    rateBasisPoints:
      rates.size === 1 ? [...rates][0] : rates.size === 0 ? 0 : null,
    vatableSalesMinor: String(vatable),
    vatMinor: String(vat),
    vatExemptMinor: String(exempt),
    zeroRatedMinor: String(zero),
    totalMinor,
    lines: details,
    grossMinor: String(gross),
    promoDiscountMinor: String(promo),
    privilegeDiscountMinor: String(disc),
    vatRemovedMinor: String(removed),
    privilegeType: claim?.type ?? null,
  };
}

/** Append the claim evidence row. Call inside the sale transaction, after the fiscal document exists.
 * @param {any} db @param {{sourceType:'store_sale'|'van_sale',sourceId:string,orgUnitId:string,legal:any,claimed:any,actorProfileId:string,documentId?:string|null}} q */
export async function recordClaim(
  db,
  {
    sourceType,
    sourceId,
    orgUnitId,
    legal,
    claimed,
    actorProfileId,
    documentId = null,
  },
) {
  if (!legal?.claim) return null;
  const { claim, totals, results } = legal;
  const [row] =
    await db`insert into sale_discount_claims(source_type,source_id,org_unit_id,privilege_type,id_number,holder_name,eligible_product_ids,applied,gross_centavos,promo_discount_centavos,privilege_discount_centavos,vat_removed_centavos,total_centavos,claimed,computed,fiscal_document_id,recorded_by)
    values(${sourceType},${sourceId},${orgUnitId},${claim.type},${claim.idNumber},${claim.holderName},${claim.eligibleProductIds ? JSON.stringify(claim.eligibleProductIds) : null}::jsonb,${totals.applied},${String(totals.gross)},${String(totals.promoDiscount)},${String(totals.privilegeDiscount)},${String(totals.vatRemoved)},${String(totals.total)},${claimed},${{ lines: results, totals }},${documentId},${actorProfileId})
    on conflict(source_type,source_id) do nothing returning id`;
  return row?.id ?? null;
}
