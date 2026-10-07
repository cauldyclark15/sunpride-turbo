import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import {
  ORG_ROOT_UNIT_CODE,
  SUNPRIDE_ORGANIZATION_ID,
} from "../inventory/constants";
import { hashPayload, postMovement } from "../inventory/posting";
import { buildOpeningBalanceLine } from "../inventory/setup";
import { manilaDate } from "../coverage/validation";
import { insertUomConversion } from "../inventory/policies";
import type { WriteActor } from "../lib/write_actor";
import { addSampleId, externalReferences } from "./sample_dependencies";
import { createOrgUnit } from "../org/mutations";
import { assignOutlet } from "../outlets/assignments";
import { changeOutletCustomerLink, createOutlet } from "../outlets/mutations";
import { decideOutletPin, proposeOutletPin } from "../outlets/verification";
import { recordAssignment } from "../people/validation";
import {
  createTerritory,
  assignTerritorySalesperson,
} from "../territories/mutations";
import { assignRouteSalesperson, createRoute } from "../territories/routes";
import {
  MAX_LINES_PER_PRODUCT,
  MAX_LISTS_PER_CHANNEL,
  PRICE_CURRENCY,
} from "../pricing/model";
import { planLoad, productUnit } from "../van/loads";
import { planTrip } from "../van/trips";
import { OPEN_TRIP_STATUSES, SERVICE_DATE } from "../van/model";
import {
  SAMPLE_ACTOR,
  SAMPLE_BATCH,
  SAMPLE_CATALOG,
  SAMPLE_DEPOT,
  SAMPLE_EPOCH,
  SAMPLE_OPENING_CASES,
  SAMPLE_ORG_UNITS,
  SAMPLE_PEOPLE,
  SAMPLE_PRICE_LISTS,
  SAMPLE_PRODUCTS,
  SAMPLE_PROMOTIONS,
  SAMPLE_ROUTES,
  SAMPLE_STORES,
  SAMPLE_TERRITORIES,
  SAMPLE_TRUCKS,
  SAMPLE_UOMS,
  type SampleChannel,
  type SampleUnit,
  sampleBarcodes,
  samplePrice,
} from "./sample_data";

/**
 * SP-0129 (BETA-SAMPLE-DATA): fills a deployment with clearly marked, made-up master data so
 * beta testers can work before Sunpride's real data arrives.
 *
 *   bunx convex run beta/sample:seed            # idempotent; re-run after testers sign in
 *   bunx convex run beta/sample:reset '{"confirm":"remove-beta-sample"}'   # repeat until done
 *
 * Every row the seed writes is listed in `sampleDataRows` (batch `beta-sample-v1`), so reset
 * removes exactly those rows. Stock goes through `postMovement` (opening balance), tester
 * persona changes through the people assignment-history writer (`recordAssignment`).
 * Effective-dated master data goes through the same domain writers the office mutations use
 * (`createOrgUnit`, `createTerritory`, `createRoute`, `createOutlet`,
 * `changeOutletCustomerLink`, `proposeOutletPin`/`decideOutletPin`, `assignOutlet`,
 * `assignTerritorySalesperson`, `assignRouteSalesperson`, `insertUomConversion`; van days via
 * `planTrip`/`planLoad`) as the trusted `system` actor: every integrity rule runs, only the
 * per-person capability gate is skipped and records may already be in force (a fresh beta
 * backend must be usable at once, while the office writers accept only future changes).
 * Price lists, lines and promotions have no office writer yet; they are written here and by
 * SP-0088's `pricing/sample` only, as marked `source: "sample"` rows.
 * People are invitations only (no passwords): a tester signs up with the invited email, then
 * the next seed run gives them their unit, position, supervisor, territory and route.
 */

/** The seed writes through the domain writers as a trusted system actor (see lib/write_actor). */
const SYSTEM: WriteActor = { kind: "system", subject: SAMPLE_ACTOR };
/** A second system subject: the pin writer demands a reviewer other than the proposer. */
const SYSTEM_VERIFIER: WriteActor = {
  kind: "system",
  subject: `${SAMPLE_ACTOR}:verifier`,
};
const SAMPLE_REASON = "beta sample data";

const CHANNEL_LABEL: Record<SampleChannel, string> = {
  KEY_ACCOUNTS: "Key Accounts",
  ROUTE_SALES: "Route Sales",
  PUBLIC_MARKET: "Public Market",
};

type Counts = Record<string, number>;

class Seeder {
  readonly counts: Counts = {};
  readonly skipped: string[] = [];
  readonly ctx: MutationCtx;
  readonly now: number;
  readonly from: number;
  constructor(ctx: MutationCtx, now: number, from: number) {
    this.ctx = ctx;
    this.now = now;
    this.from = from;
  }

  async trackedId<T extends TableNames>(table: T, key: string) {
    const row = await this.ctx.db
      .query("sampleDataRows")
      .withIndex("by_batch_and_key", (q) =>
        q.eq("batch", SAMPLE_BATCH).eq("key", key),
      )
      .unique();
    if (!row) return null;
    const id = this.ctx.db.normalizeId(table, row.rowId);
    if (id && (await this.ctx.db.get(id))) return id;
    await this.ctx.db.delete(row._id);
    return null;
  }

  async track(table: TableNames, id: string, key: string) {
    await this.ctx.db.insert("sampleDataRows", {
      batch: SAMPLE_BATCH,
      tableName: table,
      rowId: id,
      key,
      createdAt: this.now,
    });
  }

