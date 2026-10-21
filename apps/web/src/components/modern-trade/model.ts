export type Binding = {
  id: string;
  label: string;
  customer_id: string;
  outlet_id: string;
  customer_code: string;
  account_key: string;
  banner_key: string;
  branch_key: string;
  source: string;
};
export type Options = {
  bindings: Binding[];
  products: { code: string; name: string; uom: string }[];
  types: DeductionType[];
  owners: { id: string; name: string }[];
  invoices: {
    id: string;
    binding_id: string;
    invoice_number: string;
    amount_centavos: string;
  }[];
};
export type DeductionType = {
  id: string;
  code: string;
  label: string;
  sla_days: number;
  effective_from: string;
  effective_to: string | null;
};
export type IntakeLine = {
  productCode: string;
  uom: string;
  quantity: number;
  requestedPriceCentavos: number | null;
  productName?: string | null;
  approvedUnitPriceCentavos?: number | null;
  grossCentavos?: number | null;
  exceptions: string[];
};
export type Intake = {
  id: string;
  extraction?: { modelVersion?: string; text?: string } | null;
  po_number: string | null;
  service_date: string | null;
  branchLabel: string;
  status: string;
  revision: number;
  exceptions: string[];
  lines: IntakeLine[];
  order_id: string | null;
  created_at: string;
};
export type Term = {
  id: string;
  name: string;
  scope_kind: string;
  scope_key: string;
  scopeLabel: string;
  status: string;
  source: string;
  effective_from: string;
  effective_to: string | null;
  requested_by: string;
  attachment?: { filename: string; sha256?: string } | null;
  conditions: {
    id: string;
    kind: string;
    product_code: string | null;
    product_name: string | null;
    uom: string | null;
    amount_centavos: string | null;
    rate_bps: number | null;
  }[];
  events: {
    action: string;
    note: string;
    actor_name: string;
    created_at: string;
  }[];
};
export type Dispute = {
  id: string;
  reference: string;
  message: string;
  status: string;
  response: string | null;
  created_at: string;
};
export type Deduction = {
  id: string;
  branchLabel: string;
  type_id: string;
  type_label: string;
  amountCentavos: number;
  financial_status?: string;
  financialRecoveredCentavos?: number | null;
  status: string;
  reference: string;
  received_on: string;
  claim_reference: string | null;
  invoice_number: string | null;
  owner_profile_id: string;
  owner_name: string;
  due_on: string;
  age_days: number;
  overdue_days: number;
  disputes: Dispute[];
  events: { action: string; note: string; created_at: string }[];
};
export type DeductionQueue = {
  flow: {
    weekly: { from: string; amountCentavos: number; count: number }[];
    last28Centavos: number;
    prior28Centavos: number;
  };
  rows: Deduction[];
  summary: { openCentavos: number; overdue: number; unlinked: number };
  freshness: number;
};
export type PortalOverview = {
  purchaseOrders: {
    id: string;
    poNumber: string;
    branch: string;
    status: string;
    orderNumber: string | null;
    amountCentavos: number | null;
    milestones: { stage: string; at: string }[];
    deliverySource: string;
  }[];
  invoices: {
    id: string;
    branch: string;
    invoiceNumber: string;
    amountCentavos: number;
    issuedOn: string;
    dueOn: string;
    source: string;
    receivedAt: string;
  }[];
  deductions: {
    id: string;
    branch: string;
    amountCentavos: number;
    financialStatus?: string;
    financialRecoveredCentavos?: number | null;
    status: string;
    type: string;
    reference: string;
    claimReference: string | null;
    dueOn: string;
    ageDays: number;
    invoiceNumber: string | null;
    disputes: Dispute[];
  }[];
};
