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
import { audit } from "../org/validation";
import { recordAssignment } from "../people/validation";
import { productUnit } from "../van/loads";
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
 * Effective-dated master data (org units, territories, routes, outlets) is written as the
 * office writers would leave it — identity row plus its history/ownership/edge row — but
 * already in force from the sample epoch, because the public writers only accept
 * future-effective changes and a fresh beta backend must be usable immediately.
 * People are invitations only (no passwords): a tester signs up with the invited email, then
 * the next seed run gives them their unit, position, supervisor, territory and route.
 */

const CHANNEL_LABEL: Record<SampleChannel, string> = {
  KEY_ACCOUNTS: "Key Accounts",
  ROUTE_SALES: "Route Sales",
  PUBLIC_MARKET: "Public Market",
};

type Counts = Record<string, number>;

class Seeder {
  readonly counts: Counts = {};
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
          const id = await ctx.db.insert("orgUnits", {
            organizationId: org,
            code: unit.code,
            name: unit.name,
            typeCode: unit.typeCode,
            parentId,
            status: "active",
            effectiveFrom: from,
            createdAt: now,
            updatedAt: now,
          });
          const edge = await ctx.db.insert("orgUnitParentEdges", {
            unitId: id,
            parentId,
            effectiveFrom: from,
            actorSubject: SAMPLE_ACTOR,
            reason: "beta sample data",
            createdAt: now,
          });
          await s.track("orgUnitParentEdges", edge, `edge:${unit.code}`);
          return id;
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
          const conversion = await ctx.db.insert("uomConversions", {
            organizationId: org,
            productId,
            fromUomId: uoms.get(unit)!,
            toUomId: pc,
            numerator: BigInt(quantity),
            denominator: 1n,
            roundingMode: "exact",
            effectiveFrom: from,
            active: true,
            createdAt: now,
            updatedAt: now,
          });
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
    const listId = await s.ensure(
      "priceLists",
      `pricelist:${list.code}`,
      async () =>
        (
          await ctx.db
            .query("priceLists")
            .withIndex("by_organizationId_and_code", (q) =>
              q.eq("organizationId", org).eq("code", list.code),
            )
            .unique()
        )?._id ?? null,
      () =>
        ctx.db.insert("priceLists", {
          organizationId: org,
          code: list.code,
          name: list.name,
          channel: list.channel,
          currency: "PHP",
          vatInclusive: true,
          status: "active",
          source: "beta_sample",
          createdAt: now,
          updatedAt: now,
        }),
    );
    lists.set(list.code, listId);
    for (const product of SAMPLE_PRODUCTS) {
      const productId = ref.products.get(product.code)!._id;
      for (const unit of ["PC", "PACK", "CASE"] as const) {
        const price = samplePrice(product, list, unit);
        if (price === null) continue;
        const uomId = ref.uoms.get(unit)!;
        await s.ensure(
          "priceListLines",
          `priceline:${list.code}:${product.code}:${unit}`,
          async () =>
            (
              await ctx.db
                .query("priceListLines")
                .withIndex("by_priceListId_and_productId_and_uomId", (q) =>
                  q
                    .eq("priceListId", listId)
                    .eq("productId", productId)
                    .eq("uomId", uomId),
                )
                .first()
            )?._id ?? null,
          () =>
            ctx.db.insert("priceListLines", {
              organizationId: org,
              priceListId: listId,
              productId,
              uomId,
              unitPriceMinor: BigInt(price),
              effectiveFrom: from,
              actorSubject: SAMPLE_ACTOR,
              createdAt: now,
            }),
        );
      }
    }
  }
  const unit = ([code, uom, quantity]: [string, SampleUnit, number]) => ({
    productId: ref.products.get(code)!._id,
    uomId: ref.uoms.get(uom)!,
    quantity,
  });
  for (const promotion of SAMPLE_PROMOTIONS) {
    const r = promotion.rule;
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
              bundlePriceMinor: BigInt(r.bundlePriceMinor),
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
          source: "beta_sample",
          effectiveFrom: from,
          createdAt: now,
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
          const id = await ctx.db.insert("territories", {
            organizationId: org,
            code: territory.code,
            name: territory.name,
            channel: territory.channel,
            status: "active",
            effectiveFrom: from,
            createdAt: now,
            updatedAt: now,
            createdBy: SAMPLE_ACTOR,
          });
          const owner = await ctx.db.insert("territoryOwnerships", {
            territoryId: id,
            orgUnitId: ref.units.get(territory.orgUnit)!,
            effectiveFrom: from,
            actorSubject: SAMPLE_ACTOR,
            reason: "beta sample data",
            createdAt: now,
          });
          await s.track(
            "territoryOwnerships",
            owner,
            `owner:${territory.code}`,
          );
          return id;
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
          const id = await ctx.db.insert("routes", {
            organizationId: org,
            code: route.code,
            name: route.name,
            status: "active",
            effectiveFrom: from,
            weekdayTemplate: [...route.weekdays],
            createdAt: now,
            updatedAt: now,
            createdBy: SAMPLE_ACTOR,
          });
          const link = await ctx.db.insert("routeTerritories", {
            routeId: id,
            territoryId: territories.get(route.territory)!,
            effectiveFrom: from,
            actorSubject: SAMPLE_ACTOR,
            reason: "beta sample data",
            createdAt: now,
          });
          await s.track(
            "routeTerritories",
            link,
            `routeterritory:${route.code}`,
          );
          return id;
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
        const outletId = await ctx.db.insert("outlets", {
          organizationId: org,
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
          createdAt: now,
          updatedAt: now,
          createdBy: SAMPLE_ACTOR,
        });
        const link = await ctx.db.insert("outletCustomerLinks", {
          outletId,
          customerId,
          source: "beta_sample",
          effectiveFrom: from,
          actorSubject: SAMPLE_ACTOR,
          reason: "beta sample data",
          createdAt: now,
        });
        await s.track(
          "outletCustomerLinks",
          link,
          `customerlink:${store.code}`,
        );
        const pin = await ctx.db.insert("outletPins", {
          outletId,
          latitude: store.lat,
          longitude: store.lng,
          radiusMeters: 75,
          source: "beta_sample",
          status: "verified",
          effectiveFrom: from,
          proposedBy: SAMPLE_ACTOR,
          proposedAt: now,
          verifiedBy: SAMPLE_ACTOR,
          verifiedAt: now,
          createdAt: now,
        });
        await s.track("outletPins", pin, `pin:${store.code}`);
        const assignment = await ctx.db.insert("outletAssignments", {
          outletId,
          territoryId: territories.get(territory.code)!,
          routeId: routes.get(route.code)!,
          sequence: position,
          preferredWeekday: route.weekdays[0],
          effectiveFrom: from,
          actorSubject: SAMPLE_ACTOR,
          reason: "beta sample data",
          createdAt: now,
        });
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
        () =>
          ctx.db.insert("territorySalespeople", {
            territoryId,
            profileId: profile._id,
            kind: "primary",
            effectiveFrom: profile.effectiveFrom ?? now,
            actorSubject: SAMPLE_ACTOR,
            reason: "beta sample tester setup",
            createdAt: now,
          }),
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
        () =>
          ctx.db.insert("routeSalespeople", {
            routeId,
            profileId: profile._id,
            primary: true,
            effectiveFrom: profile.effectiveFrom ?? now,
            actorSubject: SAMPLE_ACTOR,
            reason: "beta sample tester setup",
            createdAt: now,
          }),
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
    const s = new Seeder(ctx, now, Math.min(SAMPLE_EPOCH, now));
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
    };
  },
});

