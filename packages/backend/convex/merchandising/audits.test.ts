import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FunctionArgs } from "convex/server";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import { normalizeAudit } from "./audits";

const now = Date.parse("2026-10-05T02:00:00Z"); // 10:00 Manila
const DAY = "2026-10-05";
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type T = TestConvex<typeof schema>;
type Role = "sales" | "manager" | "operations";

afterEach(() => {
  vi.useRealTimers();
});

async function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const t: T = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const since = now - 10e7;
    const unit = await ctx.db.insert("orgUnits", {
      organizationId: "sunpride",
      code: "SUNPRIDE",
      name: "National",
      typeCode: "NATIONAL",
      status: "active",
      effectiveFrom: since,
      createdAt: now,
      updatedAt: now,
    });
    const otherUnit = await ctx.db.insert("orgUnits", {
      organizationId: "sunpride",
      code: "OTHER",
      name: "Other",
      typeCode: "REGION",
      parentId: unit,
      status: "active",
      effectiveFrom: since,
      createdAt: now,
      updatedAt: now,
    });
    const position = await ctx.db.insert("positions", {
      organizationId: "sunpride",
      code: "FIELD",
      label: "Field",
      category: "field",
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    const person = async (
      subject: string,
      role: Role,
      orgUnitId: Id<"orgUnits"> = unit,
    ) => {
      const id = await ctx.db.insert("profiles", {
        authSubject: `https://auth.test|${subject}`,
        name: subject,
        email: `${subject}@test.local`,
        role,
        status: "active",
        orgUnitId,
        updatedAt: now,
      });
      await ctx.db.insert("employeeAssignments", {
        profileId: id,
        orgUnitId,
        role,
        positionId: position,
        effectiveFrom: since,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: now,
      });
      return id;
    };
    const sales = await person("sales", "sales");
    const other = await person("other", "sales");
    await person("manager", "manager");
    await person("outsider", "manager", otherUnit);
    await person("ops", "operations");
    const territory = await ctx.db.insert("territories", {
      organizationId: "sunpride",
      code: "T",
      name: "Territory",
      status: "active",
      effectiveFrom: since,
      createdAt: now,
      updatedAt: now,
      createdBy: "fixture",
    });
    await ctx.db.insert("territoryOwnerships", {
      territoryId: territory,
      orgUnitId: unit,
      effectiveFrom: since,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: now,
    });
    for (const profileId of [sales, other])
      await ctx.db.insert("territorySalespeople", {
        territoryId: territory,
        profileId,
        kind: "primary",
        effectiveFrom: since,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: now,
      });
    const outlet = await ctx.db.insert("outlets", {
      organizationId: "sunpride",
      code: "O1",
      name: "Outlet",
      status: "active",
      custodianOrgUnitId: unit,
      createdAt: now,
      updatedAt: now,
      createdBy: "fixture",
    });
    await ctx.db.insert("outletAssignments", {
      outletId: outlet,
      territoryId: territory,
      effectiveFrom: since,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: now,
    });
    const product = (code: string, active = true) =>
      ctx.db.insert("products", {
        code,
        name: code,
        category: "Meat",
        uom: "PC",
        unitPrice: 100,
        active,
        organizationId: "sunpride",
        updatedAt: now,
      });
    const products = {
      ham: await product("HAM"),
      bacon: await product("BACON"),
      hotdog: await product("HOTDOG"),
      tocino: await product("TOCINO"),
      retired: await product("RETIRED", false),
    };
    const visit = (
      owner: Id<"profiles">,
      state: "checked-in" | "checked-out",
    ) =>
      ctx.db.insert("visitExecutions", {
        organizationId: "sunpride",
        clientVisitId: crypto.randomUUID(),
        assigneeProfileId: owner,
        outletId: outlet,
        orgUnitId: unit,
        serviceDate: DAY,
        source: "unplanned",
        intents: ["merchandise"],
        state,
        productivity: "pending",
        createdAt: now,
        lastServerTime: now,
        checkedInAt: now - 60_000,
        startedAt: now - 60_000,
      });
    const visitId = await visit(sales, "checked-in");
    const closedVisitId = await visit(sales, "checked-out");
    const otherVisitId = await visit(other, "checked-in");
    const photo = async (
      visitFor: Id<"visitExecutions">,
      owner: Id<"profiles">,
      status: "pending" | "verified" | "rejected" = "pending",
    ) =>
      ctx.db.insert("fieldEvidenceFiles", {
        organizationId: "sunpride",
        orgUnitId: unit,
        storageId: await ctx.storage.store(new Blob([crypto.randomUUID()])),
        visitId: visitFor,
        ownerProfileId: owner,
        outletId: outlet,
        mime: "image/jpeg",
        sizeBytes: 10,
        checksum: "a".repeat(64),
        capturedAt: now,
        photoType: "shelf_display",
        uploadedAt: now,
        status,
      });
    const photos = {
      shelf: await photo(visitId, sales),
      display: await photo(visitId, sales, "verified"),
      rejected: await photo(visitId, sales, "rejected"),
      otherVisit: await photo(otherVisitId, other),
      otherOwner: await photo(visitId, other),
    };
    return {
      unit,
      otherUnit,
      outlet,
      products,
      visitId,
      closedVisitId,
      otherVisitId,
      photos,
    };
  });
  const as = (subject: string) =>
    t.withIdentity({
      issuer: "https://auth.test",
      subject,
      email: `${subject}@test.local`,
    });
  return {
    t,
    ids,
    sales: as("sales"),
    other: as("other"),
    manager: as("manager"),
    outsider: as("outsider"),
    ops: as("ops"),
  };
}
type F = Awaited<ReturnType<typeof fixture>>;

