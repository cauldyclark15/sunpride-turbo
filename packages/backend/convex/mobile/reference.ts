import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  DEFAULT_QUANTITY_SCALE,
  SUNPRIDE_ORGANIZATION_ID,
} from "../inventory/constants";
import { usableProduct } from "../callSheets/model";
import type { AuthorizedDevice } from "./types";

/**
 * Reference data for a field phone (SP-0051): the products on its own accounts' call sheets
 * and their stock at its own unit's sale locations. Opt-in per bootstrap; see
 * docs/runbooks/MOBILE_REFERENCE_DATA.md.
 */
export const MAX_REFERENCE_PRODUCTS = 300;
export const MAX_SALE_LOCATIONS = 10;
export const MAX_UNIT_LOCATIONS_SCANNED = 200;
export const MAX_LOCATION_BALANCES = 1000;
/** Active barcodes one product may ship; the v1 contract (and the native decoders) cap it at 20. */
export const MAX_BARCODES = 20;
/** Every barcode row of one product (inactive history included) is read up to this bound. */
export const MAX_BARCODE_HISTORY = 50;
/** Conversion history read per unit pair; more rows fail loudly instead of being skipped. */
export const MAX_CONVERSION_HISTORY = 100;
/** Pulls re-read this overlap so a commit that lands after a pull is never skipped. */
export const REFERENCE_OVERLAP_MS = 60_000;

const uomDTO = v.object({
  code: v.string(),
  name: v.string(),
  decimalPlaces: v.number(),
});
export const catalogItemDTO = v.object({
  id: v.string(),
  code: v.string(),
  name: v.string(),
  uom: v.string(),
  revision: v.optional(v.number()),
  quantityScale: v.optional(v.number()),
  baseUom: v.optional(v.union(uomDTO, v.null())),
  sellingUoms: v.optional(
    v.array(
      v.object({
        code: v.string(),
        name: v.string(),
        decimalPlaces: v.number(),
        toBase: v.union(
          v.object({
            numerator: v.number(),
            denominator: v.number(),
            roundingMode: v.string(),
          }),
          v.null(),
        ),
      }),
    ),
  ),
  barcodes: v.optional(
    v.array(
      v.object({ barcode: v.string(), uom: v.union(v.string(), v.null()) }),
    ),
  ),
});
export const availabilityDTO = v.object({
  id: v.string(),
  productId: v.string(),
  locationId: v.string(),
  locationCode: v.string(),
  locationName: v.string(),
  availableBase: v.number(),
  physicalBase: v.number(),
  reservedBase: v.number(),
  revision: v.number(),
  asOf: v.number(),
});
export type CatalogItem = typeof catalogItemDTO.type & { revision: number };
export type Availability = typeof availabilityDTO.type;
export type ReferenceProjection = {
  products: CatalogItem[];
  availability: Availability[];
  /** Membership only (which products and locations); content travels as revisions. */
  membership: unknown;
};

function tooLarge(): never {
  throw new ConvexError("reference_data_too_large");
}
function safe(value: bigint | undefined) {
  const n = Number(value ?? 0n);
  if (!Number.isSafeInteger(n)) tooLarge();
  return n;
}

export type Caches = {
  uoms: Map<Id<"unitsOfMeasure">, Doc<"unitsOfMeasure"> | null>;
  global: Map<string, Doc<"uomConversions">[]>;
};

