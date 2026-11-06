/** Types and plain-word helpers for the Stores POS day screens (lane ZDAY). The API speaks centavos as strings. */

export type DayStatus = "open" | "closing" | "z_done";

export type TillDaySummary = {
  id: string;
  registerId: string;
  registerName: string;
  terminal: string;
  storeName: string;
  businessDate: string;
  status: DayStatus;
  number: string | null;
  sessions: number;
  openSessions: number;
  pendingReversals: number;
  netSalesCentavos: string;
  zId: string | null;
  zNumber: string | null;
  zCounter: number | null;
  canZ: boolean;
};

export type SessionRow = {
  id: string;
  number: string | null;
  cashier: string;
  openedAt: number;
  closedAt: number | null;
  status: string;
  openingFloat: string;
  cashSales: string;
  floatIn: string;
  paidIn: string;
  drops: string;
  pickups: string;
  paidOut: string;
  /** null while the cashier being counted is the one looking (blind count). */
  expected: string | null;
  declared: string | null;
  variance: string | null;
  forced: boolean;
};

export type PrintLine = {
  label: string;
  value: string | null;
  strong?: boolean;
};
export type PrintModel = {
  title: string;
  docNumber: string | null;
  reprint: boolean;
  sample: boolean;
  lines: PrintLine[];
  footer: string;
};

export type Movement = {
  id: string;
  shiftId: string;
  kind: string;
  label: string;
  amountCentavos: string;
  effectCentavos: string;
  reasonCode: string;
  reasonLabel: string;
  note: string | null;
  supervisorName: string | null;
  slipNumber: string | null;
  recordedBy: string;
  capturedAt: number;
};

export type OverrideRow = {
  id: string;
  registerId: string;
  registerName: string;
  businessDate: string | null;
  kind: string;
  label: string;
  method: "pin_online" | "pin_offline" | "office";
  supervisorName: string;
  cashierName: string | null;
  reason: string | null;
  amountCentavos: string | null;
  refType: string | null;
  refId: string | null;
  capturedAt: number;
};

export type ZSummary = {
  id: string;
  readId: string;
  registerId?: string;
  docNumber?: string;
  businessDate: string;
  zCounter: number;
  resetCounter?: number;
  beginningInvoice?: string | null;
  endingInvoice?: string | null;
  beginningGrossCentavos?: string | null;
  endingGrossCentavos?: string | null;
  beginningNetCentavos?: string | null;
  endingNetCentavos?: string | null;
  grossSalesCentavos?: string | null;
  netSalesCentavos: string | null;
  seniorDiscountCentavos?: string | null;
  pwdDiscountCentavos?: string | null;
  soloParentDiscountCentavos?: string | null;
  athleteDiscountCentavos?: string | null;
  uniformedDiscountCentavos?: string | null;
  voidsCount?: number;
  refundsCount?: number;
  /** Rows written before the typed Z existed. Readable, not itemised. */
  legacy?: boolean;
  typed?: boolean;
};

export type DayDetail = {
  day: {
    id: string;
    registerId: string;
    businessDate: string;
    status: DayStatus;
    number: string | null;
    canZ: boolean;
    openSessions: number;
    pendingReversals: number;
  };
  reading: {
    register: string;
    store: string;
    sessions: SessionRow[];
    sales: { netCentavos: string; transactions: number };
    cash: { expectedCentavos: string };
  };
  printModel: PrintModel;
  movements: Movement[];
  overrides: OverrideRow[];
  xReads: {
    id: string;
    sequence: string;
    capturedAt: number;
    cashier: string;
  }[];
  z: ZSummary | null;
};

export const money = (v: string | null | undefined): number | null =>
  v == null ? null : Number(v);

export function dayStatusWords(status: DayStatus | string): string {
  return (
    (
      {
        open: "Open",
        closing: "Waiting for Z reading",
        z_done: "Day closed (Z done)",
      } as Record<string, string>
    )[status] ?? "Needs review"
  );
}

export function sessionStatusWords(status: string): string {
  return (
    (
      {
        open: "Selling",
        suspended: "On hold",
        closed: "Cash counted",
        needs_review: "Cash difference needs review",
        accepted: "Difference accepted",
        investigate: "Investigate difference",
        force_closed: "Closed by the office (not counted)",
      } as Record<string, string>
    )[status] ?? "Needs review"
  );
}

export const OVERRIDE_WORDS: Record<string, string> = {
  void_line: "Line void",
  void_sale: "Sale void",
  refund: "Refund",
  price: "Price change",
  discount: "Discount",
  reprint: "Reprint",
  no_sale: "No sale (drawer opened)",
  cash_drop: "Cash drop",
  cash_pickup: "Cash pickup",
  paid_out: "Paid out",
  z_reading: "Z reading",
  force_close: "Closed by the office",
};

export function methodWords(method: string): string {
  return method === "pin_offline"
    ? "PIN at the till, offline"
    : method === "pin_online"
      ? "PIN at the till"
      : "Office";
}

/**
 * Queue first: ONE thing to do next for a day, in plain words. `action` is the single primary button.
 */
export function dayNextStep(detail: Pick<DayDetail, "day">): {
  tone: "info" | "warning" | "success";
  text: string;
  action: "z" | "start_closing" | "none";
  actionLabel: string | null;
} {
  const d = detail.day;
  if (d.status === "z_done")
    return {
      tone: "success",
      text: "This day is closed. The Z reading is final; the next cashier session starts a new day.",
      action: "none",
      actionLabel: null,
    };
  if (d.openSessions > 0)
    return {
      tone: "warning",
      text: `${d.openSessions} cashier session${d.openSessions > 1 ? "s are" : " is"} still open. Close ${d.openSessions > 1 ? "them" : "it"} before the Z reading.`,
      action: "none",
      actionLabel: null,
    };
  if (d.pendingReversals > 0)
    return {
      tone: "warning",
      text: `${d.pendingReversals} void or refund ${d.pendingReversals > 1 ? "requests need" : "request needs"} a decision before the Z reading.`,
      action: "none",
      actionLabel: null,
    };
  return {
    tone: "info",
    text: "All cashier sessions are closed. Run the Z reading to close the day.",
    action: "z",
    actionLabel: "Run Z reading",
  };
}