  /**
   * The row for `key`: the one this batch created earlier, else an existing row the caller
   * finds by its natural key (never tracked, never removed), else a new tracked row.
   */
  async ensure<T extends TableNames>(
    table: T,
    key: string,
    find: () => Promise<Id<T> | null>,
    create: () => Promise<Id<T>>,
  ): Promise<Id<T>> {
    const mine = await this.trackedId(table, key);
    if (mine) return mine;
    const existing = await find();
    if (existing) return existing;
    const id = await create();
    await this.track(table, id, key);
    this.counts[table] = (this.counts[table] ?? 0) + 1;
    return id;
  }
}

const org = SUNPRIDE_ORGANIZATION_ID;

async function seedReference(s: Seeder) {
  const { ctx, now, from } = s;
  const uoms = new Map<SampleUnit, Id<"unitsOfMeasure">>();
  for (const unit of SAMPLE_UOMS)
    uoms.set(
      unit.code,
      await s.ensure(
        "unitsOfMeasure",
        `uom:${unit.code}`,
        async () =>
          (
            await ctx.db
              .query("unitsOfMeasure")
              .withIndex("by_organizationId_and_code", (q) =>
                q.eq("organizationId", org).eq("code", unit.code),
              )
              .unique()
          )?._id ?? null,
        () =>
          ctx.db.insert("unitsOfMeasure", {
            organizationId: org,
            code: unit.code,
            name: unit.name,
            dimension: "count",
            decimalPlaces: 0,
            active: true,
            createdAt: now,
            updatedAt: now,
          }),
      ),
    );

  const root = await ctx.db
    .query("orgUnits")
    .withIndex("by_organizationId_and_code", (q) =>
      q.eq("organizationId", org).eq("code", ORG_ROOT_UNIT_CODE),
    )
    .unique();
  if (!root) throw new ConvexError("Organization root is missing");
  const units = new Map<string, Id<"orgUnits">>([["ROOT", root._id]]);
  for (const unit of SAMPLE_ORG_UNITS) {
    const parentId = units.get(unit.parent ?? "ROOT")!;
    units.set(
      unit.code,
      await s.ensure(
        "orgUnits",
        `org:${unit.code}`,
        async () =>
          (
            await ctx.db
              .query("orgUnits")
              .withIndex("by_organizationId_and_code", (q) =>
                q.eq("organizationId", org).eq("code", unit.code),
              )
              .unique()
          )?._id ?? null,
        async () => {
          const { unitId, edgeId } = await createOrgUnit(
            ctx,
            {
              code: unit.code,
              name: unit.name,
              typeCode: unit.typeCode,
              parentId,
              effectiveFrom: from,
              reason: SAMPLE_REASON,
            },
            SYSTEM,
          );
          await s.track("orgUnitParentEdges", edgeId, `edge:${unit.code}`);
          return unitId;
        },
      ),
    );
  }

  const products = new Map<string, Doc<"products">>();
  for (const [index, product] of SAMPLE_PRODUCTS.entries()) {
    const pc = uoms.get("PC")!;
    const sellingUomIds = [pc, uoms.get("CASE")!];
    if (product.packQty) sellingUomIds.push(uoms.get("PACK")!);
    const id = await s.ensure(
      "products",
      `product:${product.code}`,
      async () =>
        (
          await ctx.db
            .query("products")
            .withIndex("by_code", (q) => q.eq("code", product.code))
            .unique()
        )?._id ?? null,
      async () => {
        const productId = await ctx.db.insert("products", {
          code: product.code,
          name: product.name,
          category: product.category,
          uom: "PC",
          // ADR-008: the product master carries no price; prices live in price lists.
          unitPrice: 0,
          active: true,
          organizationId: org,
          baseUomId: pc,
          quantityScale: 1n,
          trackingMode: "none",
          allocationPolicy: "fifo",
          policyVersion: 1,
          sellingUomIds,
          catalogSource: "beta_sample",
          catalogUpdatedAt: now,
          updatedAt: now,
        });
        const policy = await ctx.db.insert("productInventoryPolicies", {
          organizationId: org,
          productId,
          baseUomId: pc,
          quantityScale: 1n,
          quantityPrecision: 0,
          trackingMode: "none",
          allocationPolicy: "fifo",
          allowMixedLotsPerLine: true,
          allowNegativeStock: false,
          qualityReleaseRequired: false,
          shelfLifeDays: product.category === "Frozen" ? 180 : 730,
          expiryDateRequired: false,
          manufactureDateRequired: false,
          minimumRemainingShelfLifeDays: 0,
          costingMethod: "weighted_average",
          version: 1,
          active: true,
          createdAt: now,
          updatedAt: now,
        });
        await s.track(
          "productInventoryPolicies",
          policy,
          `policy:${product.code}`,
        );
        const conversions: [SampleUnit, number][] = [["CASE", product.caseQty]];
        if (product.packQty) conversions.push(["PACK", product.packQty]);
        for (const [unit, quantity] of conversions) {
          const conversion = await insertUomConversion(
            ctx,
            {
              productId,
              fromUomId: uoms.get(unit)!,
              toUomId: pc,
              numerator: BigInt(quantity),
              denominator: 1n,
              roundingMode: "exact",
              effectiveFrom: from,
            },
            SAMPLE_ACTOR,
          );
          await s.track(
            "uomConversions",
            conversion,
            `conversion:${product.code}:${unit}`,
          );
        }
        const codes = sampleBarcodes(index);
        for (const [barcode, unit] of [
          [codes.piece, "PC"],
          [codes.case, "CASE"],
        ] as const) {
          const taken = await ctx.db
            .query("productBarcodes")
            .withIndex("by_organizationId_and_barcode", (q) =>
              q.eq("organizationId", org).eq("barcode", barcode),
            )
            .first();
          if (taken) continue;
          const row = await ctx.db.insert("productBarcodes", {
            organizationId: org,
            productId,
            barcode,
            uomId: uoms.get(unit)!,
            active: true,
            source: "beta_sample",
            createdAt: now,
            updatedAt: now,
          });
          await s.track("productBarcodes", row, `barcode:${barcode}`);
        }
        return productId;
      },
    );
    products.set(product.code, (await ctx.db.get(id))!);
  }
  return { uoms, units, root, products };
}