/** All conversion rows for one unit pair (product-specific or global), or an explicit failure. */
async function conversionHistory(
  ctx: QueryCtx,
  productId: Id<"products"> | undefined,
  from: Id<"unitsOfMeasure">,
  to: Id<"unitsOfMeasure">,
) {
  const rows = await ctx.db
    .query("uomConversions")
    .withIndex(
      "by_organizationId_and_productId_and_fromUomId_and_toUomId",
      (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("productId", productId)
          .eq("fromUomId", from)
          .eq("toUomId", to),
    )
    .take(MAX_CONVERSION_HISTORY + 1);
  if (rows.length > MAX_CONVERSION_HISTORY) tooLarge();
  return rows;
}

export async function uom(
  ctx: QueryCtx,
  caches: Caches,
  id: Id<"unitsOfMeasure">,
) {
  let row = caches.uoms.get(id);
  if (row === undefined) {
    row = await ctx.db.get(id);
    if (row && row.organizationId !== SUNPRIDE_ORGANIZATION_ID) row = null;
    caches.uoms.set(id, row);
  }
  return row;
}

/** The in-force conversion plus every timestamp that can change which one is in force. */
export async function toBase(
  ctx: QueryCtx,
  caches: Caches,
  product: Doc<"products">,
  from: Id<"unitsOfMeasure">,
  now: number,
) {
  const base = product.baseUomId;
  if (!base) return { conversion: null, revision: 0 };
  // Every row for the pair is read (bounded, overflow fails), so a later or global
  // conversion is never hidden behind older or other products' rows.
  const specific = await conversionHistory(ctx, product._id, from, base);
  const key = `${from}|${base}`;
  let global = caches.global.get(key);
  if (!global) {
    global = await conversionHistory(ctx, undefined, from, base);
    caches.global.set(key, global);
  }
  let revision = 0;
  for (const row of [...specific, ...global])
    for (const at of [row.updatedAt, row.effectiveFrom, row.effectiveTo])
      if (at !== undefined && at <= now) revision = Math.max(revision, at);
  const inForce = (rows: Doc<"uomConversions">[]) =>
    rows
      .filter(
        (row) =>
          row.active &&
          row.effectiveFrom <= now &&
          (!row.effectiveTo || row.effectiveTo >= now),
      )
      .sort((a, b) => b.effectiveFrom - a.effectiveFrom)[0];
  // Same precedence as inventory/policies.convert: product-specific wins.
  const conversion = inForce(specific) ?? inForce(global) ?? null;
  return { conversion, revision };
}

async function catalogItem(
  ctx: QueryCtx,
  caches: Caches,
  product: Doc<"products">,
  now: number,
): Promise<CatalogItem> {
  let revision = product.updatedAt;
  const barcodeRows = await ctx.db
    .query("productBarcodes")
    .withIndex("by_organizationId_and_productId", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("productId", product._id),
    )
    .take(MAX_BARCODE_HISTORY + 1);
  // The whole history is read so an active row (or a revision bump) after older or
  // retired rows is never silently dropped; overflow fails instead of truncating.
  if (barcodeRows.length > MAX_BARCODE_HISTORY) tooLarge();
  const barcodes: NonNullable<CatalogItem["barcodes"]> = [];
  for (const row of barcodeRows) {
    revision = Math.max(revision, row.updatedAt);
    if (!row.active || row.barcode.length > 64) continue;
    const unit = await uom(ctx, caches, row.uomId);
    if (unit) revision = Math.max(revision, unit.updatedAt);
    // A barcode for a retired or unknown unit must not scan into that unit.
    if (!unit?.active) continue;
    barcodes.push({ barcode: row.barcode, uom: unit.code });
  }
  // More shippable barcodes than the contract allows: fail closed, never a partial list.
  if (barcodes.length > MAX_BARCODES) tooLarge();
  const storedBase = product.baseUomId
    ? await uom(ctx, caches, product.baseUomId)
    : null;
  if (storedBase) revision = Math.max(revision, storedBase.updatedAt);
  const baseRow = storedBase?.active ? storedBase : null;
  const sellingUoms: NonNullable<CatalogItem["sellingUoms"]> = [];
  for (const id of product.sellingUomIds ?? []) {
    const row = await uom(ctx, caches, id);
    if (!row) continue;
    revision = Math.max(revision, row.updatedAt);
    if (!row.active) continue;
    // No conversion into a retired base unit.
    const found = baseRow
      ? await toBase(ctx, caches, product, id, now)
      : { conversion: null, revision: 0 };
    revision = Math.max(revision, found.revision);
    sellingUoms.push({
      code: row.code,
      name: row.name,
      decimalPlaces: row.decimalPlaces,
      toBase: found.conversion
        ? {
            numerator: safe(found.conversion.numerator),
            denominator: safe(found.conversion.denominator),
            roundingMode: found.conversion.roundingMode,
          }
        : null,
    });
  }
  return {
    id: product._id,
    code: product.code,
    name: product.name,
    uom: product.uom,
    revision,
    quantityScale: safe(product.quantityScale ?? DEFAULT_QUANTITY_SCALE),
    baseUom: baseRow
      ? {
          code: baseRow.code,
          name: baseRow.name,
          decimalPlaces: baseRow.decimalPlaces,
        }
      : null,
    sellingUoms,
    barcodes,
  };
}

/** Sale locations of the phone's own unit; a parent or neighbouring unit is never included. */
async function saleLocations(ctx: QueryCtx, actor: AuthorizedDevice) {
  const rows = await ctx.db
    .query("inventoryLocations")
    .withIndex("by_orgUnitId", (q) => q.eq("orgUnitId", actor.orgUnitId))
    .take(MAX_UNIT_LOCATIONS_SCANNED + 1);
  if (rows.length > MAX_UNIT_LOCATIONS_SCANNED) tooLarge();
  const sale = rows
    .filter(
      (row) =>
        row.organizationId === SUNPRIDE_ORGANIZATION_ID &&
        row.active &&
        row.allowsSale,
    )
    .sort((a, b) => a.code.localeCompare(b.code) || a._id.localeCompare(b._id));
  if (sale.length > MAX_SALE_LOCATIONS) tooLarge();
  return sale;
}

export async function referenceProjection(
  ctx: QueryCtx,
  actor: AuthorizedDevice,
  productIds: Iterable<Id<"products">>,
  now: number,
): Promise<ReferenceProjection> {
  const ids = [...new Set(productIds)];
  if (ids.length > MAX_REFERENCE_PRODUCTS) tooLarge();
  const caches: Caches = { uoms: new Map(), global: new Map() };
  const products: CatalogItem[] = [];
  for (const id of ids) {
    const product = await ctx.db.get(id);
    // Membership comes from the call sheet, which already dropped unusable products.
    if (!usableProduct(product)) continue;
    products.push(await catalogItem(ctx, caches, product, now));
  }
  products.sort(
    (a, b) => a.code.localeCompare(b.code) || a.id.localeCompare(b.id),
  );
  const byId = new Map(products.map((p) => [p.id, p]));
  const locations = await saleLocations(ctx, actor);
  const availability: Availability[] = [];
  for (const location of locations) {
    const balances = await ctx.db
      .query("inventoryBalances")
      .withIndex("by_organizationId_and_locationId_and_productId", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("locationId", location._id),
      )
      .take(MAX_LOCATION_BALANCES + 1);
    if (balances.length > MAX_LOCATION_BALANCES) tooLarge();
    const rows = balances
      .filter((row) => row.productId && byId.has(row.productId))
      .sort((a, b) =>
        byId
          .get(a.productId!)!
          .code.localeCompare(byId.get(b.productId!)!.code),
      );
    for (const row of rows)
      availability.push({
        id: row._id,
        productId: row.productId!,
        locationId: location._id,
        locationCode: location.code,
        locationName: location.name,
        availableBase: safe(row.availableBase),
        physicalBase: safe(row.physicalBase),
        reservedBase: safe(row.reservedBase),
        revision: row.asOf,
        asOf: row.asOf,
      });
  }
  return {
    products,
    availability,
    membership: {
      products: products.map((p) => p.id),
      locations: locations.map((l) => [l._id, l.code, l.name, l.updatedAt]),
    },
  };
}

export type ReferenceChange = {
  entity: "product" | "inventory";
  id: string;
  revision: number;
  value: CatalogItem | Availability;
  key: string;
};

/** Stable order inside a pull cycle: revision, then entity, then ID. */
export function referenceChanges(projection: ReferenceProjection) {
  const key = (revision: number, entity: string, id: string) =>
    `${String(revision).padStart(16, "0")}|${entity}|${id}`;
  const changes: ReferenceChange[] = [
    ...projection.products.map((value) => ({
      entity: "product" as const,
      id: value.id,
      revision: value.revision,
      value,
      key: key(value.revision, "product", value.id),
    })),
    ...projection.availability.map((value) => ({
      entity: "inventory" as const,
      id: value.id,
      revision: value.revision,
      value,
      key: key(value.revision, "inventory", value.id),
    })),
  ];
  return changes.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
