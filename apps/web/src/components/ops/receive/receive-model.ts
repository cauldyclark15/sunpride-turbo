import { toBaseQty, type CasesPieces } from "../qty-cases-pieces";

/** Product row from GET /api/v1/inventory/products (only what Receive needs). */
export type CatalogProduct = {
  id: string;
  code: string;
  name: string;
  tracking: string;
  units: { basePerCase: number | null; basePerPiece?: number | null };
};

export type DeliveryHeader = {
  locationId: string;
  supplierName: string;
  deliveryReceiptNo: string;
  purchaseOrderRef: string;
  note: string;
};

/** One row of the Receive delivery grid. Quantities are cases + pieces on screen, base pieces on the wire. */
export type DeliveryLine = {
  key: string;
  productId: string;
  code: string;
  name: string;
  tracking: string;
  basePerCase: number | null;
  accepted: CasesPieces;
  rejected: CasesPieces;
  rejectedReason: string;
  /** The chosen reason asks for a photo. */
  reasonNeedsPhoto: boolean;
  photoCount: number;
  batch: string;
  /** yyyy-mm-dd from a date field. */
  expiry: string;
  note: string;
};

export const emptyHeader = (locationId = ""): DeliveryHeader => ({
  locationId,
  supplierName: "",
  deliveryReceiptNo: "",
  purchaseOrderRef: "",
  note: "",
});

export const ZERO: CasesPieces = { cases: 0, pieces: 0 };

export function newLine(product: CatalogProduct): DeliveryLine {
  return {
    key: `${product.id}:${Math.random().toString(36).slice(2, 8)}`,
    productId: product.id,
    code: product.code,
    name: product.name,
    tracking: product.tracking,
    basePerCase: product.units.basePerCase ?? null,
    accepted: ZERO,
    rejected: ZERO,
    rejectedReason: "",
    reasonNeedsPhoto: false,
    photoCount: 0,
    batch: "",
    expiry: "",
    note: "",
  };
}

const acceptedBase = (l: DeliveryLine) => toBaseQty(l.accepted, l.basePerCase);
const rejectedBase = (l: DeliveryLine) => toBaseQty(l.rejected, l.basePerCase);

/** A scan or a typed code: exact product code first, then a single product whose name contains the text. */
export function findProduct(
  catalog: CatalogProduct[],
  text: string,
): CatalogProduct | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const exact = catalog.find((p) => p.code.toLowerCase() === t);
  if (exact) return exact;
  const partial = catalog.filter(
    (p) => p.name.toLowerCase().includes(t) || p.code.toLowerCase().includes(t),
  );
  return partial.length === 1 ? (partial[0] ?? null) : null;
}

/** What is wrong with this line, in plain words. Empty means the line is ready. */
export function lineProblems(l: DeliveryLine): string[] {
  const out: string[] = [];
  if (acceptedBase(l) + rejectedBase(l) <= 0)
    out.push(`${l.name}: enter how many arrived.`);
  if (l.tracking === "lot") {
    if (!l.batch.trim()) out.push(`${l.name}: enter the batch number.`);
    if (!l.expiry) out.push(`${l.name}: enter the expiry date.`);
  }
  if (rejectedBase(l) > 0 && !l.rejectedReason)
    out.push(`${l.name}: choose why some were rejected.`);
  if (rejectedBase(l) > 0 && l.reasonNeedsPhoto && l.photoCount < 1)
    out.push(`${l.name}: take a photo of the rejected items.`);
  return out;
}

export function deliveryProblems(
  header: DeliveryHeader,
  lines: DeliveryLine[],
): string[] {
  const out: string[] = [];
  if (!header.locationId) out.push("Choose where the delivery is going.");
  if (!header.supplierName.trim()) out.push("Enter the supplier.");
  if (!header.deliveryReceiptNo.trim())
    out.push("Enter the delivery receipt number.");
  if (!lines.length) out.push("Scan or search for the products delivered.");
  for (const l of lines) out.push(...lineProblems(l));
  return out;
}

/** Body for POST /api/v1/inventory/receipts/post (one post for the whole delivery). */
export function toReceiptBody(header: DeliveryHeader, lines: DeliveryLine[]) {
  return {
    receivingLocationId: header.locationId,
    receiptType: header.purchaseOrderRef.trim()
      ? "purchase_order"
      : "unplanned",
    supplierName: header.supplierName.trim(),
    deliveryReference: header.deliveryReceiptNo.trim(),
    ...(header.purchaseOrderRef.trim()
      ? { purchaseOrderRef: header.purchaseOrderRef.trim() }
      : {}),
    ...(header.note.trim() ? { note: header.note.trim() } : {}),
    lines: lines.map((l) => {
      const rejected = rejectedBase(l);
      return {
        productId: l.productId,
        quantityBase: acceptedBase(l),
        ...(rejected > 0
          ? {
              rejectedBase: rejected,
              rejectedReasonCode: l.rejectedReason,
              photoCount: l.photoCount,
              ...(l.note.trim() ? { note: l.note.trim() } : {}),
            }
          : {}),
        ...(l.tracking === "lot"
          ? {
              lotNumber: l.batch.trim(),
              expiresAt: new Date(`${l.expiry}T23:59:59+08:00`).getTime(),
            }
          : {}),
      };
    }),
  };
}

export function totals(lines: DeliveryLine[]) {
  return {
    lines: lines.length,
    acceptedLines: lines.filter((l) => acceptedBase(l) > 0).length,
    rejectedLines: lines.filter((l) => rejectedBase(l) > 0).length,
  };
}