async function withAssortment(f: F) {
  await f.ops.mutation(api.merchandising.assortments.set, {
    outletId: f.ids.outlet,
    productIds: [
      f.ids.products.ham,
      f.ids.products.bacon,
      f.ids.products.hotdog,
    ],
    effectiveFrom: now + 1000,
    sourceRef: "Key account listing Oct 2026",
  });
  vi.setSystemTime(now + 5000);
}

type AuditArgs = FunctionArgs<typeof api.merchandising.audits.record>;
function audit(f: F, overrides: Partial<AuditArgs> = {}): AuditArgs {
  return {
    clientAuditId: uuid(1),
    visitId: f.ids.visitId,
    deviceTime: now,
    availability: [
      {
        productId: f.ids.products.ham,
        status: "available" as const,
        facings: 6,
        evidenceIds: [f.ids.photos.shelf],
      },
      { productId: f.ids.products.bacon, status: "out_of_stock" as const },
      { productId: f.ids.products.tocino, status: "low_stock" as const },
    ],
    compliance: [
      {
        kind: "display" as const,
        finding: "non_compliant" as const,
        actionTaken: "  Rebuilt the chiller facing  ",
        evidenceIds: [f.ids.photos.display],
      },
      {
        kind: "promotion" as const,
        finding: "compliant" as const,
        programRef: "OCT-BUY2",
      },
      {
        kind: "shelf_share" as const,
        finding: "compliant" as const,
        shareOfShelfPercent: 35,
      },
    ],
    competitors: [
      {
        kind: "price" as const,
        brand: "Rival Ham",
        productCategory: "Ham",
        observedPriceMinor: 15900n,
        currency: "PHP",
        evidenceIds: [f.ids.photos.shelf],
      },
      { kind: "display" as const, brand: "Rival", note: "End-cap gondola" },
    ],
    evidenceIds: [f.ids.photos.display],
    source: "mobile" as const,
    ...overrides,
  };
}