async function seedPricing(
  s: Seeder,
  ref: Awaited<ReturnType<typeof seedReference>>,
) {
  const { ctx, now, from } = s;
  const lists = new Map<string, Id<"priceLists">>();
  for (const list of SAMPLE_PRICE_LISTS) {
    const byCode = async () =>
      await ctx.db
        .query("priceLists")
        .withIndex("by_organizationId_and_code", (q) =>
          q.eq("organizationId", org).eq("code", list.code),
        )
        .unique();
    // A real (office) list already prices this channel: never add a competing sample list,
    // which would make the channel ambiguous and price nothing (SP-0088 fails closed).
    const sameChannel = await ctx.db
      .query("priceLists")
      .withIndex("by_organizationId_and_channelKey", (q) =>
        q.eq("organizationId", org).eq("channelKey", list.channelKey),
      )
      .take(MAX_LISTS_PER_CHANNEL + 1);
    const existing = await byCode();
    if (
      !existing &&
      sameChannel.some(
        (row) => row.source !== "sample" || row.code !== list.code,
      )
    ) {
      s.skipped.push(`price list ${list.code}: channel already priced`);
      continue;
    }
    if (existing && existing.source !== "sample") {
      s.skipped.push(`price list ${list.code}: code used by an office list`);
      continue;
    }
    const listId = await s.ensure(
      "priceLists",
      `pricelist:${list.code}`,
      async () => (await byCode())?._id ?? null,
      () =>
        ctx.db.insert("priceLists", {
          organizationId: org,
          code: list.code,
          name: list.name,
          channelKey: list.channelKey,
          currency: PRICE_CURRENCY,
          status: "active",
          source: "sample",
          effectiveFrom: from,
          updatedAt: now,
        }),
    );
    lists.set(list.code, listId);
    for (const product of SAMPLE_PRODUCTS) {
      const productId = ref.products.get(product.code)!._id;
      const existingLines = await ctx.db
        .query("priceListLines")
        .withIndex("by_priceListId_and_productId", (q) =>
          q.eq("priceListId", listId).eq("productId", productId),
        )
        .take(MAX_LINES_PER_PRODUCT + 1);
      for (const unit of ["PC", "PACK", "CASE"] as const) {
        const price = samplePrice(product, list, unit);
        if (price === null) continue;
        await s.ensure(
          "priceListLines",
          `priceline:${list.code}:${product.code}:${unit}`,
          async () =>
            existingLines.find((line) => line.uom === unit)?._id ?? null,
          () =>
            ctx.db.insert("priceListLines", {
              organizationId: org,
              priceListId: listId,
              productId,
              uom: unit,
              unitPriceMinor: price,
              effectiveFrom: from,
              updatedAt: now,
            }),
        );
      }
    }
  }
  const unit = ([code, uom, quantity]: [string, SampleUnit, number]) => ({
    productId: ref.products.get(code)!._id,
    uom,
    quantity,
  });
  for (const promotion of SAMPLE_PROMOTIONS) {
    const r = promotion.rule;
    if (promotion.priceListCode && !lists.has(promotion.priceListCode))
      continue;
    const rule =
      r.kind === "buy_x_get_y"
        ? { kind: r.kind, buy: unit(r.buy), free: unit(r.free) }
        : r.kind === "percent_off"
          ? {
              kind: r.kind,
              item: unit(r.item),
              percentOffBasisPoints: r.percentOffBasisPoints,
            }
          : {
              kind: r.kind,
              components: r.components.map(unit),
              bundlePriceMinor: r.bundlePriceMinor,
            };
    await s.ensure(
      "promotions",
      `promotion:${promotion.code}`,
      async () =>
        (
          await ctx.db
            .query("promotions")
            .withIndex("by_organizationId_and_code", (q) =>
              q.eq("organizationId", org).eq("code", promotion.code),
            )
            .unique()
        )?._id ?? null,
      () =>
        ctx.db.insert("promotions", {
          organizationId: org,
          code: promotion.code,
          name: promotion.name,
          ...(promotion.priceListCode
            ? { priceListId: lists.get(promotion.priceListCode)! }
            : {}),
          rule,
          status: "active",
          source: "sample",
          effectiveFrom: from,
          updatedAt: now,
        }),
    );
  }
}

