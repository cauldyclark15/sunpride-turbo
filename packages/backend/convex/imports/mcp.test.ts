import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";
import { localDate, manilaDate } from "../coverage/validation";
import { MCP_HEADERS } from "./mcp";

async function fixture() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  const root = t.withIdentity({
    subject: "mcp-root",
    email: "jcing.jc@gmail.com",
  });
  const profileId = await root.mutation(api.domains.profiles.ensure, {});
  const { rootUnitId } = await t.mutation(
    internal.migrations.seedOrganizationFoundation,
    {},
  );
  const now = Date.now();
  const month = manilaDate(now + 40 * 86400000).slice(0, 7);
  const date = `${month}-15`;
  await t.run(async (ctx) => {
    await ctx.db.patch(profileId, { employeeCode: "0007" });
    for (const old of await ctx.db
      .query("employeeAssignments")
      .withIndex("by_profileId_and_effectiveFrom", (q) =>
        q.eq("profileId", profileId),
      )
      .collect())
      await ctx.db.delete(old._id);
    await ctx.db.insert("employeeAssignments", {
      profileId,
      orgUnitId: rootUnitId,
      role: "super_admin",
      effectiveFrom: now - 86400000,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: now,
    });
  });
  const ids = await t.run(async (ctx) => {
    const territory = await ctx.db.insert("territories", {
      organizationId: "sunpride",
      code: "T",
      name: "T",
      status: "active",
      effectiveFrom: now - 86400000,
      createdAt: now,
      updatedAt: now,
      createdBy: "fixture",
    });
    await ctx.db.insert("territoryOwnerships", {
      territoryId: territory,
      orgUnitId: rootUnitId,
      effectiveFrom: now - 86400000,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: now,
    });
    const route = await ctx.db.insert("routes", {
      organizationId: "sunpride",
      code: "R",
      name: "R",
      status: "active",
      effectiveFrom: now - 86400000,
      createdAt: now,
      updatedAt: now,
      createdBy: "fixture",
    });
    await ctx.db.insert("routeTerritories", {
      routeId: route,
      territoryId: territory,
      effectiveFrom: now - 86400000,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: now,
    });
    await ctx.db.insert("routeSalespeople", {
      routeId: route,
      profileId,
      primary: true,
      effectiveFrom: now - 86400000,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: now,
    });
    const outlet = await ctx.db.insert("outlets", {
      organizationId: "sunpride",
      code: "0009",
      name: "Prospect",
      status: "prospect",
      custodianOrgUnitId: rootUnitId,
      createdAt: now,
      updatedAt: now,
      createdBy: "fixture",
    });
    await ctx.db.insert("outletAssignments", {
      outletId: outlet,
      territoryId: territory,
      routeId: route,
      sequence: 1,
      effectiveFrom: now - 86400000,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: now,
    });
    return { territory, route, outlet };
  });
  const plan = await root.mutation(api.coverage.plans.create, {
    assigneeProfileId: profileId,
    localMonth: month,
  });
  const values = (overrides: Record<string, string> = {}) => ({
    employee_code: "0007",
    territory_code: "T",
    route_code: "R",
    outlet_code: "0009",
    customer_code: "",
    service_date: date,
    frequency: "weekly",
    sequence: "1",
    duration_minutes: "30",
    objectives: "Visit;Sell",
    ...overrides,
  });
  const row = (overrides: Record<string, string> = {}, rowNumber = 2) => ({
    rowNumber,
    values: values(overrides),
  });
  const args = (rows = [row()], fileHash = "hash", chunkIndex = 0) => ({
    planId: plan._id,
    format: "mcp_visits" as const,
    header: MCP_HEADERS.mcp_visits.split(","),
    rows,
    fileHash,
    rowCount: Math.max(rows.length, ...rows.map((row) => row.rowNumber - 1)),
    chunkIndex,
    sourceReference: "sheet.csv",
  });
  return { t, root, ids, rootUnitId, profileId, plan, date, row, args };
}

const previewArgs = (
  args: ReturnType<Awaited<ReturnType<typeof fixture>>["args"]>,
) => ({
  planId: args.planId,
  format: args.format,
  header: args.header,
  rows: args.rows,
  fileHash: args.fileHash,
  rowCount: args.rowCount,
});