describe("outlet required assortment", () => {
  it("schedules prospective versions, closes the replaced one and refuses overwrites", async () => {
    const f = await fixture();
    const { ham, bacon, retired } = f.ids.products;
    const set = (
      who: F["ops"],
      productIds: Id<"products">[],
      effectiveFrom: number,
    ) =>
      who.mutation(api.merchandising.assortments.set, {
        outletId: f.ids.outlet,
        productIds,
        effectiveFrom,
        sourceRef: "listing",
      });
    await expect(set(f.sales, [ham], now + 1000)).rejects.toThrow(
      /Insufficient permission/,
    );
    await expect(set(f.ops, [ham], now - 1)).rejects.toThrow(
      /future-effective/,
    );
    await expect(set(f.ops, [ham, ham], now + 1000)).rejects.toThrow(
      /invalid_request/,
    );
    await expect(set(f.ops, [retired], now + 1000)).rejects.toThrow(
      /invalid_request/,
    );
    const first = await set(f.ops, [ham], now + 1000);
    await expect(set(f.ops, [bacon], now + 1000)).rejects.toThrow(/conflict/);
    await expect(set(f.ops, [bacon], now + 500)).rejects.toThrow(/conflict/);
    const second = await set(f.ops, [ham, bacon], now + 9000);
    expect((await f.t.run((ctx) => ctx.db.get(first)))?.effectiveTo).toBe(
      now + 9000,
    );
    const read = (asOf?: number) =>
      f.sales.query(api.merchandising.assortments.current, {
        outletId: f.ids.outlet,
        asOf,
      });
    expect(await read()).toBeNull();
    expect((await read(now + 1000))?.assortmentId).toBe(first);
    expect(await read(now + 9000)).toMatchObject({
      assortmentId: second,
      productIds: [ham, bacon],
      effectiveTo: null,
      sourceRef: "listing",
    });
    await expect(
      f.outsider.query(api.merchandising.assortments.current, {
        outletId: f.ids.outlet,
      }),
    ).rejects.toThrow();
  });
});