async function seedCoverage(
  s: Seeder,
  ref: Awaited<ReturnType<typeof seedReference>>,
) {
  const { ctx, now, from } = s;
  const territories = new Map<string, Id<"territories">>();
  for (const territory of SAMPLE_TERRITORIES)
    territories.set(
      territory.code,
      await s.ensure(
        "territories",
        `territory:${territory.code}`,
        async () =>
          (
            await ctx.db
              .query("territories")
              .withIndex("by_organizationId_and_code", (q) =>
                q.eq("organizationId", org).eq("code", territory.code),
              )
              .unique()
          )?._id ?? null,
        async () => {
          const { territoryId, ownershipId } = await createTerritory(
            ctx,
            {
              code: territory.code,
              name: territory.name,
              orgUnitId: ref.units.get(territory.orgUnit)!,
              channel: territory.channel,
              effectiveFrom: from,
              reason: SAMPLE_REASON,
            },
            SYSTEM,
          );
          await s.track(
            "territoryOwnerships",
            ownershipId,
            `owner:${territory.code}`,
          );
          return territoryId;
        },
      ),
    );
  const routes = new Map<string, Id<"routes">>();
  for (const route of SAMPLE_ROUTES)
    routes.set(
      route.code,
      await s.ensure(
        "routes",
        `route:${route.code}`,
        async () =>
          (
            await ctx.db
              .query("routes")
              .withIndex("by_organizationId_and_code", (q) =>
                q.eq("organizationId", org).eq("code", route.code),
              )
              .unique()
          )?._id ?? null,
        async () => {
          const { routeId, associationId } = await createRoute(
            ctx,
            {
              territoryId: territories.get(route.territory)!,
              code: route.code,
              name: route.name,
              effectiveFrom: from,
              weekdayTemplate: [...route.weekdays],
              reason: SAMPLE_REASON,
            },
            SYSTEM,
          );
          await s.track(
            "routeTerritories",
            associationId,
            `routeterritory:${route.code}`,
          );
          return routeId;
        },
      ),
    );

  const sequence = new Map<string, number>();
  for (const store of SAMPLE_STORES) {
    const route = SAMPLE_ROUTES.find((row) => row.code === store.route)!;
    const territory = SAMPLE_TERRITORIES.find(
      (row) => row.code === route.territory,
    )!;
    const position = (sequence.get(route.code) ?? 0) + 1;
    sequence.set(route.code, position);
    const customerCode = store.code.replace("SMP-O-", "SMP-C-");
    const customerId = await s.ensure(
      "customers",
      `customer:${customerCode}`,
      async () =>
        (
          await ctx.db
            .query("customers")
            .withIndex("by_code", (q) => q.eq("code", customerCode))
            .unique()
        )?._id ?? null,
      () =>
        ctx.db.insert("customers", {
          code: customerCode,
          name: store.name,
          channel: CHANNEL_LABEL[store.channel],
          territory: territory.name,
          creditLimit: store.creditLimit,
          active: true,
          updatedAt: now,
        }),
    );
    await s.ensure(
      "outlets",
      `outlet:${store.code}`,
      async () =>
        (
          await ctx.db
            .query("outlets")
            .withIndex("by_organizationId_and_code", (q) =>
              q.eq("organizationId", org).eq("code", store.code),
            )
            .unique()
        )?._id ?? null,
      async () => {
        const outletId = await createOutlet(
          ctx,
          {
            code: store.code,
            name: store.name,
            status: "active",
            custodianOrgUnitId: ref.units.get(territory.orgUnit)!,
            channel: CHANNEL_LABEL[store.channel],
            classification: store.classification,
            address: store.address,
            contacts: [{ name: store.contact, phone: store.phone }],
            preferredWeekday: route.weekdays[0],
            visitFrequencyDays: 7,
            reason: SAMPLE_REASON,
          },
          SYSTEM,
        );
        const link = await changeOutletCustomerLink(
          ctx,
          {
            outletId,
            customerId,
            source: "beta_sample",
            effectiveFrom: from,
            reason: SAMPLE_REASON,
          },
          SYSTEM,
        );
        if (link)
          await s.track(
            "outletCustomerLinks",
            link,
            `customerlink:${store.code}`,
          );
        // Proposed by the seed and verified by a second system subject: the writer still
        // demands an independent reviewer, and only verified pins reach the coverage map.
        const pin = await proposeOutletPin(
          ctx,
          {
            outletId,
            latitude: store.lat,
            longitude: store.lng,
            radiusMeters: 75,
            source: "beta_sample",
            reason: SAMPLE_REASON,
          },
          SYSTEM,
        );
        await decideOutletPin(
          ctx,
          { pinId: pin, decision: "verified", reason: SAMPLE_REASON },
          SYSTEM_VERIFIER,
        );
        await s.track("outletPins", pin, `pin:${store.code}`);
        const assignment = await assignOutlet(
          ctx,
          {
            outletId,
            territoryId: territories.get(territory.code)!,
            routeId: routes.get(route.code)!,
            sequence: position,
            effectiveFrom: from,
            reason: SAMPLE_REASON,
          },
          SYSTEM,
        );
        await s.track(
          "outletAssignments",
          assignment,
          `assignment:${store.code}`,
        );
        const list = SAMPLE_PRICE_LISTS.find(
          (row) => row.channel === store.channel,
        )!;
        const account = await ctx.db.insert("callSheetAccounts", {
          organizationId: org,
          outletId,
          revision: 1,
          header: {
            accountName: store.name,
            address: store.address,
            buyerName: store.contact,
            contactNumber: store.phone,
            pricing: list.name,
          },
          lines: SAMPLE_CATALOG[store.channel].map((code) => ({
            productId: ref.products.get(code)!._id,
          })),
          updatedAt: now,
          updatedBy: SAMPLE_ACTOR,
        });
        await s.track("callSheetAccounts", account, `callsheet:${store.code}`);
        return outletId;
      },
    );
  }
  return { territories, routes };
}