/**
 * Removes every row the sample seed created, newest first (children before parents), in
 * bounded batches: repeat until `isDone`. Rows written by testers' own work (visits,
 * orders, trips, their profiles and assignment history) are never touched.
 */
export const reset = internalMutation({
  args: {
    confirm: v.literal("remove-beta-sample"),
    limit: v.optional(v.number()),
  },
  returns: v.object({ deleted: v.number(), isDone: v.boolean() }),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(args.limit ?? 400, 1_000));
    const rows = await ctx.db
      .query("sampleDataRows")
      .withIndex("by_batch", (q) => q.eq("batch", SAMPLE_BATCH))
      .order("desc")
      .take(limit + 1);
    let deleted = 0;
    for (const row of rows.slice(0, limit)) {
      const id = ctx.db.normalizeId(row.tableName as TableNames, row.rowId);
      if (id && (await ctx.db.get(id))) {
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
    const sameVehicle = await ctx.db
      .query("vanTrips")
      .withIndex("by_vehicleId_and_serviceDate", (q) =>
        q.eq("vehicleId", vehicle._id).eq("serviceDate", serviceDate),
      )
      .take(50);
    if (sameVehicle.some((trip) => OPEN_TRIP_STATUSES.includes(trip.status)))
      throw new ConvexError("This truck already has a trip that day");
    const tripNumber = `TRIP-${serviceDate.replaceAll("-", "")}-${vehicle.vehicleCode}-${sameVehicle.length + 1}`;
    const tripId = await ctx.db.insert("vanTrips", {
      organizationId: org,
      orgUnitId: vehicle.orgUnitId,
      tripNumber,
      vehicleId: vehicle._id,
      truckLocationId: vehicle.truckLocationId,
      sourceLocationId: vehicle.homeLocationId,
      routeId: route._id,
      serviceDate,
      salespersonProfileId: seller._id,
      salespersonSubject: seller.authSubject,
      driverName: "Nonoy Pepito",
      helperName: "Bong Alcantara",
      status: "loading",
      createdBy: SAMPLE_ACTOR,
      createdAt: now,
      updatedAt: now,
    });
    await audit(
      ctx,
      SAMPLE_ACTOR,
      "van.trip.planned",
      "vanTrip",
      tripId,
      tripNumber,
      now,
    );
    const loadId = await ctx.db.insert("vanTripLoads", {
      organizationId: org,
      tripId,
      loadNumber: 1,
      status: "planned",
      createdBy: SAMPLE_ACTOR,
      createdAt: now,
      updatedAt: now,
    });
    for (const [index, [code, cases]] of SAMPLE_VAN_LOAD.entries()) {
      const sample = SAMPLE_PRODUCTS.find((row) => row.code === code)!;
      const product = await ctx.db
        .query("products")
        .withIndex("by_code", (q) => q.eq("code", code))
        .unique();
      if (!product?.active) throw new ConvexError("Run beta/sample:seed first");
      const unit = await productUnit(ctx, product);
      await ctx.db.insert("vanTripLoadLines", {
        organizationId: org,
        loadId,
        tripId,
        lineNumber: index + 1,
        productId: product._id,
        productCode: product.code,
        uomCode: unit.uomCode,
        quantityScale: unit.quantityScale,
        expectedBase: BigInt(sample.caseQty * cases) * unit.quantityScale,
        createdAt: now,
        updatedAt: now,
      });
    }
    await audit(
      ctx,
      SAMPLE_ACTOR,
      "van.load.planned",
      "vanTripLoad",
      loadId,
      `${SAMPLE_VAN_LOAD.length} lines`,
      now,
    );
    return { tripId, tripNumber };
  },
});
