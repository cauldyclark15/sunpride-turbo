/**
 * CALL-09 outside-call PO form rules. Pure so the Node test runner can exercise them; the
 * labels mirror `packages/backend/convex/sfa/productive_call.ts` (a test keeps them equal)
 * because client components must not import Convex server modules.
 */

export const OUTSIDE_CALL_ACTIVITY_LABELS = {
  purchase_order: "Purchase order",
  merchandising: "Merchandising (display, price tags)",
  inventory_retrieval: "Inventory retrieval",
  suggested_order: "Suggested order (ICO)",
  negotiation: "Negotiation leading to sales or uplift",
  bad_order_pickup: "Bad order (BO) pickup",
  collection: "Collection",
  meeting: "Meeting",
} as const;
export type ActivityCode = keyof typeof OUTSIDE_CALL_ACTIVITY_LABELS;

export const RECEIVED_VIA_LABELS = {
  email: "Email",
  viber: "Viber",
  phone: "Phone call",
  fax: "Fax",
  other: "Other",
} as const;
export type ReceivedVia = keyof typeof RECEIVED_VIA_LABELS;

export const CONTACT_LABELS = {
  phone: "Phone call",
  message: "Message (Viber, SMS, email)",
  in_person: "In person",
  other: "Other",
} as const;
export type Contact = keyof typeof CONTACT_LABELS;

export const STATUS_LABELS = {
  awaiting_activity: "Waiting for salesperson",
  activity_recorded: "Activity recorded",
  cancelled: "Cancelled",
} as const;
export type OutsideCallStatus = keyof typeof STATUS_LABELS;

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

export function manilaToday(now = Date.now()) {
  return new Date(now + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}

export type DraftLine = { productId: string; quantity: string };

/** Turns the form's line rows into encode lines; blank rows are ignored. */
export function parsePoLines<ProductId extends string>(rows: DraftLine[]) {
  const lines: { productId: ProductId; quantity: number }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.productId && !row.quantity.trim()) continue;
    if (!row.productId) throw new Error("Choose a product on every line");
    const quantity = Number(row.quantity);
    if (!row.quantity.trim() || !Number.isFinite(quantity) || quantity <= 0)
      throw new Error("Quantity must be more than 0");
    if (seen.has(row.productId))
      throw new Error("Each product may appear once");
    seen.add(row.productId);
    lines.push({ productId: row.productId as ProductId, quantity });
  }
  if (!lines.length) throw new Error("Add at least one product line");
  return lines;
}

/** Reads the encode form; ids stay opaque strings typed by the caller. */
export function encodeFieldsFromForm(data: Pick<FormData, "get">) {
  const text = (name: string) => String(data.get(name) ?? "").trim();
  const outletId = text("outletId");
  const salespersonProfileId = text("salespersonProfileId");
  const serviceDate = text("serviceDate");
  const poNumber = text("poNumber");
  const receivedVia = text("receivedVia");
  if (!outletId) throw new Error("Choose the store");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate))
    throw new Error("Enter the PO date");
  if (!salespersonProfileId) throw new Error("Choose the salesperson");
  if (!poNumber) throw new Error("Enter the store's PO number");
  if (!Object.hasOwn(RECEIVED_VIA_LABELS, receivedVia))
    throw new Error("Choose how the PO arrived");
  const note = text("note");
  return {
    outletId,
    salespersonProfileId,
    serviceDate,
    poNumber,
    receivedVia: receivedVia as ReceivedVia,
    ...(note ? { note } : {}),
  };
}

/** Reads the salesperson's activity form. */
export function activityFieldsFromForm(data: Pick<FormData, "get" | "getAll">) {
  const contact = String(data.get("contact") ?? "");
  if (!Object.hasOwn(CONTACT_LABELS, contact))
    throw new Error("Choose how you reached the store");
  const codes = data
    .getAll("codes")
    .map(String)
    .filter(
      (code): code is ActivityCode =>
        Object.hasOwn(OUTSIDE_CALL_ACTIVITY_LABELS, code) &&
        code !== "purchase_order",
    );
  const note = String(data.get("note") ?? "").trim();
  if (contact === "other" && !note)
    throw new Error("Say how the store was reached");
  return {
    contact: contact as Contact,
    codes,
    ...(note ? { note } : {}),
  };
}

export function linesSummary(
  lines: { productName: string; quantity: number; uom: string }[],
) {
  if (!lines.length) return "No lines";
  const first = lines
    .slice(0, 2)
    .map((line) => `${line.quantity} ${line.uom} ${line.productName}`)
    .join(", ");
  return lines.length > 2 ? `${first} +${lines.length - 2} more` : first;
}