async function seedInventory(
  s: Seeder,
  ref: Awaited<ReturnType<typeof seedReference>>,
) {
  const { ctx, now } = s;
  const location = (
    code: string,
    name: string,
    type: "warehouse" | "truck",
    orgUnitId: Id<"orgUnits">,
  ) =>
    s.ensure(
      "inventoryLocations",
      `location:${code}`,
      async () =>
        (
          await ctx.db
            .query("inventoryLocations")
            .withIndex("by_organizationId_and_code", (q) =>
              q.eq("organizationId", org).eq("code", code),
            )
            .unique()
        )?._id ?? null,
      () =>
        ctx.db.insert("inventoryLocations", {
          organizationId: org,
          orgUnitId,
          siteCode: "SMP-CEBU",
          code,
          name,
          type,
          active: true,
          allowsPicking: true,
          allowsReceiving: true,
          allowsSale: type === "truck",
          allowsProduction: false,
          ...(type === "truck" ? { truckCode: code } : {}),
          createdAt: now,
          updatedAt: now,
        }),
    );
  const cebu = ref.units.get(SAMPLE_DEPOT.orgUnit)!;
  const depot = await location(
    SAMPLE_DEPOT.code,
    SAMPLE_DEPOT.name,
    "warehouse",
    cebu,
  );
  for (const truck of SAMPLE_TRUCKS) {
    // A truck belongs to its van seller's unit: a trip is visible only inside that scope.
    const truckUnit = ref.units.get(truck.orgUnit)!;
    const truckLocationId = await location(
      truck.truckLocation,
      `${truck.name} ${truck.plateNumber}`,
      "truck",
      truckUnit,
    );
    await s.ensure(
      "vehicles",
      `vehicle:${truck.vehicleCode}`,
      async () =>
        (
          await ctx.db
            .query("vehicles")
            .withIndex("by_organizationId_and_vehicleCode", (q) =>
              q.eq("organizationId", org).eq("vehicleCode", truck.vehicleCode),
            )
            .first()
        )?._id ?? null,
      () =>
        ctx.db.insert("vehicles", {
          organizationId: org,
          orgUnitId: truckUnit,
          vehicleCode: truck.vehicleCode,
          plateNumber: truck.plateNumber,
          name: truck.name,
          truckLocationId,
          homeLocationId: depot,
          capacityNote: truck.capacityNote,
          status: "active",
          createdBy: SAMPLE_ACTOR,
          createdAt: now,
          updatedAt: now,
        }),
    );
  }

  // Opening depot stock through the one stock writer (ADR-003/007), once per batch.
  const idempotencyKey = `${SAMPLE_BATCH}:opening-stock`;
  if (await s.trackedId("inventoryMovements", "movement:opening")) return;
  const done = await ctx.db
    .query("inventoryCommands")
    .withIndex("by_organizationId_and_idempotencyKey", (q) =>
      q.eq("organizationId", org).eq("idempotencyKey", idempotencyKey),
    )
    .unique();
  if (done) return;
  const sourceReference = `${SAMPLE_BATCH}:opening`;
  const lines = [];
  for (const product of SAMPLE_PRODUCTS)
    lines.push(
      await buildOpeningBalanceLine(ctx, {
        sourceReference,
        line: {
          productId: ref.products.get(product.code)!._id,
          locationId: depot,
          quantityBase: BigInt(product.caseQty * SAMPLE_OPENING_CASES),
        },
      }),
    );
  const movement = await postMovement(ctx, {
    idempotencyKey,
    payloadHash: hashPayload({ sourceReference, lines }),
    commandType: "inventory.openingBalance",
    movementType: "opening_balance",
    sourceType: "cutover",
    sourceDocumentId: sourceReference,
    actorSubject: SAMPLE_ACTOR,
    lines,
    emitIntegrationEvent: false,
  });
  // Track every row the posting wrote so reset removes the opening stock with the sample.
  await s.track("inventoryMovements", movement.movementId, "movement:opening");
  const tracked: [TableNames, string][] = [];
  const movementLines = await ctx.db
    .query("inventoryMovementLines")
    .withIndex("by_organizationId_and_movementId_and_lineNumber", (q) =>
      q.eq("organizationId", org).eq("movementId", movement.movementId),
    )
    .take(200);
  for (const line of movementLines) {
    tracked.push(["inventoryMovementLines", line._id]);
    for (const allocation of await ctx.db
      .query("inventoryAllocations")
      .withIndex("by_organizationId_and_movementLineId", (q) =>
        q.eq("organizationId", org).eq("movementLineId", line._id),
      )
      .take(50))
      tracked.push(["inventoryAllocations", allocation._id]);
  }
  for (const entry of await ctx.db
    .query("inventoryLedgerEntries")
    .withIndex("by_organizationId_and_movementId", (q) =>
      q.eq("organizationId", org).eq("movementId", movement.movementId),
    )
    .take(500))
    tracked.push(["inventoryLedgerEntries", entry._id]);
  for (const product of SAMPLE_PRODUCTS) {
    const balance = await ctx.db
      .query("inventoryBalances")
      .withIndex("by_organizationId_and_productId_and_locationId", (q) =>
        q
          .eq("organizationId", org)
          .eq("productId", ref.products.get(product.code)!._id)
          .eq("locationId", depot),
      )
      .unique();
    if (balance) tracked.push(["inventoryBalances", balance._id]);
  }
  const command = await ctx.db
    .query("inventoryCommands")
    .withIndex("by_organizationId_and_idempotencyKey", (q) =>
      q.eq("organizationId", org).eq("idempotencyKey", idempotencyKey),
    )
    .unique();
  if (command) tracked.push(["inventoryCommands", command._id]);
  for (const [table, id] of tracked)
    await s.track(table, id, `stock:${table}:${id}`);
  s.counts.openingStockLines = lines.length;
}

/** A tester's territory/route link starts with their latest unit assignment (never before it). */
async function linkStart(
  ctx: MutationCtx,
  profileId: Id<"profiles">,
  now: number,
) {
  const latest = await ctx.db
    .query("employeeAssignments")
    .withIndex("by_profileId_and_effectiveFrom", (q) =>
      q.eq("profileId", profileId),
    )
    .order("desc")
    .first();
  return Math.max(now, latest?.effectiveFrom ?? now);
}

async function positionId(ctx: MutationCtx, code: string | undefined) {
  if (!code) return undefined;
  const position = await ctx.db
    .query("positions")
    .withIndex("by_organizationId_and_code", (q) =>
      q.eq("organizationId", org).eq("code", code),
    )
    .unique();
  return position?.active ? position._id : undefined;
}

