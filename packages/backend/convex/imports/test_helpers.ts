import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { TestConvex } from "convex-test";
import type schema from "../schema";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";

/**
 * Shared fixtures for import tests.
 *
 * IMPORTANT: this module is bundled into the Convex deployment, so it must never import
 * `../test.setup` (its `import.meta.glob` fails the Convex analyser), `convex-test`, or
 * anything else that only exists during tests. Test files construct their own
 * `convexTest(schema, modules)` and pass it in.
 */
export type Test = TestConvex<typeof schema>;
export type Identity = ReturnType<Test["withIdentity"]>;

export const BOOTSTRAP_EMAIL = "jcing.jc@gmail.com";

/** Provision the bootstrap super admin, then an admin, and return both identities. */
export async function provisionAdmin(t: Test, email = "admin@sunpride.local") {
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  const superAdmin = t.withIdentity({
    subject: "bootstrap-super-admin",
    email: BOOTSTRAP_EMAIL,
    name: "JC",
  });
  await superAdmin.mutation(api.domains.profiles.ensure);
  const root = await t.mutation(
    internal.migrations.seedOrganizationFoundation,
    {},
  );
  await superAdmin.mutation(api.domains.profiles.invite, {
    email,
    name: email,
    role: "admin",
  });
  const admin = t.withIdentity({ subject: email, email, name: email });
  const adminProfileId = await admin.mutation(api.domains.profiles.ensure);
  await superAdmin.mutation(api.domains.profiles.assignPersona, {
    profileId: adminProfileId,
    orgUnitId: root.rootUnitId,
  });
  return { superAdmin, admin };
}

/** Runs the inventory foundation provisioning (UOMs, locations, policies). */
export async function provisionInventory(admin: Identity) {
  await admin.mutation(api.inventory.setup.foundation, {});
}

export function row(values: Record<string, string>, rowNumber = 2) {
  return { rowNumber, values };
}

export async function uomIdByCode(t: Test, code: string) {
  return t.run(async (ctx) => {
    const uom = await ctx.db
      .query("unitsOfMeasure")
      .withIndex("by_organizationId_and_code", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID).eq("code", code),
      )
      .unique();
    if (!uom) throw new Error(`UOM ${code} not found`);
    return uom._id;
  });
}

export async function locationIdByCode(t: Test, code: string) {
  return t.run(async (ctx) => {
    const location = await ctx.db
      .query("inventoryLocations")
      .withIndex("by_organizationId_and_code", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID).eq("code", code),
      )
      .unique();
    if (!location) throw new Error(`Location ${code} not found`);
    return location._id;
  });
}

export async function productByCode(t: Test, code: string) {
  return t.run(async (ctx) =>
    ctx.db
      .query("products")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique(),
  );
}

export async function balanceFor(
  t: Test,
  productId: Id<"products">,
  locationId: Id<"inventoryLocations">,
) {
  return t.run(async (ctx) =>
    ctx.db
      .query("inventoryBalances")
      .withIndex("by_organizationId_and_productId_and_locationId", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("productId", productId)
          .eq("locationId", locationId),
      )
      .unique(),
  );
}

export const PRODUCT_HEADERS =
  "product_code,name,category,base_uom,selling_uoms,barcode,tracking_mode,allocation_policy,shelf_life_days,expiry_required,manufacture_date_required,minimum_remaining_shelf_life_days,external_id".split(
    ",",
  );

/** Builds a complete product row with every documented column present. */
export function productValues(
  overrides: Record<string, string> = {},
): Record<string, string> {
  const base: Record<string, string> = {
    product_code: "SP-TEST-1L",
    name: "Sunpride Test Juice 1L",
    category: "Juice",
    base_uom: "CASE",
    selling_uoms: "CASE;EACH",
    barcode: "4800000000001",
    tracking_mode: "lot",
    allocation_policy: "fefo",
    shelf_life_days: "365",
    expiry_required: "Y",
    manufacture_date_required: "N",
    minimum_remaining_shelf_life_days: "7",
    external_id: "SP-TEST-1L",
  };
  return { ...base, ...overrides };
}

export function openingStockValues(
  overrides: Record<string, string> = {},
): Record<string, string> {
  const base: Record<string, string> = {
    product_code: "SP-TEST-1L",
    location_code: "WH-MNL",
    lot_number: "LOT-TEST-0001",
    manufactured_at: "2026-08-01",
    expires_at: "2027-08-01",
    quantity: "240",
    unit_cost_minor: "118800",
    source_reference: "CUTOVER-TEST",
  };
  return { ...base, ...overrides };
}
