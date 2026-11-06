import type { DispositionQueue, ExpiryBoardData, Qty, StockCard, Units, Valuation } from "./types";

export const units: Units = { basePerCase: 12, basePerPiece: 1, baseCode: "PC", scale: 1 };
export const q = (base: number, valueCentavos: number | null = null): Qty => ({
  base,
  cases: Math.floor(base / 12),
  pieces: base % 12,
  display: `${Math.floor(base / 12) ? `${Math.floor(base / 12)} cs ` : ""}${base % 12 ? `${base % 12} pc` : ""}`.trim() || "0 pc",
  valueCentavos,
});

export const valuation: Valuation = {
  asOf: 1793980000000,
  basis: "cost",
  groupBy: "product",
  valueLabel: "Cost value (average cost of what we bought)",
  secondaryValueLabel: "Selling value (default price list)",
  rows: [
    {
      productId: "p1", code: "CB-12", name: "Corned beef 150g", category: "Canned", locationId: "l1", locationName: "Main depot",
      onHand: q(60), available: q(50), reserved: q(0), hold: q(7), damaged: q(3), expired: q(0), inTransit: q(0),
      averageCostCentavos: 1100, costValueCentavos: 66000, costKnown: true, sellingValueCentavos: 120000, units,
    },
    {
      productId: "p2", code: "SS-6", name: "Sweet sausage 1kg", category: "Frozen", locationId: "l1", locationName: "Main depot",
      onHand: q(24), available: q(24), reserved: q(0), hold: q(0), damaged: q(0), expired: q(0), inTransit: q(0),
      averageCostCentavos: 0, costValueCentavos: 0, costKnown: false, sellingValueCentavos: 48000, units,
    },
  ],
  totals: { costValueCentavos: 66000, sellingValueCentavos: 168000, rowsWithoutCost: 1, rowsWithoutPrice: 0 },
};

export const card: StockCard = {
  product: { id: "p1", code: "CB-12", name: "Corned beef 150g", units },
  location: { id: "l1", code: "DEP", name: "Main depot" },
  from: "2026-10-07",
  to: "2026-11-06",
  opening: { quantity: q(20), valueCentavos: 20000 },
  rows: [
    {
      at: 1793900000000, movementId: "m1", movementNumber: "MV-AAAA1111", kind: "goods_receipt", label: "Received",
      documentNumber: "RCV-DEP-261105-0003", documentLabel: "Receipt", link: { type: "goods_receipt", id: "r1" }, note: null, reversed: false,
      in: q(48), out: null, statusMoves: [], balance: q(68), valueDeltaCentavos: 48000, valueBalanceCentavos: 68000,
    },
    {
      at: 1793950000000, movementId: "m2", movementNumber: "MV-BBBB2222", kind: "pos_sale", label: "Sold",
      documentNumber: "MV-BBBB2222", documentLabel: "Stock movement", link: { type: "movement", id: "m2" }, note: null, reversed: false,
      in: null, out: q(8), statusMoves: [], balance: q(60), valueDeltaCentavos: -8000, valueBalanceCentavos: 60000,
    },
  ],
  closing: { quantity: q(60), valueCentavos: 60000 },
  totals: { in: q(48), out: q(8) },
  current: { quantity: q(60), valueCentavos: 60000 },
  reconcilesToday: true,
  rowCount: 2,
  nextCursor: null,
};

export const queue: DispositionQueue = {
  asOf: 1793980000000,
  waiting: [
    {
      productId: "p1", code: "CB-12", name: "Corned beef 150g", locationId: "l1", locationName: "Main depot", lotId: null, lotNumber: null,
      expiresAt: null, status: "damaged", statusLabel: "Damaged", quantity: q(24), valueCentavos: 26400, releasable: true, units,
    },
  ],
  requests: [
    {
      id: "d1", number: "DSP-DEP-261106-0001", status: "requested", decision: "destroy", decisionLabel: "Destroy", fromStatusLabel: "Expired",
      productId: "p2", code: "SS-6", name: "Sweet sausage 1kg", locationName: "Main depot", lotNumber: "L-77", quantity: q(36),
      valueCentavos: 250000, reasonCode: "EXP", note: "Freezer failure", supplierRef: null, approvalLevel: "manager", approvalLimitCentavos: 100000,
      needsPhoto: false, photos: 1, photoUrls: ["/api/v1/inventory/dispositions/photo?id=ph1"], requestedAt: 1793970000000, decisionNote: null, canDecide: true,
    },
    {
      id: "d2", number: "DSP-DEP-261106-0002", status: "requested", decision: "destroy", decisionLabel: "Destroy", fromStatusLabel: "Expired",
      productId: "p2", code: "SS-6", name: "Sweet sausage 1kg", locationName: "Main depot", lotNumber: null, quantity: q(6),
      valueCentavos: 4000, reasonCode: "EXP", note: null, supplierRef: null, approvalLevel: "supervisor", approvalLimitCentavos: 100000,
      needsPhoto: true, photos: 0, photoUrls: [], requestedAt: 1793971000000, decisionNote: null, canDecide: false,
    },
  ],
  summary: { waitingValueCentavos: 26400, requestedValueCentavos: 254000, waitingCount: 1, requestedCount: 2 },
};

const row = (lot: string, daysLeft: number, extra: object = {}) => ({
  productId: "p2", code: "SS-6", name: "Sweet sausage 1kg", locationId: "l1", locationName: "Main depot", lotId: `lot-${lot}`, lotNumber: lot,
  expiresAt: 1793980000000 + daysLeft * 86400000, daysLeft, status: "available", quantity: q(24), availableToMove: q(24), valueCentavos: 24000,
  onRecall: false, prioritised: false, ...extra,
});
export const board: ExpiryBoardData = {
  asOf: 1793980000000,
  days: 90,
  buckets: [
    { key: "expired", label: "Already expired", count: 1, valueCentavos: 24000, rows: [row("OLD", -2)] },
    { key: "30", label: "Within 30 days", count: 1, valueCentavos: 24000, rows: [row("D10", 10, { prioritised: true })] },
    { key: "60", label: "31 to 60 days", count: 1, valueCentavos: 24000, rows: [row("D45", 45, { status: "quality_hold", availableToMove: q(0) })] },
    { key: "90", label: "61 to 90 days", count: 0, valueCentavos: 0, rows: [] },
  ],
};
