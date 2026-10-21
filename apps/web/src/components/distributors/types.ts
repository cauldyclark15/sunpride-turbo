export type Partner = {
  id: string;
  code: string;
  name: string;
  status: string;
  source: string;
  grants?: string[];
};
export type CatalogProduct = {
  productId: string;
  code: string;
  name: string;
  uom: string;
  unitsPerUom: number;
  priceCentavos: number;
  availableBase: number;
};
export type PartnerDocument = {
  id: string;
  kind: string;
  title: string;
  version: number;
  sha256: string;
  published: boolean;
  read: boolean;
  created_at: string;
};
export type Policy = {
  doiWindowDays: number;
  stockFreshDays: number;
  nearExpiryDays: number;
  understockDays: number;
  overstockDays: number;
  creditMaxAgeSeconds: number;
  reconciliationToleranceBase: number;
  secondaryTargetCentavos?: number;
  requiredDocuments: string[];
  claimTypes: { kind: string; minimumEvidence: number }[];
  scorecardWeights: Record<string, number>;
};
export type Workspace = {
  distributor: Partner & { sapCustomerCode: string | null };
  application: { id: string; stage: string; legal_name: string } | null;
  terms: { paymentTerms: string; deliveryLeadDays: number };
  catalog: CatalogProduct[];
  outlets: {
    id: string;
    code: string;
    name: string;
    territory: string | null;
  }[];
  locations: { id: string; code: string; name: string; kind: string }[];
  documents: PartnerDocument[];
  documentsTruncated: boolean;
  users: {
    id: string;
    profile_id: string;
    name: string;
    email: string;
    grants: string[];
    effective_to: string | null;
  }[];
  usersTruncated: boolean;
  policy: Policy;
  masterVersion: number;
  masterReceivedAt: string;
};
export type Order = {
  id: string;
  order_number: string;
  customer_po_number: string;
  status: string;
  total_centavos: number;
  promised_delivery_date: string | null;
  acknowledged_at: string | null;
};
export type Credit = {
  status: string;
  limitCentavos?: number;
  exposureCentavos?: number;
  checkedAt?: string;
  authority?: string;
  source: string;
  ageing?: Record<string, number>;
};
export type Quote = {
  authority?: { status: string; pendingId?: string };
  totalCentavos: number;
  subtotalCentavos: number;
  canConfirm: boolean;
  lines: {
    productId: string;
    description: string;
    quantity: number;
    uom: string;
    lineTotalCentavos: number;
    inStock: boolean;
    quantityBase: number;
    availableBase: number;
  }[];
  schemes: {
    id: string;
    name: string;
    eligible: boolean;
    applied: boolean;
    reason: string;
  }[];
  benefits: {
    name: string;
    earnedCentavos?: number;
    discountCentavos: number;
    freeGoods: { quantity: number; uom: string; productName?: string }[];
  }[];
  credit: Credit;
};
export type HealthRow = {
  productId: string;
  code: string;
  name: string;
  onHandBase: number | null;
  onHand: { cases: number; pieces: number; unitsPerCase: number } | null;
  netSecondaryBase: number | null;
  priorSecondaryBase: number | null;
  daysOfInventory: number | null;
  nearExpiryBase: number;
  expiredBase: number;
  status: string;
  nextAction: string;
  targetDays: { min: number; max: number };
  locations: {
    locationId: string;
    locationName: string;
    batch: string;
    expiry: string | null;
    quantityBase: number;
  }[];
};
export type Health = {
  period: { from: string; to: string; days: number };
  stale: boolean;
  declaration: { id: string; date: string; revision: number } | null;
  freshnessDays: number | null;
  rows: HealthRow[];
  trend: { date: string; secondaryCentavos: number }[];
};
export type Scorecard = {
  score: number | null;
  complete: boolean;
  components: Record<string, number | null>;
  weights: Record<string, number>;
  secondaryCentavos: number;
  priorCentavos: number;
  growthPct: number | null;
  targetCentavos: number | null;
  nextAction: string;
  audit: { date: string; findings: string } | null;
};
export type Secondary = {
  rows: {
    id: string;
    invoice_number: string;
    line_key: string;
    revision: number;
    sale_date: string;
    kind: string;
    outlet_name: string;
    product_name: string;
    quantity_base: number;
    amount_centavos: number;
    payload_hash: string;
  }[];
  next: string | null;
  runs: {
    id: string;
    source_key: string;
    adapter: string;
    lines: number;
    mapping: number;
    rejected: number;
    posted: number;
  }[];
  runsTruncated: boolean;
  queue: {
    id: string;
    run_id: string;
    ordinal: number;
    raw: Record<string, unknown>;
    status: string;
    reason: string | null;
  }[];
  queueTruncated: boolean;
  maps: {
    id: string;
    kind: string;
    external_code: string;
    entity_id: string;
  }[];
  mapsTruncated: boolean;
  templateHeaders: string[];
};
export type Claim = {
  id: string;
  claim_number: string;
  kind: string;
  status: string;
  amount_centavos: number;
  reason: string;
  settlement_reference: string | null;
  settled_centavos: number | null;
};
export type Finance = {
  credit: Credit;
  items: {
    id: string;
    source_key: string;
    invoice_number: string;
    due_date: string;
    balance_centavos: number;
    source: string;
    version: number;
  }[];
  remittances: {
    id: string;
    deposit_reference: string;
    deposit_date: string;
    amount_centavos: number;
    status: string;
    dispute: string | null;
  }[];
  sapRequests: { id: string; kind: string; status: string }[];
};
export type Reconciliation = {
  openingPresent: boolean;
  closingPresent: boolean;
  period: { from: string; to: string };
  toleranceBase: number;
  rows: {
    productId: string;
    code: string;
    name: string;
    openingBase: number | null;
    primaryBase: number;
    secondaryBase: number;
    closingBase: number | null;
    varianceBase: number | null;
    contentHash: string;
    status: string;
    nextAction: string;
    review: {
      status: string;
      explanation: string;
      ownerName: string;
      stale: boolean;
    } | null;
  }[];
};
export type Command = (
  path: string,
  body: Record<string, unknown>,
) => Promise<Record<string, unknown>>;