describe("merchandising audit capture", () => {
  it("persists availability, compliance, competitor rows and photos with OSA against the assortment", async () => {
    const f = await fixture();
    await withAssortment(f);
    const { auditId } = await f.sales.mutation(
      api.merchandising.audits.record,
      audit(f),
    );
    const read = await f.sales.query(api.merchandising.audits.forVisit, {
      visitId: f.ids.visitId,
    });
    const { ham, bacon, hotdog, tocino } = f.ids.products;
    expect(read).toMatchObject({
      auditId,
      requiredCount: 3,
      requiredAvailableCount: 1,
      requiredOutOfStockCount: 1,
      onShelfAvailabilityPercent: 33.3,
      missingRequiredProductIds: [hotdog],
      source: "mobile",
      evidenceIds: [f.ids.photos.display],
    });
    expect(read?.availability).toEqual([
      {
        productId: ham,
        required: true,
        status: "available",
        facings: 6,
        note: null,
        evidenceIds: [f.ids.photos.shelf],
      },
      {
        productId: bacon,
        required: true,
        status: "out_of_stock",
        facings: null,
        note: null,
        evidenceIds: [],
      },
      {
        productId: tocino,
        required: false,
        status: "low_stock",
        facings: null,
        note: null,
        evidenceIds: [],
      },
    ]);
    expect(read?.compliance.map((c) => [c.kind, c.finding])).toEqual([
      ["display", "non_compliant"],
      ["promotion", "compliant"],
      ["shelf_share", "compliant"],
    ]);
    expect(read?.compliance[0]?.actionTaken).toBe("Rebuilt the chiller facing");
    expect(read?.compliance[2]?.shareOfShelfPercent).toBe(35);
    expect(read?.competitors[0]).toMatchObject({
      brand: "Rival Ham",
      observedPriceMinor: 15900n,
      currency: "PHP",
    });
    const state = await f.t.run(async (ctx) => ({
      visit: await ctx.db.get(f.ids.visitId),
      audit: await ctx.db.get(auditId),
      events: await ctx.db
        .query("executionEvents")
        .withIndex("by_entityType_and_entityId_and_serverAt", (q) =>
          q.eq("entityType", "visit").eq("entityId", f.ids.visitId),
        )
        .collect(),
      byProduct: await ctx.db
        .query("merchandisingAvailability")
        .withIndex("by_productId_and_serviceDate", (q) =>
          q.eq("productId", bacon).eq("serviceDate", DAY),
        )
        .collect(),
      unitAvailability: await ctx.db
        .query("merchandisingAvailability")
        .withIndex("by_orgUnitId_and_serviceDate", (q) =>
          q.eq("orgUnitId", f.ids.unit).eq("serviceDate", DAY),
        )
        .collect(),
      displays: await ctx.db
        .query("merchandisingComplianceChecks")
        .withIndex("by_orgUnitId_and_kind_and_serviceDate", (q) =>
          q
            .eq("orgUnitId", f.ids.unit)
            .eq("kind", "display")
            .eq("serviceDate", DAY),
        )
        .collect(),
      competitors: await ctx.db
        .query("competitorObservations")
        .withIndex("by_orgUnitId_and_serviceDate", (q) =>
          q.eq("orgUnitId", f.ids.unit).eq("serviceDate", DAY),
        )
        .collect(),
      byOutlet: await ctx.db
        .query("merchandisingAudits")
        .withIndex("by_outletId_and_serviceDate", (q) =>
          q.eq("outletId", f.ids.outlet).eq("serviceDate", DAY),
        )
        .collect(),
    }));
    expect(state.visit?.state).toBe("in-progress");
    expect(state.audit?.actorSubject).toBe("https://auth.test|sales");
    expect(state.audit?.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(state.events.map((e) => e.kind)).toEqual([
      "merchandising.audit_recorded",
    ]);
    expect(state.byProduct.map((r) => r.status)).toEqual(["out_of_stock"]);
    expect(state.unitAvailability).toHaveLength(3);
    expect(state.displays).toHaveLength(1);
    expect(state.competitors).toHaveLength(2);
    expect(state.byOutlet).toHaveLength(1);
  });

  it("returns the original on an identical retry and refuses changed content or a second audit", async () => {
    const f = await fixture();
    const first = await f.sales.mutation(
      api.merchandising.audits.record,
      audit(f),
    );
    // Whitespace-only difference canonicalizes to the same content.
    const retry = audit(f);
    retry.compliance[0]!.actionTaken = "Rebuilt the chiller facing";
    expect(
      await f.sales.mutation(api.merchandising.audits.record, retry),
    ).toEqual(first);
    await expect(
      f.sales.mutation(
        api.merchandising.audits.record,
        audit(f, { competitors: [] }),
      ),
    ).rejects.toThrow(/conflict/);
    await expect(
      f.sales.mutation(
        api.merchandising.audits.record,
        audit(f, { clientAuditId: uuid(2) }),
      ),
    ).rejects.toThrow(/conflict/);
    const rows = await f.t.run(async (ctx) => ({
      audits: await ctx.db.query("merchandisingAudits").collect(),
      lines: await ctx.db.query("merchandisingAvailability").collect(),
      events: await ctx.db.query("executionEvents").collect(),
    }));
    expect(rows.audits).toHaveLength(1);
    expect(rows.lines).toHaveLength(3);
    expect(rows.events).toHaveLength(1);
  });

  it("without an assortment records rows as not required and OSA as null", async () => {
    const f = await fixture();
    await f.sales.mutation(api.merchandising.audits.record, audit(f));
    const read = await f.sales.query(api.merchandising.audits.forVisit, {
      visitId: f.ids.visitId,
    });
    expect(read).toMatchObject({
      requiredCount: 0,
      onShelfAvailabilityPercent: null,
      missingRequiredProductIds: [],
    });
    expect(read?.availability.every((line) => !line.required)).toBe(true);
  });

  it("refuses another person's visit, a closed call and photos that are not this visit's own", async () => {
    const f = await fixture();
    const record = (who: F["sales"], args: ReturnType<typeof audit>) =>
      who.mutation(api.merchandising.audits.record, args);
    await expect(record(f.other, audit(f))).rejects.toThrow();
    await expect(record(f.manager, audit(f))).rejects.toThrow(/out_of_scope/);
    await expect(
      record(f.sales, audit(f, { visitId: f.ids.closedVisitId })),
    ).rejects.toThrow(/invalid_transition/);
    for (const photo of ["rejected", "otherVisit", "otherOwner"] as const)
      await expect(
        record(f.sales, audit(f, { evidenceIds: [f.ids.photos[photo]] })),
      ).rejects.toThrow(/invalid_evidence/);
    await expect(
      record(f.sales, {
        ...audit(f),
        availability: [
          { productId: f.ids.products.retired, status: "available" },
        ],
      }),
    ).rejects.toThrow(/invalid_request/);
    expect(
      await f.t.run((ctx) => ctx.db.query("merchandisingAudits").collect()),
    ).toHaveLength(0);
  });

  it("validates each section's shape", () => {
    const base = {
      clientAuditId: uuid(3),
      visitId: "v" as Id<"visitExecutions">,
      deviceTime: now,
      availability: [],
      compliance: [],
      competitors: [],
    };
    const p = "p1" as Id<"products">;
    const bad: Parameters<typeof normalizeAudit>[0][] = [
      base, // empty audit
      {
        ...base,
        clientAuditId: "not-a-uuid",
        competitors: [{ kind: "other", brand: "X" }],
      },
      {
        ...base,
        availability: [
          { productId: p, status: "available" },
          { productId: p, status: "low_stock" },
        ],
      },
      {
        ...base,
        availability: [{ productId: p, status: "out_of_stock", facings: 2 }],
      },
      {
        ...base,
        availability: [{ productId: p, status: "available", facings: 1.5 }],
      },
      { ...base, compliance: [{ kind: "promotion", finding: "compliant" }] },
      {
        ...base,
        compliance: [
          { kind: "display", finding: "compliant", shareOfShelfPercent: 20 },
        ],
      },
      {
        ...base,
        compliance: [
          {
            kind: "shelf_share",
            finding: "compliant",
            shareOfShelfPercent: 101,
          },
        ],
      },
      { ...base, competitors: [{ kind: "price", brand: "X" }] },
      {
        ...base,
        competitors: [
          {
            kind: "price",
            brand: "X",
            observedPriceMinor: 10n,
            currency: "php",
          },
        ],
      },
      {
        ...base,
        competitors: [
          {
            kind: "price",
            brand: "X",
            observedPriceMinor: -1n,
            currency: "PHP",
          },
        ],
      },
      {
        ...base,
        competitors: [{ kind: "other", brand: "X", currency: "PHP" }],
      },
      { ...base, competitors: [{ kind: "other", brand: "   " }] },
      {
        ...base,
        competitors: [{ kind: "other", brand: "X", note: "n".repeat(501) }],
      },
    ];
    for (const args of bad) expect(() => normalizeAudit(args)).toThrow();
    expect(
      normalizeAudit({
        ...base,
        clientAuditId: uuid(3).toUpperCase(),
        competitors: [{ kind: "new_product", brand: " Rival " }],
      }),
    ).toMatchObject({
      clientAuditId: uuid(3),
      competitors: [{ brand: "Rival", evidenceIds: [] }],
      evidenceIds: [],
    });
  });
});

describe("merchandising audit reads", () => {
  it("scopes the visit read and the supervisor day list", async () => {
    const f = await fixture();
    await withAssortment(f);
    const { auditId } = await f.sales.mutation(
      api.merchandising.audits.record,
      audit(f),
    );
    expect(
      (
        await f.manager.query(api.merchandising.audits.forVisit, {
          visitId: f.ids.visitId,
        })
      )?.auditId,
    ).toBe(auditId);
    await expect(
      f.outsider.query(api.merchandising.audits.forVisit, {
        visitId: f.ids.visitId,
      }),
    ).rejects.toThrow();
    await expect(
      f.other.query(api.merchandising.audits.forVisit, {
        visitId: f.ids.visitId,
      }),
    ).rejects.toThrow(/out_of_scope/);
    expect(
      await f.sales
        .query(api.merchandising.audits.forVisit, {
          visitId: f.ids.otherVisitId,
        })
        .catch(() => "denied"),
    ).toBe("denied");
    const list = (who: F["manager"], orgUnitId = f.ids.unit) =>
      who.query(api.merchandising.audits.forUnitDay, {
        orgUnitId,
        serviceDate: DAY,
        paginationOpts: { numItems: 10, cursor: null },
      });
    const page = await list(f.manager);
    expect(page.isDone).toBe(true);
    expect(page.page).toEqual([
      expect.objectContaining({
        auditId,
        onShelfAvailabilityPercent: 33.3,
        requiredOutOfStockCount: 1,
      }),
    ]);
    expect(page.page[0]).not.toHaveProperty("actorSubject");
    await expect(list(f.sales)).rejects.toThrow(/out_of_scope/);
    await expect(list(f.outsider)).rejects.toThrow(
      /outside your organizational scope/,
    );
    expect((await list(f.outsider, f.ids.otherUnit)).page).toEqual([]);
  });
});
