import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { localDate } from "../coverage/validation";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import {
  CALL_SHEET_HEADER_FIELDS,
  CALL_SHEET_MEASURES,
  MAX_CALL_SHEET_LINES,
  MAX_CALL_SHEET_QUANTITY,
  MAX_CALL_SHEET_TEXT,
  type CallSheetCaptureLine,
  type CallSheetHeader,
} from "./validators";

type Ctx = QueryCtx | MutationCtx;
export const CALL_SHEET_WEEKS = [1, 2, 3, 4] as const;

/**
 * The Annex C form has four week columns. Days 1-7 are week 1, 8-14 week 2, 15-21 week 3 and
 * 22 to month end week 4 (PROVISIONAL until Sunpride sends the Excel template).
 */
export function callSheetWeek(serviceDate: string) {
  localDate(serviceDate);
  const day = Number(serviceDate.slice(8, 10));
  return {
    localMonth: serviceDate.slice(0, 7),
    week: Math.min(4, Math.ceil(day / 7)),
  };
}

function text(value: string | undefined, label: string) {
  const result = value?.trim() ?? "";
  if (result.length > MAX_CALL_SHEET_TEXT)
    throw new ConvexError(`${label} is too long (max ${MAX_CALL_SHEET_TEXT})`);
  return result || undefined;
}

export function cleanHeader(header: CallSheetHeader): CallSheetHeader {
  const accountName = text(header.accountName, "Account name");
  if (!accountName) throw new ConvexError("Account name required");
  const result: CallSheetHeader = { accountName };
  for (const field of CALL_SHEET_HEADER_FIELDS) {
    if (field === "accountName") continue;
    const value = text(header[field], field);
    if (value !== undefined) result[field] = value;
  }
  return result;
}

export function cleanPricing(value: string | undefined) {
  return text(value, "Pricing");
}

export type CallSheetHeaderDTO = {
  [K in (typeof CALL_SHEET_HEADER_FIELDS)[number]]: K extends "accountName"
    ? string
    : string | null;
};
export function headerDTO(header: CallSheetHeader): CallSheetHeaderDTO {
  return {
    accountName: header.accountName,
    address: header.address ?? null,
    buyerName: header.buyerName ?? null,
    contactNumber: header.contactNumber ?? null,
    accountInCharge: header.accountInCharge ?? null,
    receivingInCharge: header.receivingInCharge ?? null,
    distributorName: header.distributorName ?? null,
    distributorSchedule: header.distributorSchedule ?? null,
    foc: header.foc ?? null,
    pricing: header.pricing ?? null,
  };
}

export async function accountFor(ctx: Ctx, outletId: Id<"outlets">) {
  const rows = await ctx.db
    .query("callSheetAccounts")
    .withIndex("by_outletId", (q) => q.eq("outletId", outletId))
    .take(2);
  if (rows.length > 1) throw new ConvexError("Duplicate call sheet account");
  const row = rows[0] ?? null;
  if (row && row.organizationId !== SUNPRIDE_ORGANIZATION_ID)
    throw new ConvexError("Call sheet account not found");
  return row;
}

export function usableProduct(
  product: Doc<"products"> | null,
): product is Doc<"products"> {
  return (
    !!product?.active &&
    (!product.organizationId ||
      product.organizationId === SUNPRIDE_ORGANIZATION_ID)
  );
}

/** Validates a phone capture. Throws invalid_request; the mobile writer maps it to a rejection. */
export function validateCaptureLines(lines: CallSheetCaptureLine[]) {
  if (lines.length < 1 || lines.length > MAX_CALL_SHEET_LINES)
    throw new ConvexError("invalid_request");
  if (new Set(lines.map((line) => line.productId)).size !== lines.length)
    throw new ConvexError("invalid_request");
  for (const line of lines) {
    let captured = 0;
    for (const measure of CALL_SHEET_MEASURES) {
      const value = line[measure];
      if (value === null) continue;
      if (
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > MAX_CALL_SHEET_QUANTITY
      )
        throw new ConvexError("invalid_request");
      captured++;
    }
    if (!captured) throw new ConvexError("invalid_request");
  }
}

export type PhoneCallSheet = {
  outletId: string;
  revision: number;
  header: CallSheetHeaderDTO;
  lines: Array<{
    productId: string;
    code: string;
    name: string;
    uom: string;
    barcode: string | null;
    pricing: string | null;
  }>;
};

/** Phone projection: only active products; stamp changes force a fresh snapshot. */
export async function phoneCallSheet(
  ctx: Ctx,
  account: Doc<"callSheetAccounts">,
  products: Map<
    Id<"products">,
    { product: Doc<"products"> | null; barcode: string | null }
  >,
): Promise<{ sheet: PhoneCallSheet; stamp: string; membershipStamp: string }> {
  const lines: PhoneCallSheet["lines"] = [];
  const stamps: string[] = [];
  for (const line of account.lines) {
    let cached = products.get(line.productId);
    if (!cached) {
      const product = await ctx.db.get(line.productId);
      const barcode = product
        ? (
            await ctx.db
              .query("productBarcodes")
              .withIndex("by_organizationId_and_productId", (q) =>
                q
                  .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
                  .eq("productId", line.productId),
              )
              .take(20)
          ).find((row) => row.active)
        : undefined;
      cached = { product, barcode: barcode?.barcode ?? null };
      products.set(line.productId, cached);
    }
    const { product, barcode } = cached;
    if (!usableProduct(product)) continue;
    lines.push({
      productId: product._id,
      code: product.code,
      name: product.name,
      uom: product.uom,
      barcode: barcode && barcode.length <= 64 ? barcode : null,
      pricing: line.pricing ?? null,
    });
    stamps.push(`${product._id}:${product.updatedAt}:${barcode ?? ""}`);
  }
  return {
    sheet: {
      outletId: account.outletId,
      revision: account.revision,
      header: headerDTO(account.header),
      lines,
    },
    stamp: `${account._id}|${account.revision}|${account.updatedAt}|${stamps.join(",")}`,
    // Sheet and line membership only: product content reaches reference-data phones as deltas.
    membershipStamp: `${account._id}|${account.revision}|${account.updatedAt}|${lines.map((line) => line.productId).join(",")}`,
  };
}