async function seedPeople(
  s: Seeder,
  ref: Awaited<ReturnType<typeof seedReference>>,
  coverage: Awaited<ReturnType<typeof seedCoverage>>,
) {
  const { ctx, now } = s;
  const pending: string[] = [];
  const attached: string[] = [];
  const profiles = new Map<string, Doc<"profiles">>();
  for (const person of SAMPLE_PEOPLE) {
    const position = await positionId(ctx, person.position);
    const invitation = await ctx.db
      .query("accessInvitations")
      .withIndex("by_email", (q) => q.eq("email", person.email))
      .unique();
    if (!invitation) {
      const id = await ctx.db.insert("accessInvitations", {
        email: person.email,
        name: person.name,
        role: person.role,
        ...(position ? { positionId: position } : {}),
        status: "pending",
        invitedBy: SAMPLE_ACTOR,
        invitedAt: now,
        updatedAt: now,
      });
      await s.track("accessInvitations", id, `invitation:${person.email}`);
      s.counts.accessInvitations = (s.counts.accessInvitations ?? 0) + 1;
    }
    const profile = invitation?.profileId
      ? await ctx.db.get(invitation.profileId)
      : null;
    if (!profile || profile.status !== "active") {
      pending.push(person.email);
      continue;
    }
    profiles.set(person.key, profile);
  }
  // Supervisors first so their people can point at them.
  const order = [...SAMPLE_PEOPLE].sort(
    (a, b) => Number(!!a.supervisedBy) - Number(!!b.supervisedBy),
  );
  for (const person of order) {
    let profile = profiles.get(person.key);
    if (!profile || profile.role === "super_admin") continue;
    const unitId = ref.units.get(person.orgUnit)!;
    const supervisor = person.supervisedBy
      ? profiles.get(person.supervisedBy)
      : undefined;
    const position = await positionId(ctx, person.position);
    const needsUnit = !profile.orgUnitId;
    const needsSupervisor =
      supervisor !== undefined &&
      profile.orgUnitId === unitId &&
      profile.supervisorSubject !== supervisor.authSubject;
    // Only an unassigned tester (or the missing supervisor link) is changed: an admin's
    // later reassignment is never overwritten by a re-run.
    if (needsUnit || needsSupervisor) {
      await recordAssignment(
        ctx,
        profile,
        {
          orgUnitId: unitId,
          role: profile.role,
          ...(position ? { positionId: position } : {}),
          ...(supervisor ? { supervisorId: supervisor._id } : {}),
        },
        "beta sample tester setup",
        SAMPLE_ACTOR,
      );
      profile = (await ctx.db.get(profile._id))!;
      profiles.set(person.key, profile);
      attached.push(person.email);
    }
    if (profile.orgUnitId !== unitId) continue;
    if (person.territory) {
      const territoryId = coverage.territories.get(person.territory)!;
      await s.ensure(
        "territorySalespeople",
        `territoryperson:${person.territory}:${person.email}`,
        async () => {
          const rows = await ctx.db
            .query("territorySalespeople")
            .withIndex("by_profileId_and_effectiveFrom", (q) =>
              q.eq("profileId", profile._id),
            )
            .take(50);
          return (
            rows.find(
              (row) =>
                row.territoryId === territoryId &&
                row.effectiveTo === undefined,
            )?._id ?? null
          );
        },
        async () =>
          assignTerritorySalesperson(
            ctx,
            {
              territoryId,
              profileId: profile._id,
              kind: "primary",
              effectiveFrom: await linkStart(ctx, profile._id, now),
              reason: "beta sample tester setup",
            },
            SYSTEM,
          ),
      );
    }
    if (person.route) {
      const routeId = coverage.routes.get(person.route)!;
      await s.ensure(
        "routeSalespeople",
        `routeperson:${person.route}:${person.email}`,
        async () => {
          const rows = await ctx.db
            .query("routeSalespeople")
            .withIndex("by_profileId_and_effectiveFrom", (q) =>
              q.eq("profileId", profile._id),
            )
            .take(50);
          return (
            rows.find(
              (row) => row.routeId === routeId && row.effectiveTo === undefined,
            )?._id ?? null
          );
        },
        async () =>
          assignRouteSalesperson(
            ctx,
            {
              routeId,
              profileId: profile._id,
              primary: true,
              effectiveFrom: await linkStart(ctx, profile._id, now),
              reason: "beta sample tester setup",
            },
            SYSTEM,
          ),
      );
    }
  }
  return { pending, attached };
}

const summary = v.object({
  batch: v.string(),
  created: v.record(v.string(), v.number()),
  testersPending: v.array(v.string()),
  testersAttached: v.array(v.string()),
  skipped: v.array(v.string()),
});

export const seed = internalMutation({
  args: {},
  returns: summary,
  handler: async (ctx) => {
    const now = Date.now();
    // Root unit + level vocabulary, and the positions/standards of the memo and the
    // 2 Oct 2026 call (both idempotent, real configuration: never removed by reset).
    await ctx.runMutation(internal.migrations.seedOrganizationFoundation, {});
    await ctx.runMutation(internal.sfa.setup.foundation, {});
    const root = await ctx.db
      .query("orgUnits")
      .withIndex("by_organizationId_and_code", (q) =>
        q.eq("organizationId", org).eq("code", ORG_ROOT_UNIT_CODE),
      )
      .unique();
    if (!root) throw new ConvexError("Organization root is missing");
    // Sample records start at the sample epoch, but never before the organization root
    // exists (the writers reject a child that predates its parent) nor in the future.
    const s = new Seeder(
      ctx,
      now,
      Math.min(now, Math.max(SAMPLE_EPOCH, root.effectiveFrom)),
    );
    const ref = await seedReference(s);
    await seedPricing(s, ref);
    const coverage = await seedCoverage(s, ref);
    await seedInventory(s, ref);
    const people = await seedPeople(s, ref, coverage);
    const created = { ...s.counts };
    const auditId = await ctx.db.insert("auditLogs", {
      subject: SAMPLE_ACTOR,
      action: "beta.sample.seeded",
      entityType: "sampleBatch",
      entityId: SAMPLE_BATCH,
      details: JSON.stringify({ created, attached: people.attached.length }),
      createdAt: now,
    });
    await s.track("auditLogs", auditId, `audit:${now}`);
    return {
      batch: SAMPLE_BATCH,
      created,
      testersPending: people.pending,
      testersAttached: people.attached,
      skipped: s.skipped,
    };
  },
});

