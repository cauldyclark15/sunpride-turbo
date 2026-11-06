/** Shapes returned by the VALUE lane's API (apps/api/src/domains/inventory/valuation.js, dispositions.js). */
export type Qty = {
  base: number;
  cases: number | null;
  pieces: number | null;
  display: string;
  valueCentavos: number | null;
};
export type Units = {
  basePerCase: number | null;
  basePerPiece: number | null;
  baseCode: string;
  scale: number;
};
export type StockRow = {
  productId: string;
  code: string;
  name: string;
  category: string | null;
  locationId: string;
  locationCode?: string;
  locationName?: string;
  lotId?: string;
  lotNumber?: string;
  expiresAt?: number | null;
  daysToExpiry?: number | null;
  onHand: Qty;
  available: Qty;
  reserved: Qty;
  hold: Qty;
  damaged: Qty;
  expired: Qty;
  inTransit: Qty;
  averageCostCentavos: number | null;
  costValueCentavos: number;
  costKnown: boolean;
  sellingValueCentavos: number | null;
  units: Units;
};
export type Valuation = {
  asOf: number;
  basis: "cost" | "selling";
  groupBy: "product" | "lot";
  valueLabel: string;
  secondaryValueLabel: string;
  rows: StockRow[];
  totals: {
    costValueCentavos: number | null;
    sellingValueCentavos: number | null;
    rowsWithoutCost: number;
    rowsWithoutPrice: number;
  };
};
export type StockCardRow = {
  at: number;
  movementId: string;
  movementNumber: string;
  kind: string;
  label: string;
  documentNumber: string;
  documentLabel: string;
  link: { type: string; id: string };
  note: string | null;
  reversed: boolean;
  in: Qty | null;
  out: Qty | null;
  statusMoves: { status: string; delta: number }[];
  balance: Qty;
  valueDeltaCentavos: number;
  valueBalanceCentavos: number;
};
export type StockCard = {
  product: { id: string; code: string; name: string; units: Units };
  location: { id: string; code: string; name: string };
  from: string;
  to: string;
  opening: { quantity: Qty; valueCentavos: number };
  rows: StockCardRow[];
  closing: { quantity: Qty; valueCentavos: number };
  totals: { in: Qty; out: Qty };
  current: { quantity: Qty; valueCentavos: number };
  reconcilesToday: boolean;
  rowCount: number;
  nextCursor: string | null;
};
export type DispositionDecision =
  | "write_off"
  | "return_to_supplier"
  | "destroy"
  | "release";
export type WaitingStock = {
  productId: string;
  code: string;
  name: string;
  locationId: string;
  locationName?: string;
  lotId: string | null;
  lotNumber: string | null;
  expiresAt: number | null;
  status: string;
  statusLabel: string;
  quantity: Qty;
  valueCentavos: number;
  releasable: boolean;
  units: Units;
};
export type DispositionRequest = {
  id: string;
  number: string;
  status: "requested" | "approved" | "posted" | "rejected";
  decision: DispositionDecision;
  decisionLabel: string;
  fromStatusLabel: string;
  productId: string;
  code: string;
  name: string;
  locationName?: string;
  lotNumber: string | null;
  quantity: Qty;
  valueCentavos: number;
  reasonCode: string | null;
  note: string | null;
  supplierRef: string | null;
  approvalLevel: "supervisor" | "manager";
  approvalLimitCentavos: number | null;
  needsPhoto: boolean;
  photos: number;
  photoUrls: string[];
  requestedAt: number;
  decisionNote: string | null;
  canDecide: boolean;
};
export type DispositionQueue = {
  asOf: number;
  waiting: WaitingStock[];
  requests: DispositionRequest[];
  summary: {
    waitingValueCentavos: number;
    requestedValueCentavos: number;
    waitingCount: number;
    requestedCount: number;
  };
};
export type ExpiryRow = {
  productId: string;
  code: string;
  name: string;
  locationId: string;
  locationName?: string;
  lotId: string;
  lotNumber: string;
  expiresAt: number;
  daysLeft: number;
  status: string;
  quantity: Qty;
  availableToMove: Qty;
  valueCentavos: number;
  onRecall: boolean;
  prioritised: boolean;
};
export type ExpiryBoardData = {
  asOf: number;
  days: number;
  buckets: {
    key: string;
    label: string;
    count: number;
    valueCentavos: number;
    rows: ExpiryRow[];
  }[];
};
