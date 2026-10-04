import { v } from "convex/values";
import type { Infer } from "convex/values";

/**
 * Annex C "Call Sheet" (Sales Operations Standards memo, 2026-01-20). Header labels follow the
 * scanned form: Account Name, Address, Buyer Name, Contact #, Acct In-charge, Receiving In-charge,
 * Distributor Name, Sched & Cont #, FOC, Pricing. The client's original Excel template is still
 * outstanding (client call 2 Oct 2026, question 10); field names are ours.
 */
export const CALL_SHEET_HEADER_FIELDS = [
  "accountName",
  "address",
  "buyerName",
  "contactNumber",
  "accountInCharge",
  "receivingInCharge",
  "distributorName",
  "distributorSchedule",
  "foc",
  "pricing",
] as const;
export type CallSheetHeaderField = (typeof CALL_SHEET_HEADER_FIELDS)[number];

/** Per product, per week: Order / Beginning Inventory / Take / Delivered / Off-take / End Inventory. */
export const CALL_SHEET_MEASURES = [
  "order",
  "beginningInventory",
  "take",
  "delivered",
  "offtake",
  "endInventory",
] as const;
export type CallSheetMeasure = (typeof CALL_SHEET_MEASURES)[number];

export const MAX_CALL_SHEET_LINES = 100;
export const MAX_CALL_SHEET_QUANTITY = 1_000_000;
export const MAX_CALL_SHEET_TEXT = 200;

export const callSheetHeaderValidator = v.object({
  accountName: v.string(),
  address: v.optional(v.string()),
  buyerName: v.optional(v.string()),
  contactNumber: v.optional(v.string()),
  accountInCharge: v.optional(v.string()),
  receivingInCharge: v.optional(v.string()),
  distributorName: v.optional(v.string()),
  distributorSchedule: v.optional(v.string()),
  foc: v.optional(v.string()),
  pricing: v.optional(v.string()),
});
export type CallSheetHeader = Infer<typeof callSheetHeaderValidator>;

export const callSheetTemplateLineValidator = v.object({
  productId: v.id("products"),
  pricing: v.optional(v.string()),
});

const quantity = v.union(v.number(), v.null());
/** One captured product row; null = not captured on this visit. */
export const callSheetCaptureLineValidator = v.object({
  productId: v.id("products"),
  order: quantity,
  beginningInventory: quantity,
  take: quantity,
  delivered: quantity,
  offtake: quantity,
  endInventory: quantity,
});
export type CallSheetCaptureLine = Infer<typeof callSheetCaptureLineValidator>;

export const callSheetActivityValidator = v.object({
  kind: v.literal("call_sheet"),
  lines: v.array(callSheetCaptureLineValidator),
});
