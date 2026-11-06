/** Printer-neutral receipt model served by GET /api/v1/fiscal/receipts/:id/print-model (IP-BIR).
 * Money is integer centavos as decimal strings ("2786" = ₱27.86). The handheld renders the same model. */
export type ReceiptLine = {
  n: number;
  productCode: string | null;
  description: string;
  qty: number;
  qtyText: string;
  uom: string;
  freeQty: number;
  unitPriceMinor: string;
  grossMinor: string;
  promoDiscountMinor: string;
  payableMinor: string;
  taxLetter: "V" | "E" | "Z";
  privilegeType: string | null;
};

export type ReceiptModel = {
  version: number;
  documentId: string;
  documentType: string;
  title: string;
  documentNumber: string;
  issuedAt: string;
  status: "valid" | "voided";
  banner: string | null;
  notFiled: boolean;
  seller: {
    entityName: string;
    branchName: string;
    address: string;
    tin: string;
    tinLabel: string;
  };
  registration: {
    ptuNumber: string | null;
    ptuIssuedOn: string | null;
    minNumber: string | null;
    machineSerial: string | null;
    accreditationNumber: string | null;
    accreditationDate: string | null;
    permitReference: string | null;
    status: string;
  };
  range: {
    prefix: string;
    firstSerial: string;
    lastSerial: string;
    firstNumber: string;
    lastNumber: string;
  };
  buyer: {
    name: string | null;
    tin: string | null;
    address: string | null;
    signatureLine: boolean;
  };
  cashier: string | null;
  place: {
    store: string | null;
    register: string | null;
    terminal: string | null;
    truck: string | null;
    tripNumber: string | null;
  };
  lines: ReceiptLine[];
  discountLines: {
    kind: "promo" | "vat_removed" | "privilege";
    label: string;
    amountMinor: string;
    privilegeType?: string;
  }[];
  totals: {
    grossMinor: string;
    promoDiscountMinor: string;
    privilegeDiscountMinor: string;
    vatRemovedMinor: string;
    totalDueMinor: string;
    vatableSalesMinor: string;
    vatMinor: string;
    vatExemptSalesMinor: string;
    zeroRatedSalesMinor: string;
    tenderedMinor: string;
    changeMinor: string;
    itemCount: number;
  };
  tenders: {
    method: string;
    label: string;
    amountMinor: string;
    tenderedMinor: string | null;
    changeMinor: string;
    reference: string | null;
  }[];
  privilege: {
    type: string;
    label: string;
    holderName: string;
    idNumber: string;
    applied: boolean;
  } | null;
  footer: string[];
  compliance: { complete: boolean; missing: string[] };
  copy: { kind: "original" | "reprint"; number: number; label: string };
  contentHash: string;
};

export type JournalEntry = {
  seq: number;
  entry_kind: "printed" | "reprinted" | "voided" | "spoiled";
  copy_number: number;
  reason: string | null;
  occurred_at: string;
  actor_name: string | null;
  model_hash: string;
  hash_basis: "print_model" | "document_snapshot";
};

export type ReceiptRow = {
  id: string;
  saleId: string;
  sourceType: string;
  documentNumber: string;
  documentType: string;
  issuedAt: string;
  totalDueMinor: string | null;
  buyerName: string | null;
  privilegeType: string | null;
  voided: boolean;
  reprints: number;
};

/** Itemcount case: PHP 39 VATable item, senior citizen, cash PHP 100 -> PHP 27.86. */
export const fixtureReceipt: ReceiptModel = {
  version: 1,
  documentId: "11111111-1111-4111-8111-111111111111",
  documentType: "sales_invoice",
  title: "SALES INVOICE",
  documentNumber: "SAMPLE-SI-000000042",
  issuedAt: "2026-11-06T02:15:00.000Z",
  status: "valid",
  banner: "NOT FILED - SAMPLE",
  notFiled: true,
  seller: {
    entityName: "SAMPLE company",
    branchName: "SAMPLE Cebu",
    address: "1 Sample Road, Cebu",
    tin: "000-111-222-000",
    tinLabel: "VAT REG TIN",
  },
  registration: {
    ptuNumber: "FP012026-07-0099999",
    ptuIssuedOn: "2026-01-15",
    minNumber: "26011512345678901",
    machineSerial: "H10P758268A0123",
    accreditationNumber: "082-123456789-000123",
    accreditationDate: "2026-01-10",
    permitReference: null,
    status: "sample_not_filed",
  },
  range: {
    prefix: "SAMPLE-SI",
    firstSerial: "1",
    lastSerial: "500",
    firstNumber: "SAMPLE-SI-000000001",
    lastNumber: "SAMPLE-SI-000000500",
  },
  buyer: {
    name: "Sample Store Trading Inc.",
    tin: "123-456-789-000",
    address: "12 Colon St, Cebu City",
    signatureLine: true,
  },
  cashier: "Ana Cashier",
  place: {
    store: "Sample store",
    register: "Sample terminal",
    terminal: "SAMPLE-01",
    truck: null,
    tripNumber: null,
  },
  lines: [
    {
      n: 1,
      productCode: "VAT39",
      description: "Frozen nuggets 39",
      qty: 1,
      qtyText: "1 PC",
      uom: "PC",
      freeQty: 0,
      unitPriceMinor: "3900",
      grossMinor: "3900",
      promoDiscountMinor: "0",
      payableMinor: "2786",
      taxLetter: "V",
      privilegeType: "senior",
    },
  ],
  discountLines: [
    {
      kind: "vat_removed",
      label: "Less: VAT on senior citizen sale",
      amountMinor: "418",
    },
    {
      kind: "privilege",
      privilegeType: "senior",
      label: "Senior citizen discount (20%)",
      amountMinor: "696",
    },
  ],
  totals: {
    grossMinor: "3900",
    promoDiscountMinor: "0",
    privilegeDiscountMinor: "696",
    vatRemovedMinor: "418",
    totalDueMinor: "2786",
    vatableSalesMinor: "0",
    vatMinor: "0",
    vatExemptSalesMinor: "3482",
    zeroRatedSalesMinor: "0",
    tenderedMinor: "10000",
    changeMinor: "7214",
    itemCount: 1,
  },
  tenders: [
    {
      method: "cash",
      label: "Cash",
      amountMinor: "2786",
      tenderedMinor: "10000",
      changeMinor: "7214",
      reference: null,
    },
  ],
  privilege: {
    type: "senior",
    label: "Senior citizen",
    holderName: "Juana Dela Cruz",
    idNumber: "SC-2026-004411",
    applied: true,
  },
  footer: [
    "NOT FILED - SAMPLE - NOT VALID AS A BIR DOCUMENT",
    "POS provider: Cauld & Clark Software, Cebu City, TIN 009-888-777-000",
    "BIR accreditation no. 082-123456789-000123, issued 2026-01-10",
    "PTU no. FP012026-07-0099999, issued 2026-01-15",
  ],
  compliance: { complete: true, missing: [] },
  copy: { kind: "original", number: 0, label: "ORIGINAL" },
  contentHash: "0".repeat(64),
};
