import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import {
  productValues,
  provisionAdmin,
  provisionInventory,
  row,
} from "../imports/test_helpers";
import { chunkKey, fileHashOf } from "../imports/shared";
import schema from "../schema";
import { modules } from "../test.setup";

function newTest() {
  return convexTest(schema, modules);
}

/**
 * Regression guard for returns-validator drift: adding columns to a table breaks every
 * reader whose `returns` validator was written by hand. These call the real readers on a
 * profile that now carries organizational scope and on an imported product.
 */
describe("document readers after schema extension", () => {
  it("returns profiles.current when the profile carries organizational scope", async () => {
    const t = newTest();
    const { admin } = await provisionAdmin(t);
    const profile = await admin.query(api.domains.profiles.current);
    expect(profile).not.toBeNull();
    expect(profile?.role).toBe("admin");
    expect(profile?.orgUnitId).toBeDefined();
    expect(profile?.effectiveFrom).toBeDefined();
  });

  it("returns profiles.list, invitations and master data after an import", async () => {
    const t = newTest();
    const { admin, superAdmin } = await provisionAdmin(t);
    await provisionInventory(admin);
    const rows = [row(productValues())];
    await admin.mutation(api.imports.products.commitProducts, {
      runKey: "readers-run",
      chunkIndex: 0,
      idempotencyKey: chunkKey("products", "readers-run", 0),
      fileHash: fileHashOf(rows.length, rows),
      rows,
    });

    const profiles = await admin.query(api.domains.profiles.list, {});
    expect(profiles.length).toBeGreaterThan(0);
    expect(profiles[0]?.email).toBeTruthy();

    const invitations = await superAdmin.query(
      api.domains.profiles.listInvitations,
      {},
    );
    expect(invitations.length).toBeGreaterThan(0);

    const products = await admin.query(api.domains.masterData.products, {
      limit: 50,
    });
    expect(products.some((product) => product.code === "SP-TEST-1L")).toBe(
      true,
    );
    const imported = products.find((product) => product.code === "SP-TEST-1L");
    expect(imported?.catalogSource).toBe("import");
    expect(imported?.sellingUomIds?.length).toBe(2);

    const scope = await admin.query(api.domains.profiles.myScope, {});
    expect(scope.orgUnitCode).toBe("SUNPRIDE");
    void internal;
  });
});
