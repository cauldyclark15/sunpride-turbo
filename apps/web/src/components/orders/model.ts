export type OrderRow = {
  id: string;
  orderNumber: string;
  status: string;
  customerCode: string;
  customerName: string;
  salespersonName: string;
  salespersonProfileId: string;
  channel: string | null;
  territoryName: string | null;
  territoryId: string | null;
  serviceDate: string;
  totalCentavos: number | null;
  creditStatus: string;
  createdAt: number;
  source: string;
};
export type OrderPage = {
  rows: OrderRow[];
  next: string | null;
  summary: {
    count: number;
    totalCentavos: number | null;
    priorCentavos: number | null;
    waiting: number;
    overCredit: number;
    unpriced: number;
    targetCentavos: number | null;
  };
  trend: { date: string; orders: number; totalCentavos: number | null }[];
  period: { from: string; to: string };
  compare: { from: string; to: string };
};
export type OrderDetail = OrderRow & {
  canDecide: boolean;
  lines: {
    productCode: string;
    description: string;
    quantity: number;
    quantityBase: number | null;
    uom: string;
    unitPriceCentavos: number | null;
    lineTotalCentavos: number | null;
  }[];
  pricing: {
    pricedAt: number;
    lines: {
      productCode: string;
      priceListId: string | null;
      priceListName?: string | null;
      priceListCode?: string | null;
      source: string | null;
    }[];
    promotionsApplied: {
      id: string;
      name: string;
      kind: string;
      discountCentavos: number;
      freeGoods: {
        productId: string;
        productName?: string;
        quantity: number;
        uom: string;
      }[];
    }[];
  } | null;
  credit: {
    status: string;
    limit: number | null;
    exposure: number | null;
    definition: string;
  };
  history: {
    id: string;
    name: string;
    action: string;
    from: string | null;
    to: string;
    reason: string | null;
    at: number;
  }[];
};
export type OutsideRow = {
  outletName: string;
  outletCode: string;
  salespersonName: string;
  encodedByName: string;
  order: {
    _id: string;
    poNumber: string;
    serviceDate: string;
    receivedVia: "email" | "viber" | "phone" | "fax" | "other";
    status: "awaiting_activity" | "activity_recorded" | "cancelled";
    salespersonProfileId: string;
    encodedAt: number;
    lines: { productName: string; quantity: number; uom: string }[];
    note: string | null;
    cancelReason: string | null;
    activity: {
      contact: "phone" | "message" | "in_person" | "other";
      codes: string[];
      note: string | null;
      recordedAt: number;
    } | null;
  };
};
export type OutsidePage = {
  page: OutsideRow[];
  isDone: boolean;
  continueCursor: string;
  total: number;
};
export type OutsideOptions = {
  outlets: { _id: string; name: string; code: string; status: string }[];
  products: {
    _id: string;
    name: string;
    code: string;
    uom: string;
    active: boolean;
  }[];
};
export type Candidates = {
  hasTerritory: boolean;
  salespeople: {
    profileId: string;
    name: string;
    kind: string | null;
    inPlan: boolean;
  }[];
};
export const money = (value: number | null | undefined) =>
  value == null
    ? "Unknown"
    : new Intl.NumberFormat("en-PH", {
        style: "currency",
        currency: "PHP",
      }).format(value / 100);
export const stage = (value: string) =>
  ({
    pending_approval: "Waiting for approval",
    submitted: "Booked",
    draft: "Draft",
    approved: "Approved",
    rejected: "Rejected",
    voided: "Voided",
    fulfilled: "Fulfilled",
    posted: "Posted",
    sent_to_sap: "Sent to SAP",
    review_required: "Needs review",
  })[value] ?? "Needs review";
/**
 * WEB-102: the stored credit exposure is the customer's open balance *before*
 * this order (SAP `exposureCentavos`). An order not yet booked in SAP adds its
 * own total; once approved/posted it is already in the balance.
 */
export function creditExposureLines(order: {
  status: string;
  totalCentavos: number | null;
  credit: { limit: number | null; exposure: number | null };
}): string[] {
  const { limit, exposure } = order.credit;
  const lines = [`Limit ${money(limit)}`];
  if (exposure === null) return [...lines, "Exposure unknown"];
  const open = ["draft", "pending_approval", "review_required"].includes(
    order.status,
  );
  if (!open || order.totalCentavos === null)
    return [...lines, `Exposure ${money(exposure)}`];
  return [
    ...lines,
    `Open balance ${money(exposure)}`,
    `Exposure including this order ${money(exposure + order.totalCentavos)}`,
  ];
}
export const creditLabel = (value: string) =>
  ({
    within: "Within limit",
    over: "Over credit",
    no_limit: "No limit set",
    unknown: "Credit unknown",
  })[value] ?? "Credit unknown";
