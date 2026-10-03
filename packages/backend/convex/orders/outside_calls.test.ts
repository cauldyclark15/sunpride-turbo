import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import {
  assertPoDate,
  assertQuantity,
  normalizeActivityCodes,
} from "./outside_calls";

type T = TestConvex<typeof schema>;
const HOUR = 3_600_000;
const today = "2026-09-28";
// 11:00 Manila on a Monday.
const now = Date.parse("2026-09-28T03:00:00Z");
const ISSUER = "https://auth.test";
const subject = (name: string) => `${ISSUER}|${name}`;

afterEach(() => {
  vi.useRealTimers();
});

type Role = "sales" | "manager" | "operations" | "admin" | "approver";

async function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const t: T = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const since = now - 30 * 24 * HOUR;
    const unit = (code: string, parentId?: Id<"orgUnits">) =>
      ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code,
        name: code,
        typeCode: parentId ? "REGION" : "NATIONAL",
        ...(parentId ? { parentId } : {}),
        status: "active",
        effectiveFrom: since,
        createdAt: since,
        updatedAt: since,
      });
    const root = await unit("SUNPRIDE");
    const regionA = await unit("A", root);
    const regionB = await unit("B", root);
    const person = async (
      name: string,
      role: Role,
      orgUnitId: Id<"orgUnits">,
    ) => {
      const id = await ctx.db.insert("profiles", {
        authSubject: subject(name),
        name,
        email: `${name}@test.local`,
        role,
        status: "active",
        orgUnitId,
        updatedAt: since,
      });
      const assignment = await ctx.db.insert("employeeAssignments", {
        profileId: id,
        orgUnitId,
        role,
        effectiveFrom: since,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: since,
      });
      return { id, assignment };
    };
    const adminA = await person("adminA", "operations", regionA);
    const adminB = await person("adminB", "operations", regionB);
    const national = await person("national", "admin", root);
    const managerA = await person("managerA", "manager", regionA);
    const approverA = await person("approverA", "approver", regionA);
    const ana = await person("Ana", "sales", regionA);
    const ben = await person("Ben", "sales", regionA);
    const territory = await ctx.db.insert("territories", {
      organizationId: "sunpride",
      code: "T-A",
      name: "Territory A",
      status: "active",
      effectiveFrom: since,
      createdAt: since,
      updatedAt: since,
      createdBy: "fixture",
    });
    const ownership = await ctx.db.insert("territoryOwnerships", {
      territoryId: territory,
      orgUnitId: regionA,
      effectiveFrom: since,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: since,
    });
    await ctx.db.insert("territorySalespeople", {
      territoryId: territory,
      profileId: ana.id,
      kind: "primary",
      effectiveFrom: since,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: since,
    });
    const outlet = async (code: string, assigned: boolean) => {
      const id = await ctx.db.insert("outlets", {
        organizationId: "sunpride",
        code,
        name: `Store ${code}`,
        status: "active",
        custodianOrgUnitId: regionA,
        createdAt: since,
        updatedAt: since,
        createdBy: "fixture",
      });
      const assignment = assigned
        ? await ctx.db.insert("outletAssignments", {
            outletId: id,
            territoryId: territory,
            sequence: 1,
            effectiveFrom: since,
            actorSubject: "fixture",
            reason: "fixture",
            createdAt: since,
          })
        : null;
      return { id, assignment };
    };
    const store = await outlet("O1", true);
    const planned = await outlet("O2", true);
    const loose = await outlet("O3", false);
    const customer = await ctx.db.insert("customers", {
      code: "C-1",
      name: "Store O1 Inc",
      channel: "Modern trade",
      territory: "T-A",
      creditLimit: 0,
      active: true,
      updatedAt: since,
    });
    await ctx.db.insert("outletCustomerLinks", {
      outletId: store.id,
      customerId: customer,
      source: "fixture",
      effectiveFrom: since,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: since,
    });
    const product = (code: string, active = true) =>
      ctx.db.insert("products", {
        code,
        name: `Product ${code}`,
        category: "Juice",
        uom: "CS",
        unitPrice: 100,
        active,
        updatedAt: since,
      });
    const juice = await product("P-1");
    const syrup = await product("P-2");
    const retired = await product("P-9", false);
    // Store O2 is in Ana's approved plan today; O1 is not.
    const plan = await ctx.db.insert("coveragePlans", {
      organizationId: "sunpride",
      assigneeProfileId: ana.id,
      localMonth: "2026-09",
      version: 1,
      cycleType: "monthly",
      orgUnitId: regionA,
      territoryIds: [territory],
      requestedFrom: since,
      requestedTo: now + 10 * 24 * HOUR,
      effectiveFrom: since,
      effectiveTo: now + 10 * 24 * HOUR,
      status: "active",
      preparedBy: subject("Ana"),
      preparedAt: since,
      approvedBy: subject("managerA"),
      approvedAt: since,
      approvalSignature: "signed",
      contentRevision: 1,
      createdBy: subject("Ana"),
      createdAt: since,
      updatedBy: subject("managerA"),
      updatedAt: since,
    });
    const approvedSnapshot = {
      outletId: planned.id,
      outletCode: "O2",
      outletName: "Store O2",
      territoryId: territory,
      territoryCode: "T-A",
      sequence: 1,
      outletAssignmentId: planned.assignment!,
      territoryOwnershipId: ownership,
      employeeAssignmentId: ana.assignment,
      orgUnitId: regionA,
      activityKind: "sell",
      approvedAssigneeProfileId: ana.id,
    };
    const slot = await ctx.db.insert("coveragePlanSlots", {
      slotKey: "slot-1",
      planId: plan,
      assigneeProfileId: ana.id,
      serviceDate: today,
      kind: "outlet_visit",
      outletId: planned.id,
      activityKind: "sell",
      requiredObjectives: [],
      intents: ["sell"],
      sequence: 1,
      expectedDurationMinutes: 20,
      approvedSnapshot,
      contentRevision: 1,
      updatedBy: "fixture",
      updatedAt: since,
    });
    await ctx.db.insert("plannedVisits", {
      generationKey: "gen-1",
      planId: plan,
      planVersion: 1,
      planSlotId: slot,
      assigneeProfileId: ana.id,
      outletId: planned.id,
      serviceDate: today,
      status: "planned",
      approvedSnapshot,
      requiredObjectives: [],
      intents: ["sell"],
      expectedDurationMinutes: 20,
      generatedAt: since,
    });
    return {
      regionA,
      adminA,
      adminB,
      national,
      managerA,
      approverA,
      ana,
      ben,
      territory,
      store,
      planned,
      loose,
      customer,
      juice,
      syrup,
      retired,
    };
  });
  const as = (name: string) =>
    t.withIdentity({
      issuer: ISSUER,
      subject: name,
      email: `${name}@test.local`,
    });
  const po = (
    overrides: Partial<{
      clientRequestId: string;
      outletId: Id<"outlets">;
      salespersonProfileId: Id<"profiles">;
      serviceDate: string;
      poNumber: string;
      lines: { productId: Id<"products">; quantity: number }[];
      note: string;
    }> = {},
  ) => ({
    clientRequestId: "req-1",
    outletId: ids.store.id,
    salespersonProfileId: ids.ana.id,
    serviceDate: today,
    poNumber: "PO-1001",
    receivedVia: "email" as const,
    lines: [
      { productId: ids.juice, quantity: 10 },
      { productId: ids.syrup, quantity: 2.5 },
    ],
    note: "Emailed by the store buyer",
    ...overrides,
  });
  return { t, ids, as, po };
}