/** A row this batch created under `key`, else null (never a row it merely found). */
async function sampleRow<T extends TableNames>(
  ctx: MutationCtx,
  table: T,
  key: string,
) {
  const row = await ctx.db
    .query("sampleDataRows")
    .withIndex("by_batch_and_key", (q) =>
      q.eq("batch", SAMPLE_BATCH).eq("key", key),
    )
    .unique();
  return row ? ctx.db.normalizeId(table, row.rowId) : null;
}

const MAX_SAMPLE_ROWS = 5_000;

/**
 * Why removing the sample now would break someone else's data (empty = safe). Reset refuses
 * while testers or real work depend on sample rows: deleting them would leave profiles and
 * assignment history pointing at removed units, and deleting a depot balance that a later
 * movement changed would break the stock ledger (ADR-003/007). Finally every schema field that
 * can hold a sample row's ID is searched for a row the seed did not create
 * (`sample_dependencies.ts`). Each check is bounded and fails closed.
 */
export async function resetBlockers(ctx: MutationCtx) {
  const blockers: string[] = [];
  for (const person of SAMPLE_PEOPLE) {
    const id = await sampleRow(
      ctx,
      "accessInvitations",
      `invitation:${person.email}`,
    );
    const invitation = id ? await ctx.db.get(id) : null;
    if (invitation?.profileId)
      blockers.push(`tester ${person.email} has signed up`);
  }
  for (const unit of SAMPLE_ORG_UNITS) {
    const id = await sampleRow(ctx, "orgUnits", `org:${unit.code}`);
    if (!id) continue;
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_orgUnitId", (q) => q.eq("orgUnitId", id))
      .first();
    const history = await ctx.db
      .query("employeeAssignments")
      .withIndex("by_orgUnitId_and_effectiveFrom", (q) => q.eq("orgUnitId", id))
      .first();
    if (profile || history)
      blockers.push(`people are or were assigned to ${unit.code}`);
  }
  const opening = await sampleRow(
    ctx,
    "inventoryMovements",
    "movement:opening",
  );
  for (const code of [
    SAMPLE_DEPOT.code,
    ...SAMPLE_TRUCKS.map((truck) => truck.truckLocation),
  ]) {
    const id = await sampleRow(ctx, "inventoryLocations", `location:${code}`);
    if (!id) continue;
    const balances = await ctx.db
      .query("inventoryBalances")
      .withIndex("by_organizationId_and_locationId_and_productId", (q) =>
        q.eq("organizationId", org).eq("locationId", id),
      )
      .take(SAMPLE_PRODUCTS.length + 1);
    let moved = balances.length > SAMPLE_PRODUCTS.length;
    for (const balance of balances) {
      if (moved) break;
      moved =
        balance.lastMovementId === undefined ||
        balance.lastMovementId !== opening ||
        (await sampleRow(
          ctx,
          "inventoryBalances",
          `stock:inventoryBalances:${balance._id}`,
        )) === null;
    }
    if (moved) blockers.push(`stock has moved at ${code}`);
  }
  for (const truck of SAMPLE_TRUCKS) {
    const id = await sampleRow(ctx, "vehicles", `vehicle:${truck.vehicleCode}`);
    if (!id) continue;
    const trip = await ctx.db
      .query("vanTrips")
      .withIndex("by_vehicleId_and_serviceDate", (q) => q.eq("vehicleId", id))
      .first();
    if (trip) blockers.push(`truck ${truck.vehicleCode} has trips`);
  }
  for (const store of SAMPLE_STORES) {
    const outletId = await sampleRow(ctx, "outlets", `outlet:${store.code}`);
    const visit = outletId
      ? await ctx.db
          .query("visitExecutions")
          .withIndex("by_outletId_and_serviceDate", (q) =>
            q.eq("outletId", outletId),
          )
          .first()
      : null;
    const customerCode = store.code.replace("SMP-O-", "SMP-C-");
    const customerId = await sampleRow(
      ctx,
      "customers",
      `customer:${customerCode}`,
    );
    const order = customerId
      ? await ctx.db
          .query("orders")
          .withIndex("by_customer", (q) => q.eq("customerCode", customerCode))
          .first()
      : null;
    if (visit || order)
      blockers.push(`store ${store.code} has visits or orders`);
  }
  // The full closure: any row the seed did not create that holds an ID of a sample row
  // (stock of a sample product at a real warehouse, a real order line, …).
  const tracked = new Set<string>();
  const sampleIds = new Map<string, Set<string>>();
  const rows = await ctx.db
    .query("sampleDataRows")
    .withIndex("by_batch", (q) => q.eq("batch", SAMPLE_BATCH))
    .take(MAX_SAMPLE_ROWS + 1);
  if (rows.length > MAX_SAMPLE_ROWS)
    blockers.push(`more than ${MAX_SAMPLE_ROWS} sample rows to check`);
  for (const row of rows) {
    tracked.add(row.rowId);
    addSampleId(sampleIds, row.tableName, row.rowId);
  }
  for (const blocker of await externalReferences(
    ctx,
    sampleIds,
    tracked,
    // A sample price list another seed has added lines to is kept, not deleted (see reset).
    (reference) =>
      reference.table === "priceListLines" && reference.target === "priceLists",
  ))
    if (!blockers.includes(blocker)) blockers.push(blocker);
  return blockers;
}