describe("MCP scoped import", () => {
  it("previews accepted prospect and row-specific missing employee, route, outlet and wrong month", async () => {
    const f = await fixture();
    const rows = [
      f.row(),
      f.row({ employee_code: "MISSING" }, 3),
      f.row({ route_code: "X" }, 4),
      f.row({ outlet_code: "NO-SUCH-OUTLET" }, 5),
      f.row({ service_date: "2020-01-01" }, 6),
    ];
    const result = await f.root.query(
      api.imports.mcp.preview,
      previewArgs(f.args(rows)),
    );
    expect(result.accepted.map((row) => row.rowNumber)).toEqual([2]);
    expect(
      result.rejected.map((error) => [error.rowNumber, error.column]),
    ).toEqual(
      expect.arrayContaining([
        [3, "employee_code"],
        [4, "route_code"],
        [5, "outlet_code"],
        [6, "service_date"],
      ]),
    );
  });

  it("merges accepted rows, persists errors, replay no-op, rejects changed key and protects national run history", async () => {
    const f = await fixture();
    const args = f.args([f.row(), f.row({ outlet_code: "NO-SUCH-OUTLET" }, 3)]);
    const first = await f.root.mutation(api.imports.mcp.commit, args);
    expect([first.acceptedCount, first.rejectedCount, first.duplicate]).toEqual(
      [1, 1, false],
    );
    expect(
      (await f.root.mutation(api.imports.mcp.commit, args)).duplicate,
    ).toBe(true);
    expect(
      (
        await f.root.mutation(api.imports.mcp.commit, {
          ...args,
          sourceReference: "renamed.csv",
        })
      ).duplicate,
    ).toBe(true);
    await expect(
      f.root.mutation(api.imports.mcp.commit, {
        ...args,
        rows: [f.row({ objectives: "Changed" }), args.rows[1]!],
      }),
    ).rejects.toThrow(/different payload/);
    const detail = await f.root.query(api.coverage.plans.detail, {
      planId: f.plan._id,
    });
    expect([detail.outlets.length, detail.slots.length]).toEqual([1, 1]);
    const history = await f.root.query(api.imports.mcp.history, {
      planId: f.plan._id,
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(history.page[0]?.errors[0]?.rowNumber).toBe(3);
    expect(
      (await f.root.query(api.imports.runs.list, {})).some((run) =>
        run.runKey.includes("hash"),
      ),
    ).toBe(false);
  });

  it("rejects duplicate visits across chunks and all-rejected chunk, without replacing existing draft", async () => {
    const f = await fixture();
    await f.root.mutation(api.imports.mcp.commit, f.args());
    const rows = [f.row({}, 102)];
    const args = { ...f.args(rows, "another", 1), rowCount: 101 };
    const preview = await f.root.query(
      api.imports.mcp.preview,
      previewArgs(args),
    );
    expect(
      preview.rejected.some((error) => error.code === "duplicate_in_file"),
    ).toBe(true);
    await expect(f.root.mutation(api.imports.mcp.commit, args)).rejects.toThrow(
      /All rows rejected/,
    );
    expect(
      (await f.root.query(api.coverage.plans.detail, { planId: f.plan._id }))
        .slots,
    ).toHaveLength(1);
  });

  it("rejects cross-unit outlet and immutable approved plan", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      const other = await ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code: "FOREIGN",
        name: "Foreign",
        typeCode: "REGION",
        parentId: f.rootUnitId,
        status: "active",
        effectiveFrom: Date.now() - 10000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const territory = await ctx.db.insert("territories", {
        organizationId: "sunpride",
        code: "FOREIGN",
        name: "Foreign",
        status: "active",
        effectiveFrom: Date.now() - 10000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: "fixture",
      });
      await ctx.db.insert("territoryOwnerships", {
        territoryId: territory,
        orgUnitId: other,
        effectiveFrom: Date.now() - 10000,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: Date.now(),
      });
      const foreign = await ctx.db.insert("outlets", {
        organizationId: "sunpride",
        code: "FOREIGN",
        name: "Foreign",
        status: "active",
        custodianOrgUnitId: other,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: "fixture",
      });
      await ctx.db.insert("outletAssignments", {
        outletId: foreign,
        territoryId: territory,
        routeId: f.ids.route,
        effectiveFrom: Date.now() - 10000,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: Date.now(),
      });
    });
    const result = await f.root.query(
      api.imports.mcp.preview,
      previewArgs(
        f.args([f.row({ territory_code: "FOREIGN", outlet_code: "FOREIGN" })]),
      ),
    );
    expect(result.rejected.some((error) => error.code === "scope_denied")).toBe(
      true,
    );
    await f.t.run((ctx) => ctx.db.patch(f.plan._id, { status: "approved" }));
    await expect(
      f.root.query(api.imports.mcp.preview, previewArgs(f.args())),
    ).rejects.toThrow(/draft/);
    await expect(
      f.root.mutation(api.imports.mcp.commit, f.args()),
    ).rejects.toThrow(/draft/);
  });

  it("rechecks outlet scope and assignment at commit after a valid preview", async () => {
    const f = await fixture();
    expect(
      (await f.root.query(api.imports.mcp.preview, previewArgs(f.args())))
        .accepted,
    ).toHaveLength(1);
    await f.t.run(async (ctx) => {
      const other = await ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code: "OTHER",
        name: "Other",
        typeCode: "REGION",
        parentId: f.rootUnitId,
        status: "active",
        effectiveFrom: Date.now() - 100000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const territory = await ctx.db.insert("territories", {
        organizationId: "sunpride",
        code: "OTHER",
        name: "Other",
        status: "active",
        effectiveFrom: Date.now() - 100000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: "fixture",
      });
      await ctx.db.insert("territoryOwnerships", {
        territoryId: territory,
        orgUnitId: other,
        effectiveFrom: Date.now() - 100000,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: Date.now(),
      });
      for (const old of await ctx.db
        .query("outletAssignments")
        .withIndex("by_outletId_and_effectiveFrom", (q) =>
          q.eq("outletId", f.ids.outlet),
        )
        .collect())
        await ctx.db.delete(old._id);
      await ctx.db.insert("outletAssignments", {
        outletId: f.ids.outlet,
        territoryId: territory,
        effectiveFrom: Date.now() - 100000,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: Date.now(),
      });
    });
    await expect(
      f.root.mutation(api.imports.mcp.commit, f.args()),
    ).rejects.toThrow(/All rows rejected/);
    expect(
      (await f.root.query(api.coverage.plans.detail, { planId: f.plan._id }))
        .slots,
    ).toHaveLength(0);
  });

  it("stages route-sheet defaults only, then merges a visit without replacing those defaults", async () => {
    const f = await fixture();
    const routeRow = {
      rowNumber: 2,
      values: Object.fromEntries(
        Object.entries(f.row().values).filter(
          ([key]) => key !== "service_date",
        ),
      ),
    };
    const route = {
      planId: f.plan._id,
      format: "route_sheet" as const,
      header: MCP_HEADERS.route_sheet.split(","),
      rows: [routeRow],
      fileHash: "route",
      rowCount: 1,
      chunkIndex: 0,
      sourceReference: "route.csv",
    };
    expect(
      (await f.root.mutation(api.imports.mcp.commit, route)).acceptedCount,
    ).toBe(1);
    let detail = await f.root.query(api.coverage.plans.detail, {
      planId: f.plan._id,
    });
    expect([detail.outlets.length, detail.slots.length]).toEqual([1, 0]);
    expect(
      (await f.root.mutation(api.imports.mcp.commit, f.args())).acceptedCount,
    ).toBe(1);
    detail = await f.root.query(api.coverage.plans.detail, {
      planId: f.plan._id,
    });
    expect([detail.outlets.length, detail.slots.length]).toEqual([1, 1]);
  });

  it("imports tomorrow after a mid-day employee and outlet assignment, but rejects today's slot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T12:00:00.000Z"));
    try {
      const f = await fixture();
      const today = manilaDate(Date.now());
      const midnight = localDate(today);
      await f.t.run(async (ctx) => {
        for (const old of await ctx.db
          .query("employeeAssignments")
          .withIndex("by_profileId_and_effectiveFrom", (q) =>
            q.eq("profileId", f.profileId),
          )
          .collect())
          await ctx.db.delete(old._id);
        await ctx.db.insert("employeeAssignments", {
          profileId: f.profileId,
          orgUnitId: f.rootUnitId,
          role: "super_admin",
          effectiveFrom: midnight + 3600000,
          actorSubject: "fixture",
          reason: "fixture",
          createdAt: Date.now(),
        });
        for (const old of await ctx.db
          .query("outletAssignments")
          .withIndex("by_outletId_and_effectiveFrom", (q) =>
            q.eq("outletId", f.ids.outlet),
          )
          .collect())
          await ctx.db.delete(old._id);
        await ctx.db.insert("outletAssignments", {
          outletId: f.ids.outlet,
          territoryId: f.ids.territory,
          routeId: f.ids.route,
          sequence: 1,
          effectiveFrom: midnight + 3600000,
          actorSubject: "fixture",
          reason: "fixture",
          createdAt: Date.now(),
        });
      });
      const tomorrow = manilaDate(midnight + 86400000);
      const current = await f.root.mutation(api.coverage.plans.create, {
        assigneeProfileId: f.profileId,
        localMonth: today.slice(0, 7),
      });
      const args = {
        ...f.args([f.row({ service_date: tomorrow })]),
        planId: current._id,
      };
      expect(
        (await f.root.query(api.imports.mcp.preview, previewArgs(args)))
          .accepted,
      ).toHaveLength(1);
      expect(
        (await f.root.mutation(api.imports.mcp.commit, args)).acceptedCount,
      ).toBe(1);
      const sameDay = {
        ...f.args([f.row({ service_date: today })], "same-day"),
        planId: current._id,
      };
      expect(
        (
          await f.root.query(api.imports.mcp.preview, previewArgs(sameDay))
        ).rejected.some((error) => error.column === "service_date"),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
