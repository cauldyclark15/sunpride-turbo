export type VoidCodeInput = {
  receiptNumber: string;
  totalMinor: string;
  reasonCode: string;
};
export type CashCodeInput = {
  tripNumber: string;
  expectedMinor: string;
  declaredMinor: string;
  reasonCode: string;
};
export type StockCodeInput = {
  tripNumber: string;
  countCode: string;
  varianceLines: number;
  shortBase: string;
  overBase: string;
};
export type VoidCode = VoidCodeInput & { code: string; tripNumber: string };
export type CashCode = CashCodeInput & { code: string; varianceMinor: string };
export type StockCode = StockCodeInput & { code: string };
export type DamageRow = {
  damageId: string;
  tripId: string;
  tripNumber: string;
  serviceDate: string;
  sellerName: string;
  productCode: string;
  productName: string;
  uomCode: string;
  quantityBase: string;
  quantityScale: string;
  reason: string;
  note: string | null;
  photoUrl: string | null;
  status: string;
  recordedAt: number;
  canDecide: boolean;
};
export type Quantity = {
  base: string;
  cases: number | null;
  pieces: number | null;
  display: string;
};
export type StockRow = {
  productId: string;
  code: string;
  name: string;
  uomCode: string;
  loaded: Quantity;
  reloaded?: Quantity;
  sold: Quantity;
  voided: Quantity;
  returned: Quantity;
  damaged: Quantity;
  unloaded: Quantity;
  remaining?: Quantity;
  expected: Quantity;
  expectedAvailable: Quantity;
  expectedDamaged: Quantity;
  counted: Quantity | null;
  variance: Quantity | null;
  varianceCentavos: number | null;
  countLines: Array<{
    status: string;
    expectedBase: string;
    countedBase: string;
    reason: string | null;
  }>;
};
export type TripSettlement = {
  vanOps?: import("./route-operations").RouteOperations | null;
  tripId: string;
  tripNumber: string;
  date: string;
  unitId: string;
  unit: string;
  truck: string;
  plateNumber: string;
  seller: string;
  route: string;
  status: string;
  settlementStatus: string;
  startedAt: number | null;
  closedAt: number | null;
  unclosed: boolean;
  salesCentavos: number;
  discountsCentavos: number;
  stock: StockRow[];
  cash: {
    /** Cash handed to the seller before the first sale; part of expected cash. */
    openingFloatCentavos?: number;
    expectedCentavos: number;
    cashSalesCentavos: number;
    collectionsCentavos: number;
    refundsCentavos: number;
    countVarianceCentavos?: number | null;
    declaredCentavos?: number | null;
    receivedBy?: string | null;
    receivedAt?: number | null;
    remittedCentavos: number | null;
    varianceCentavos: number | null;
    reason: string | null;
    approvedBy: string | null;
    countedAt: number | null;
  };
  stockCount: {
    countCode: string;
    varianceLines: number;
    shortBase: string;
    overBase: string;
    approvedBy: string | null;
    countedAt: number | null;
  } | null;
  loads: Array<{
    loadId: string;
    status: string;
    lines: Array<{
      lineNumber: number;
      productCode: string;
      expectedBase: string;
      actualBase: string | null;
      reason: string | null;
    }>;
  }>;
  sales: Array<{
    saleId: string;
    receiptNumber: string;
    totalCentavos: number;
    receipt: {
      customer: { name: string };
      lines: Array<{
        name: string;
        code: string;
        quantityBase: string;
        quantityScale?: string;
        caseBase?: string;
        pieceBase?: string;
        uomCode: string;
        totalMinor: string;
      }>;
    };
    voided: boolean;
    voidReason: string | null;
    approvedBy: string | null;
  }>;
  returns: Array<{
    returnId: string;
    returnNumber: string;
    originalSaleId: string;
    lines: Array<{
      productId: string;
      quantityBase: string;
      reason: string;
      stockEffect: string;
    }>;
    recordedAt: number;
  }>;
  payments: Array<{
    kind: string;
    method: string;
    amountCentavos: number;
    recordedAt: number;
  }>;
  history: Array<{
    id: string;
    actor: string;
    kind: string;
    details: Record<string, unknown>;
    at: number;
  }>;
  nextAction: string;
};
export type TripsDay = {
  date: string;
  asOf: number;
  targetCentavos: number | null;
  targetStatus: string;
  priorDate: string;
  priorSalesCentavos: number;
  trend: Array<{ date: string; salesCentavos: number }>;
  rows: TripSettlement[];
};