/**
 * Removes every row the sample seed created, newest first (children before parents), in
 * bounded batches: repeat until `isDone`. Only for an unused sample (a fresh deployment, or
 * before testers sign up): while testers or their work depend on sample rows it refuses and
 * removes nothing (see `resetBlockers`); retire a used beta backend instead of resetting it.
 * A sample price list another seed has since added lines to is kept (its lines would orphan).
 */
export const reset = internalMutation({
  args: {
    confirm: v.literal("remove-beta-sample"),
    limit: v.optional(v.number()),
  },
  returns: v.object({ deleted: v.number(), isDone: v.boolean() }),
  handler: async (ctx, args) => {
    const blockers = await resetBlockers(ctx);
    if (blockers.length > 0)
      throw new ConvexError(
        `The beta sample is in use and was not removed: ${blockers.slice(0, 10).join("; ")}`,
      );
    const limit = Math.max(1, Math.min(args.limit ?? 400, 1_000));
    const rows = await ctx.db
      .query("sampleDataRows")
      .withIndex("by_batch", (q) => q.eq("batch", SAMPLE_BATCH))
      .order("desc")
      .take(limit + 1);
    let deleted = 0;
    for (const row of rows.slice(0, limit)) {
      const id = ctx.db.normalizeId(row.tableName as TableNames, row.rowId);
      const doc = id ? await ctx.db.get(id) : null;
      const shared =
        row.tableName === "priceLists" &&
        doc !== null &&
        (await ctx.db
          .query("priceListLines")
          .withIndex("by_priceListId_and_productId", (q) =>
            q.eq("priceListId", doc._id as Id<"priceLists">),
          )
          .first()) !== null;
      if (id && doc && !shared) {
        await ctx.db.delete(id);
        deleted += 1;
      }
      await ctx.db.delete(row._id);
    }
    return { deleted, isDone: rows.length <= limit };
  },
});

/** What the van tester's truck carries on a sample day: cases of the fast movers. */
const SAMPLE_VAN_LOAD: [string, number][] = [
  ["SMP-PJ-240", 5],
  ["SMP-CB-150", 2],
  ["SMP-LM-165", 2],
  ["SMP-SRD-155", 1],
  ["SMP-PCH-227", 1],
  ["SMP-FCK-432", 2],
  ["SMP-SPS-250", 1],
  ["SMP-PCM-400", 2],
  ["SMP-PJ-1L", 2],
  ["SMP-GJM-25", 1],
];

/**
 * Plans the van tester's trip and load sheet for a Manila service day (default today) on
 * `SMP-TRK-01` / `SMP-R-CBS-1`, as the office's trip and load-sheet writers would (status
 * `loading`). There is no web screen for van trip planning yet, so the lead runs this each
 * test day. Stock moves only when the handheld confirms the load (postMovement). Idempotent:
 * an open trip for the seller that day is returned unchanged.
 */
export const planVanDay = internalMutation({
  args: { serviceDate: v.optional(v.string()) },
  returns: v.union(
    v.object({ tripId: v.id("vanTrips"), tripNumber: v.string() }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const now = Date.now();
    const serviceDate = args.serviceDate ?? manilaDate(now);
    if (!SERVICE_DATE.test(serviceDate) || serviceDate < manilaDate(now))
      throw new ConvexError("A trip cannot be planned for a past day");
    const person = SAMPLE_PEOPLE.find((row) => row.key === "van")!;
    const invitation = await ctx.db
      .query("accessInvitations")
      .withIndex("by_email", (q) => q.eq("email", person.email))
      .unique();
    const seller = invitation?.profileId
      ? await ctx.db.get(invitation.profileId)
      : null;
    if (!seller?.orgUnitId || seller.status !== "active") return null;
    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_organizationId_and_vehicleCode", (q) =>
        q
          .eq("organizationId", org)
          .eq("vehicleCode", SAMPLE_TRUCKS[0].vehicleCode),
      )
      .first();
    const route = await ctx.db
      .query("routes")
      .withIndex("by_organizationId_and_code", (q) =>
        q.eq("organizationId", org).eq("code", person.route!),
      )
      .unique();
    if (!vehicle || vehicle.status !== "active" || !route)
      throw new ConvexError("Run beta/sample:seed first");
    const sameSeller = await ctx.db
      .query("vanTrips")
      .withIndex("by_salespersonProfileId_and_serviceDate", (q) =>
        q.eq("salespersonProfileId", seller._id).eq("serviceDate", serviceDate),
      )
      .take(50);
    const open = sameSeller.find((trip) =>
      OPEN_TRIP_STATUSES.includes(trip.status),
    );
    if (open) return { tripId: open._id, tripNumber: open.tripNumber };
    const { tripId, tripNumber } = await planTrip(
      ctx,
      {
        vehicleId: vehicle._id,
        serviceDate,
        salespersonProfileId: seller._id,
        routeId: route._id,
        driverName: "Nonoy Pepito",
        helperName: "Bong Alcantara",
      },
      SYSTEM,
    );
    const lines = [];
    for (const [code, cases] of SAMPLE_VAN_LOAD) {
      const sample = SAMPLE_PRODUCTS.find((row) => row.code === code)!;
      const product = await ctx.db
        .query("products")
        .withIndex("by_code", (q) => q.eq("code", code))
        .unique();
      if (!product?.active) throw new ConvexError("Run beta/sample:seed first");
      const unit = await productUnit(ctx, product);
      lines.push({
        productId: product._id,
        expectedBase: BigInt(sample.caseQty * cases) * unit.quantityScale,
      });
    }
    await planLoad(ctx, { tripId, lines }, SYSTEM);
    return { tripId, tripNumber };
  },
});