describe("outside-call purchase orders (CALL-09)", () => {
  it("pure rules: PO date window, quantities and activity codes", () => {
    expect(() => assertPoDate(today, now)).not.toThrow();
    expect(() => assertPoDate("2026-08-28", now)).not.toThrow();
    expect(() => assertPoDate("2026-08-27", now)).toThrow(/31 days/);
    expect(() => assertPoDate("2026-09-29", now)).toThrow(/future/);
    expect(() => assertPoDate("2026-02-30", now)).toThrow(/Invalid/);
    expect(() => assertQuantity(0)).toThrow();
    expect(() => assertQuantity(Number.NaN)).toThrow();
    expect(() => assertQuantity(0.5)).not.toThrow();
    expect(normalizeActivityCodes([])).toEqual(["purchase_order"]);
    expect(
      normalizeActivityCodes(["collection", "merchandising", "collection"]),
    ).toEqual(["purchase_order", "merchandising", "collection"]);
    expect(() => normalizeActivityCodes(["gossip"])).toThrow(/Unknown/);
  });

  it("sales admin encodes a PO for a store outside the day's MCP; the salesperson records the activity", async () => {
    const { t, ids, as, po } = await fixture();
    const candidates = await as("adminA").query(
      api.orders.outside_calls.candidates,
      { outletId: ids.store.id, serviceDate: today },
    );
    expect(candidates).toEqual({
      outletName: "Store O1",
      outletCode: "O1",
      hasTerritory: true,
      salespeople: [
        { profileId: ids.ana.id, name: "Ana", kind: "primary", inPlan: false },
      ],
    });
    const first = await as("adminA").mutation(
      api.orders.outside_calls.encode,
      po(),
    );
    expect(first.replayed).toBe(false);
    // Same request replays; the same id for a different PO is refused.
    expect(
      await as("adminA").mutation(api.orders.outside_calls.encode, po()),
    ).toEqual({ orderId: first.orderId, replayed: true });
    await expect(
      as("adminA").mutation(
        api.orders.outside_calls.encode,
        po({ poNumber: "PO-OTHER" }),
      ),
    ).rejects.toThrow(/reused/);

    const stored = await t.run((ctx) => ctx.db.get(first.orderId));
    expect(stored).toMatchObject({
      status: "awaiting_activity",
      orgUnitId: ids.regionA,
      territoryId: ids.territory,
      customerId: ids.customer,
      salespersonProfileId: ids.ana.id,
      encodedByProfileId: ids.adminA.id,
      encodedBy: subject("adminA"),
      lines: [
        {
          productCode: "P-1",
          productName: "Product P-1",
          quantity: 10,
          uom: "CS",
        },
        { productCode: "P-2", quantity: 2.5, uom: "CS" },
      ],
    });

    // Ana sees it waiting for her.
    const waiting = await as("Ana").query(api.orders.outside_calls.mine, {
      status: "awaiting_activity",
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(waiting.page).toMatchObject([
      {
        order: { _id: first.orderId, poNumber: "PO-1001" },
        outletName: "Store O1",
        salespersonName: "Ana",
        encodedByName: "adminA",
      },
    ]);
    // Only Ana records it; not Ben, not her manager.
    for (const other of ["Ben", "managerA"])
      await expect(
        as(other).mutation(api.orders.outside_calls.recordActivity, {
          orderId: first.orderId,
          contact: "phone",
          codes: [],
        }),
      ).rejects.toThrow(/credited salesperson/);
    await expect(
      as("Ana").mutation(api.orders.outside_calls.recordActivity, {
        orderId: first.orderId,
        contact: "other",
        codes: [],
      }),
    ).rejects.toThrow(/how the store was reached/);
    await as("Ana").mutation(api.orders.outside_calls.recordActivity, {
      orderId: first.orderId,
      contact: "phone",
      codes: ["collection"],
      note: " Confirmed delivery Wednesday ",
    });
    await expect(
      as("Ana").mutation(api.orders.outside_calls.recordActivity, {
        orderId: first.orderId,
        contact: "phone",
        codes: [],
      }),
    ).rejects.toThrow(/already recorded/);
    const recorded = await t.run((ctx) => ctx.db.get(first.orderId));
    expect(recorded).toMatchObject({
      status: "activity_recorded",
      activity: {
        contact: "phone",
        codes: ["purchase_order", "collection"],
        note: "Confirmed delivery Wednesday",
        recordedAt: now,
      },
    });

    // The day view for the salesperson and their manager; never a call.
    const day = await as("managerA").query(api.orders.outside_calls.forDay, {
      salespersonProfileId: ids.ana.id,
      serviceDate: today,
    });
    expect(day.map((row) => row.order._id)).toEqual([first.orderId]);
    await expect(
      as("Ben").query(api.orders.outside_calls.forDay, {
        salespersonProfileId: ids.ana.id,
        serviceDate: today,
      }),
    ).rejects.toThrow(/own day/);
    const audits = await t.run((ctx) =>
      ctx.db
        .query("auditLogs")
        .filter((q) => q.eq(q.field("entityId"), first.orderId))
        .collect(),
    );
    expect(audits.map((row) => row.action)).toEqual([
      "order.outside_call_encoded",
      "order.outside_call_activity",
    ]);
  });

  it("refuses stores in the day's plan, wrong salespeople, duplicates and bad lines", async () => {
    const { ids, as, po } = await fixture();
    const admin = as("adminA");
    const candidates = await admin.query(api.orders.outside_calls.candidates, {
      outletId: ids.planned.id,
      serviceDate: today,
    });
    expect(candidates.salespeople).toMatchObject([{ inPlan: true }]);
    await expect(
      admin.mutation(
        api.orders.outside_calls.encode,
        po({ outletId: ids.planned.id }),
      ),
    ).rejects.toThrow(/in the salesperson's plan/);
    // The same planned store on another day is an outside call.
    await admin.mutation(
      api.orders.outside_calls.encode,
      po({
        clientRequestId: "req-other-day",
        outletId: ids.planned.id,
        serviceDate: "2026-09-26",
      }),
    );
    await expect(
      admin.mutation(
        api.orders.outside_calls.encode,
        po({ clientRequestId: "req-2", salespersonProfileId: ids.ben.id }),
      ),
    ).rejects.toThrow(/does not cover/);
    await expect(
      admin.mutation(
        api.orders.outside_calls.encode,
        po({ clientRequestId: "req-3", outletId: ids.loose.id }),
      ),
    ).rejects.toThrow(/no territory/);
    for (const [key, lines, message] of [
      ["req-4", [], /at least one/],
      ["req-5", [{ productId: ids.juice, quantity: 0 }], /more than 0/],
      ["req-6", [{ productId: ids.retired, quantity: 1 }], /inactive/],
      [
        "req-7",
        [
          { productId: ids.juice, quantity: 1 },
          { productId: ids.juice, quantity: 2 },
        ],
        /once/,
      ],
    ] as const)
      await expect(
        admin.mutation(
          api.orders.outside_calls.encode,
          po({ clientRequestId: key, lines: [...lines] }),
        ),
      ).rejects.toThrow(message);
    await expect(
      admin.mutation(
        api.orders.outside_calls.encode,
        po({ clientRequestId: "req-8", serviceDate: "2026-10-01" }),
      ),
    ).rejects.toThrow(/future/);
    const first = await admin.mutation(api.orders.outside_calls.encode, po());
    await expect(
      admin.mutation(
        api.orders.outside_calls.encode,
        po({ clientRequestId: "req-9" }),
      ),
    ).rejects.toThrow(/already encoded/);
    // After cancelling, the same PO number can be encoded again.
    await admin.mutation(api.orders.outside_calls.cancel, {
      orderId: first.orderId,
      reason: "Wrong store",
    });
    await expect(
      as("Ana").mutation(api.orders.outside_calls.recordActivity, {
        orderId: first.orderId,
        contact: "phone",
        codes: [],
      }),
    ).rejects.toThrow(/cancelled/);
    await admin.mutation(
      api.orders.outside_calls.encode,
      po({ clientRequestId: "req-10" }),
    );
  });

  it("only office roles in scope encode or cancel; lists stay in scope", async () => {
    const { ids, as, po } = await fixture();
    for (const name of ["Ana", "managerA", "approverA"])
      await expect(
        as(name).mutation(api.orders.outside_calls.encode, po()),
      ).rejects.toThrow();
    await expect(
      as("adminB").mutation(api.orders.outside_calls.encode, po()),
    ).rejects.toThrow();
    const { orderId } = await as("national").mutation(
      api.orders.outside_calls.encode,
      po(),
    );
    await expect(
      as("adminB").mutation(api.orders.outside_calls.cancel, {
        orderId,
        reason: "nope",
      }),
    ).rejects.toThrow();
    const page = { cursor: null, numItems: 10 };
    const list = (name: string) =>
      as(name).query(api.orders.outside_calls.list, {
        status: "awaiting_activity",
        paginationOpts: page,
      });
    expect((await list("adminA")).page).toHaveLength(1);
    expect((await list("managerA")).page).toHaveLength(1);
    expect((await list("Ana")).page).toHaveLength(1);
    expect((await list("Ben")).page).toHaveLength(0);
    expect((await list("adminB")).page).toHaveLength(0);
    expect(
      (
        await as("Ben").query(api.orders.outside_calls.mine, {
          status: "awaiting_activity",
          paginationOpts: page,
        })
      ).page,
    ).toHaveLength(0);
    await expect(
      as("adminB").query(api.orders.outside_calls.candidates, {
        outletId: ids.store.id,
        serviceDate: today,
      }),
    ).rejects.toThrow();
  });
});
