import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import { manilaDate } from "../coverage/validation";
import type { AuthorizedDevice } from "./types";

// SP-0025 (QSR-003) server half of the offline / poor-network chaos suite. A seeded fault
// injector sits between a phone-like outbox and the real `mobile/push:applyOne` mutation and
// simulates airplane mode, lost requests, lost acknowledgements, duplicate delivery, replays
// of already-acknowledged work after an app restart, concurrent foreground/background flights,
// long offline periods and revocation on reconnect. The client halves live in
// apps/field-android (ChaosSyncTest.kt) and apps/field-ios (ChaosSyncTests.swift); the
// matrix is docs/qa/OFFLINE_CHAOS_TESTS.md.

const DAY = 86_400_000;
const start = Date.parse("2026-09-28T02:00:00Z"); // 10:00 Manila, a Monday
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type T = TestConvex<typeof schema>;
type Operation = FunctionArgs<
  typeof internal.mobile.push.applyOne
>["operation"];
type Result = FunctionReturnType<typeof internal.mobile.push.applyOne>;
type Accepted = Extract<Result, { status: "accepted" }>;

afterEach(() => vi.useRealTimers());

async function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  const t: T = convexTest(schema, modules);
  const since = start - 30 * DAY;
  const ids = await t.run(async (ctx) => {
    const unit = await ctx.db.insert("orgUnits", {
      organizationId: "sunpride",
      code: "SUNPRIDE",
      name: "Cebu",
      typeCode: "NATIONAL",
      status: "active",
      effectiveFrom: since,
      createdAt: since,
      updatedAt: since,
    });
    const profile = await ctx.db.insert("profiles", {
      authSubject: "https://auth.test|sales",
      name: "sales",
      email: "sales@test.local",
      role: "sales",
      status: "active",
      orgUnitId: unit,
      updatedAt: since,
    });
    await ctx.db.insert("employeeAssignments", {
      profileId: profile,
      orgUnitId: unit,
      role: "sales",
      effectiveFrom: since,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: since,
    });
    const territory = await ctx.db.insert("territories", {
      organizationId: "sunpride",
      code: "T",
      name: "Territory",
      status: "active",
      effectiveFrom: since,
      createdAt: since,
      updatedAt: since,
      createdBy: "fixture",
    });
    await ctx.db.insert("territoryOwnerships", {
      territoryId: territory,
      orgUnitId: unit,
      effectiveFrom: since,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: since,
    });
    await ctx.db.insert("territorySalespeople", {
      territoryId: territory,
      profileId: profile,
      kind: "primary",
      effectiveFrom: since,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: since,
    });
    const outlets: Id<"outlets">[] = [];
    for (const code of ["O1", "O2"]) {
      const outlet = await ctx.db.insert("outlets", {
        organizationId: "sunpride",
        code,
        name: `Store ${code}`,
        status: "active",
        custodianOrgUnitId: unit,
        createdAt: since,
        updatedAt: since,
        createdBy: "fixture",
      });
      await ctx.db.insert("outletAssignments", {
        outletId: outlet,
        territoryId: territory,
        effectiveFrom: since,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: since,
      });
      outlets.push(outlet);
    }
    const device = await ctx.db.insert("registeredDevices", {
      organizationId: "sunpride",
      orgUnitId: unit,
      inventoryTag: "D1",
      profileId: profile,
      boundSubject: "https://auth.test|sales",
      allowedApp: "ANDROID",
      platform: "android",
      model: "test",
      osVersion: "1",
      appVersion: "1",
      publicKey: "key",
      credentialId: "D1",
      registeredAt: since,
      status: "active",
    });
    return { unit, profile, outlets, device };
  });
  const actor: AuthorizedDevice = {
    deviceId: ids.device,
    profileId: ids.profile,
    orgUnitId: ids.unit,
    role: "sales",
    subject: "https://auth.test|sales",
    scopeFingerprint: "fixture",
  };
  const sales = t.withIdentity({
    subject: "sales",
    issuer: "https://auth.test",
    tokenIdentifier: actor.subject,
  });
  const apply = (operation: Operation) =>
    sales.mutation(internal.mobile.push.applyOne, {
      deviceId: ids.device,
      actor,
      operation,
    });
  const tables = [
    "visitExecutions",
    "visitActivities",
    "executionEvents",
    "mobileChanges",
    "processedMobileOperations",
  ] as const;
  const counts = () =>
    t.run(async (ctx) => {
      const out: Record<string, number> = {};
      for (const name of tables)
        out[name] = (await ctx.db.query(name).collect()).length;
      return out;
    });
  return { t, ids, actor, apply, counts };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** One queued phone intent. Dependents resolve the server visit ID only from a durable ack. */
type Intent = {
  key: string;
  build: (acks: Map<string, Accepted>) => Operation | null;
};

/** A two-store offline day, written on the phone while it had no signal. */
function offlineDay(f: Fixture, deviceTime: number, base = 0): Intent[] {
  const serviceDate = manilaDate(deviceTime);
  return f.ids.outlets.flatMap((outletId, index) => {
    const n = base + index * 10;
    const checkIn = uuid(n + 1),
      note = uuid(n + 2),
      checkOut = uuid(n + 3);
    const at = deviceTime + index * 3_600_000;
    const visitId = (acks: Map<string, Accepted>) =>
      acks.get(checkIn)?.ack.entityId as Id<"visitExecutions"> | undefined;
    return [
      {
        key: checkIn,
        build: () => ({
          kind: "visit.checkIn" as const,
          clientRequestId: checkIn,
          payload: {
            clientVisitId: uuid(n + 100),
            plannedVisitId: null,
            outletId,
            serviceDate,
            deviceTime: at,
            location: null,
            intents: ["sell" as const],
            unplannedReason: "Prospect call",
          },
        }),
      },
      {
        key: note,
        build: (acks) => {
          const id = visitId(acks);
          return id
            ? {
                kind: "visit.activity" as const,
                clientRequestId: note,
                dependsOn: [checkIn],
                payload: {
                  visitId: id,
                  activity: { kind: "note" as const, text: `Store ${index}` },
                  deviceTime: at + 60_000,
                },
              }
            : null;
        },
      },
      {
        key: checkOut,
        build: (acks) => {
          const id = visitId(acks);
          return id && acks.has(note)
            ? {
                kind: "visit.checkOut" as const,
                clientRequestId: checkOut,
                dependsOn: [note],
                payload: {
                  visitId: id,
                  outcome: "completed" as const,
                  reasonCode: null,
                  deviceTime: at + 600_000,
                  location: null,
                },
              }
            : null;
        },
      },
    ];
  });
}

/** Stable wire bytes for an operation; `int64` prices travel as bigint in the Convex args. */
function wire(op: Operation | null) {
  return JSON.stringify(op, (_key, value: unknown) =>
    typeof value === "bigint" ? `${value}n` : value,
  );
}

/** Deterministic PRNG (mulberry32) so a failing seed can be replayed exactly. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const FAULTS = [
  "ok",
  "airplane", // request never leaves the phone
  "lost_request", // radio drops the request before the server sees it
  "lost_ack", // server commits, response never arrives (also: app killed mid-flight)
  "duplicate", // flaky proxy / OS retry delivers the same request twice at once
  "replay_acked", // restart restores an already-acknowledged row and resends it
] as const;
type Fault = (typeof FAULTS)[number];

/**
 * A phone outbox draining through a hostile network. Acks are stored durably only after a
 * response arrives (ack-before-done); every send reuses the immutable operation built on first
 * send, as the native outboxes do.
 */
async function drain(
  f: Fixture,
  queue: Intent[],
  pick: () => Fault,
  options: { acks?: Map<string, Accepted>; advance?: () => number } = {},
) {
  const acks = options.acks ?? new Map<string, Accepted>();
  const frozen = new Map<string, string>();
  const sent = new Map<string, Operation>();
  const faults: Fault[] = [];
  for (let attempt = 0; attempt < 400; attempt++) {
    const next = queue.find((intent) => !acks.has(intent.key));
    if (!next) return { acks, faults };
    const op = next.build(acks);
    // The outbox never sends a dependent before its dependency's durable ack.
    expect(op, `${next.key} must be buildable in order`).not.toBeNull();
    const bytes = wire(op);
    expect(frozen.get(next.key) ?? bytes).toBe(bytes); // byte-identical replay
    frozen.set(next.key, bytes);
    sent.set(next.key, op!);
    vi.setSystemTime(Date.now() + (options.advance?.() ?? 0));
    const fault = pick();
    faults.push(fault);
    if (fault === "airplane" || fault === "lost_request") continue;
    if (fault === "lost_ack") {
      await f.apply(op!);
      continue;
    }
    if (fault === "replay_acked" && acks.size > 0) {
      const done = queue.filter((intent) => acks.has(intent.key));
      const old = done[attempt % done.length]!;
      const replay = sent.get(old.key)!;
      expect(await f.apply(replay)).toEqual(acks.get(old.key));
    }
    const results =
      fault === "duplicate"
        ? await Promise.all([f.apply(op!), f.apply(op!)])
        : [await f.apply(op!)];
    for (const result of results) {
      expect(result.status, next.key).toBe("accepted");
      expect(result).toEqual(results[0]);
    }
    acks.set(next.key, results[0] as Accepted);
  }
  throw new Error("outbox did not drain");
}

async function serverState(f: Fixture) {
  return f.t.run(async (ctx) => {
    const visits = await ctx.db.query("visitExecutions").collect();
    const events = await ctx.db.query("executionEvents").collect();
    return {
      visitStates: visits.map((v) => v.state),
      eventKinds: events.map((e) => `${e.entityType}:${e.kind}`).sort(),
    };
  });
}

describe("offline and poor-network chaos (server)", () => {
  it("drains a two-store offline day exactly once under 40 seeded mixes of airplane mode, lost requests, lost acks, duplicates and restart replays", async () => {
    const clean = await fixture();
    await drain(clean, offlineDay(clean, start), () => "ok");
    const expectedCounts = await clean.counts();
    const expectedState = await serverState(clean);
    expect(expectedState.visitStates).toEqual(["checked-out", "checked-out"]);
    expect(expectedCounts).toEqual({
      visitExecutions: 2,
      visitActivities: 2,
      executionEvents: 6,
      mobileChanges: 6,
      processedMobileOperations: 6,
    });
    const seen = new Set<Fault>();
    for (let seed = 1; seed <= 40; seed++) {
      const f = await fixture();
      const random = rng(seed);
      const queue = offlineDay(f, start);
      const { acks, faults } = await drain(
        f,
        queue,
        () => FAULTS[Math.floor(random() * FAULTS.length)]!,
        { advance: () => Math.floor(random() * 120_000) },
      );
      faults.forEach((fault) => seen.add(fault));
      expect(await f.counts(), `seed ${seed}`).toEqual(expectedCounts);
      expect(await serverState(f), `seed ${seed}`).toEqual(expectedState);
      // After reconnect, a full resend of the queue is a no-op returning the stored acks.
      for (const intent of queue)
        expect(await f.apply(intent.build(acks)!)).toEqual(
          acks.get(intent.key),
        );
      expect(await f.counts(), `seed ${seed} replay`).toEqual(expectedCounts);
    }
    expect([...seen].sort()).toEqual([...FAULTS].sort());
  }, 120_000); // 40 fresh deployments; generous under a loaded parallel turbo run

  it("rejects a dependent sent ahead of its dependency after a restart without consuming its key, then accepts it in order", async () => {
    const f = await fixture();
    const queue = offlineDay(f, start);
    const { acks } = await drain(f, queue.slice(0, 1), () => "ok");
    // A restarted client that lost its ordering sends the check-out before the note's ack.
    const pretend = new Map(acks);
    pretend.set(queue[1]!.key, acks.get(queue[0]!.key)!);
    const early = queue[2]!.build(pretend)!;
    expect(await f.apply(early)).toEqual({
      status: "rejected",
      code: "dependency_missing",
    });
    expect((await f.counts()).processedMobileOperations).toBe(1);
    await drain(f, queue, () => "ok", { acks });
    expect((await f.counts()).processedMobileOperations).toBe(6);
    // The rejected key was not consumed: the same bytes now return the in-order ack.
    expect(await f.apply(early)).toEqual(acks.get(queue[2]!.key));
  });

  it("commits each operation once when foreground and background flights resend the same queue concurrently", async () => {
    const f = await fixture();
    const queue = offlineDay(f, start);
    const [foreground, background] = await Promise.all([
      drain(f, queue, () => "ok"),
      drain(f, queue, () => "ok"),
    ]);
    expect([...foreground.acks.entries()]).toEqual([
      ...background.acks.entries(),
    ]);
    expect(await f.counts()).toEqual({
      visitExecutions: 2,
      visitActivities: 2,
      executionEvents: 6,
      mobileChanges: 6,
      processedMobileOperations: 6,
    });
  });

  it("accepts a day synced six days late and flags it for supervisor review, but refuses work older than the late window without writing", async () => {
    const f = await fixture();
    const late = offlineDay(f, start);
    vi.setSystemTime(start + 6 * DAY);
    await drain(f, late, () => "ok");
    const visits = await f.t.run((ctx) =>
      ctx.db.query("visitExecutions").collect(),
    );
    expect(visits.map((v) => v.lateReviewStatus)).toEqual([
      "pending_review",
      "pending_review",
    ]);
    expect(visits.map((v) => v.serviceDate)).toEqual([
      manilaDate(start),
      manilaDate(start),
    ]);
    const before = await f.counts();
    const stale = offlineDay(f, start - 3 * DAY, 500);
    vi.setSystemTime(start + 6 * DAY);
    await expect(f.apply(stale[0]!.build(new Map())!)).rejects.toThrow(
      /invalid_request|wrong_date/,
    );
    expect(await f.counts()).toEqual(before);
  });

  it("refuses the rest of the queue when the phone was revoked while offline, keeps accepted work, and never replays past the revocation", async () => {
    const f = await fixture();
    const queue = offlineDay(f, start);
    const { acks } = await drain(f, queue.slice(0, 3), () => "ok");
    const accepted = await f.counts();
    await f.t.run((ctx) => ctx.db.patch(f.ids.device, { status: "revoked" }));
    await expect(f.apply(queue[3]!.build(acks)!)).rejects.toThrow();
    await expect(f.apply(queue[0]!.build(acks)!)).rejects.toThrow();
    expect(await f.counts()).toEqual(accepted);
    const visits = await f.t.run((ctx) =>
      ctx.db.query("visitExecutions").collect(),
    );
    expect(visits.map((v) => v.state)).toEqual(["checked-out"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Planned MCP day: every visit transaction the server accepts from a phone today. Store 1 is a
// planned productive call with each structured activity form (ICO inventory check,
// merchandising, price check, promotion, order intent, call sheet, note); store 2 is the next
// planned stop, closed as nonproductive. Collections and task completion are still refused as
// `unsupported_operation` by `mobile/push` and are listed as not yet testable in the catalogue.

/** Seeds an active signed MCP for today (two ordered stops), a product, a UOM and call sheets. */
async function plannedFixture() {
  const f = await fixture();
  const seeded = await f.t.run(async (ctx) => {
    const now = Date.now();
    const serviceDate = manilaDate(now);
    const employee = (await ctx.db
      .query("employeeAssignments")
      .withIndex("by_profileId_and_effectiveFrom", (q) =>
        q.eq("profileId", f.ids.profile),
      )
      .first())!;
    const uom = await ctx.db.insert("unitsOfMeasure", {
      organizationId: "sunpride",
      code: "PC",
      name: "Piece",
      dimension: "count",
      decimalPlaces: 0,
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    const product = await ctx.db.insert("products", {
      code: "SKU-1",
      name: "Corned beef 150g",
      category: "Canned",
      uom: "PC",
      unitPrice: 45,
      active: true,
      organizationId: "sunpride",
      baseUomId: uom,
      updatedAt: now,
    });
    const plan = await ctx.db.insert("coveragePlans", {
      organizationId: "sunpride",
      assigneeProfileId: f.ids.profile,
      localMonth: serviceDate.slice(0, 7),
      version: 1,
      cycleType: "monthly",
      orgUnitId: f.ids.unit,
      territoryIds: [],
      requestedFrom: now - DAY,
      requestedTo: now + 7 * DAY,
      effectiveFrom: now - DAY,
      effectiveTo: now + 7 * DAY,
      status: "active",
      preparedBy: f.actor.subject,
      preparedAt: now - DAY,
      approvedBy: "https://auth.test|manager",
      approvedAt: now - DAY,
      approvalSignature: "signed",
      contentRevision: 1,
      createdBy: f.actor.subject,
      createdAt: now - DAY,
      updatedBy: f.actor.subject,
      updatedAt: now - DAY,
    });
    const planned: Id<"plannedVisits">[] = [];
    for (const [index, outletId] of f.ids.outlets.entries()) {
      const outletAssignment = (await ctx.db
        .query("outletAssignments")
        .withIndex("by_outletId_and_effectiveFrom", (q) =>
          q.eq("outletId", outletId),
        )
        .first())!;
      const ownership = (await ctx.db
        .query("territoryOwnerships")
        .withIndex("by_territoryId_and_effectiveFrom", (q) =>
          q.eq("territoryId", outletAssignment.territoryId),
        )
        .first())!;
      await ctx.db.patch(plan, {
        territoryIds: [outletAssignment.territoryId],
      });
      await ctx.db.insert("callSheetAccounts", {
        organizationId: "sunpride",
        outletId,
        revision: 1,
        header: { accountName: `Store O${index + 1}` },
        lines: [{ productId: product }],
        updatedAt: now - DAY,
        updatedBy: "fixture",
      });
      const snapshot = {
        outletId,
        outletCode: `O${index + 1}`,
        outletName: `Store O${index + 1}`,
        territoryId: outletAssignment.territoryId,
        territoryCode: "T",
        outletAssignmentId: outletAssignment._id,
        territoryOwnershipId: ownership._id,
        employeeAssignmentId: employee._id,
        orgUnitId: f.ids.unit,
        activityKind: "sell",
        approvedAssigneeProfileId: f.ids.profile,
      };
      const slot = await ctx.db.insert("coveragePlanSlots", {
        slotKey: `stop-${index + 1}`,
        planId: plan,
        assigneeProfileId: f.ids.profile,
        serviceDate,
        kind: "outlet_visit",
        outletId,
        activityKind: "sell",
        requiredObjectives: [],
        intents: ["sell"],
        sequence: index + 1,
        expectedDurationMinutes: 30,
        approvedSnapshot: snapshot,
        contentRevision: 1,
        updatedBy: f.actor.subject,
        updatedAt: now - DAY,
      });
      planned.push(
        await ctx.db.insert("plannedVisits", {
          generationKey: "signed",
          planId: plan,
          planVersion: 1,
          planSlotId: slot,
          assigneeProfileId: f.ids.profile,
          outletId,
          serviceDate,
          status: "planned",
          approvedSnapshot: snapshot,
          requiredObjectives: [],
          intents: ["sell"],
          expectedDurationMinutes: 30,
          generatedAt: now - DAY,
        }),
      );
    }
    return { product, uom, planned };
  });
  return { ...f, ...seeded };
}
type PlannedFixture = Awaited<ReturnType<typeof plannedFixture>>;

/** A planned MCP day captured offline from 06:00 Manila, in the order the phone saved it. */
function plannedDay(f: PlannedFixture): Intent[] {
  const deviceStart = Date.now() - 4 * 3_600_000;
  const serviceDate = manilaDate(deviceStart);
  const intents: Intent[] = [];
  const store = (
    index: number,
    activities: Extract<
      Operation,
      { kind: "visit.activity" }
    >["payload"]["activity"][],
    outcome: "completed" | "nonproductive",
  ) => {
    const n = 200 + index * 20;
    const at = deviceStart + index * 3_600_000;
    const checkIn = uuid(n + 1);
    const visitId = (acks: Map<string, Accepted>) =>
      acks.get(checkIn)?.ack.entityId as Id<"visitExecutions"> | undefined;
    intents.push({
      key: checkIn,
      build: () => ({
        kind: "visit.checkIn" as const,
        clientRequestId: checkIn,
        payload: {
          clientVisitId: uuid(n + 19),
          plannedVisitId: f.planned[index]!,
          outletId: f.ids.outlets[index]!,
          serviceDate,
          deviceTime: at,
          location: null,
          intents: ["sell" as const],
        },
      }),
    });
    let previous = checkIn;
    activities.forEach((activity, offset) => {
      const key = uuid(n + 2 + offset);
      const dependency = previous;
      intents.push({
        key,
        build: (acks) => {
          const id = visitId(acks);
          return id && acks.has(dependency)
            ? {
                kind: "visit.activity" as const,
                clientRequestId: key,
                dependsOn: [dependency],
                payload: {
                  visitId: id,
                  activity,
                  deviceTime: at + (offset + 1) * 60_000,
                },
              }
            : null;
        },
      });
      previous = key;
    });
    const checkOut = uuid(n + 18);
    const dependency = previous;
    intents.push({
      key: checkOut,
      build: (acks) => {
        const id = visitId(acks);
        return id && acks.has(dependency)
          ? {
              kind: "visit.checkOut" as const,
              clientRequestId: checkOut,
              dependsOn: [dependency],
              payload: {
                visitId: id,
                outcome,
                reasonCode: outcome === "nonproductive" ? "store_closed" : null,
                deviceTime: at + 20 * 60_000,
                location: null,
              },
            }
          : null;
      },
    });
  };
  store(
    0,
    [
      {
        kind: "inventory_check",
        productId: f.product,
        icoFinding: "present",
        observedQuantity: 12,
        uomId: f.uom,
      },
      {
        kind: "merchandising",
        displayCondition: "needs_action",
        actionTaken: "Faced up the shelf",
      },
      {
        kind: "price_check",
        productId: f.product,
        observedPriceMinor: 4_550n,
        currency: "PHP",
        compliant: false,
      },
      { kind: "promotion", programRef: "PROMO-SEPT", finding: "executed" },
      { kind: "order_intent", clientOrderId: uuid(9_001), note: "2 cases" },
      {
        kind: "call_sheet",
        lines: [
          {
            productId: f.product,
            order: 24,
            beginningInventory: 10,
            take: null,
            delivered: null,
            offtake: 4,
            endInventory: 6,
          },
        ],
      },
      { kind: "note", text: "Buyer asked for a new price list" },
    ],
    "completed",
  );
  store(1, [], "nonproductive");
  return intents;
}

async function plannedState(f: PlannedFixture) {
  return f.t.run(async (ctx) => {
    const visits = await ctx.db.query("visitExecutions").collect();
    const activities = await ctx.db.query("visitActivities").collect();
    const events = await ctx.db.query("executionEvents").collect();
    return {
      visits: visits.map((v) => ({
        plannedVisitId: v.plannedVisitId,
        source: v.source,
        state: v.state,
        outcome: v.outcome,
        missingActivities: v.missingActivities,
      })),
      activityKinds: activities.map((a) => a.activity.kind),
      callSheetEntries: (await ctx.db.query("callSheetEntries").collect())
        .length,
      eventKinds: events.map((e) => `${e.entityType}:${e.kind}`).sort(),
    };
  });
}

describe("offline and poor-network chaos (server, planned MCP day)", () => {
  it("drains a planned MCP day with every structured activity form and a nonproductive stop exactly once under 30 seeded fault mixes", async () => {
    const clean = await plannedFixture();
    const cleanQueue = plannedDay(clean);
    await drain(clean, cleanQueue, () => "ok");
    const expectedCounts = await clean.counts();
    const expectedState = await plannedState(clean);
    expect(expectedState.visits).toEqual([
      {
        plannedVisitId: clean.planned[0],
        source: "planned",
        state: "checked-out",
        outcome: "completed",
        missingActivities: [],
      },
      {
        plannedVisitId: clean.planned[1],
        source: "planned",
        state: "checked-out",
        outcome: "nonproductive",
        missingActivities: [],
      },
    ]);
    expect(expectedState.activityKinds).toEqual([
      "inventory_check",
      "merchandising",
      "price_check",
      "promotion",
      "order_intent",
      "call_sheet",
      "note",
    ]);
    expect(expectedState.callSheetEntries).toBe(1);
    expect(expectedCounts.processedMobileOperations).toBe(cleanQueue.length);
    expect(expectedCounts.executionEvents).toBe(cleanQueue.length);
    const seen = new Set<Fault>();
    for (let seed = 101; seed <= 130; seed++) {
      const f = await plannedFixture();
      const random = rng(seed);
      const queue = plannedDay(f);
      const { acks, faults } = await drain(
        f,
        queue,
        () => FAULTS[Math.floor(random() * FAULTS.length)]!,
        { advance: () => Math.floor(random() * 60_000) },
      );
      faults.forEach((fault) => seen.add(fault));
      const state = await plannedState(f);
      expect(await f.counts(), `seed ${seed}`).toEqual(expectedCounts);
      expect(
        {
          ...state,
          visits: state.visits.map((v) => ({ ...v, plannedVisitId: null })),
        },
        `seed ${seed}`,
      ).toEqual({
        ...expectedState,
        visits: expectedState.visits.map((v) => ({
          ...v,
          plannedVisitId: null,
        })),
      });
      expect(state.visits.map((v) => v.plannedVisitId)).toEqual(f.planned);
      for (const intent of queue)
        expect(await f.apply(intent.build(acks)!)).toEqual(
          acks.get(intent.key),
        );
      expect(await f.counts(), `seed ${seed} replay`).toEqual(expectedCounts);
    }
    expect([...seen].sort()).toEqual([...FAULTS].sort());
  }, 180_000);

  it("refuses the next planned stop while the earlier stop is open or unclosed after a restart, without consuming its key, then accepts the same bytes in order", async () => {
    const f = await plannedFixture();
    const queue = plannedDay(f);
    const secondCheckIn = queue.findIndex(
      (intent, index) =>
        index > 0 && intent.build(new Map())?.kind === "visit.checkIn",
    );
    const early = queue[secondCheckIn]!.build(new Map())!;
    // Restarted client sends stop 2 before stop 1 was even started: MCP order refuses it.
    await expect(f.apply(early)).rejects.toThrow(/mcp_order/);
    expect((await f.counts()).processedMobileOperations).toBe(0);
    // Stop 1 is checked in but its check-out is still queued: a call is open.
    const { acks } = await drain(f, queue.slice(0, 1), () => "ok");
    await expect(f.apply(early)).rejects.toThrow(/call_open/);
    expect((await f.counts()).processedMobileOperations).toBe(1);
    await drain(f, queue, () => "ok", { acks });
    expect(await f.apply(early)).toEqual(acks.get(queue[secondCheckIn]!.key));
    expect((await f.counts()).processedMobileOperations).toBe(queue.length);
  });

  it("returns the stored ack for a planned check-in whose answer was lost, and refuses a second check-in for the same planned stop under a new request ID", async () => {
    const f = await plannedFixture();
    const queue = plannedDay(f);
    const first = queue[0]!.build(new Map())!;
    const ack = await f.apply(first); // committed; the phone never saw this
    const again = await f.apply(first);
    expect(again).toEqual(ack);
    const before = await f.counts();
    // A reinstalled app that lost its outbox mints a fresh request and visit ID for the stop.
    const fresh = {
      ...first,
      clientRequestId: uuid(8_001),
      payload: {
        ...(first as Extract<Operation, { kind: "visit.checkIn" }>).payload,
        clientVisitId: uuid(8_002),
      },
    } as Operation;
    await expect(f.apply(fresh)).rejects.toThrow(/conflict|call_open/);
    expect(await f.counts()).toEqual(before);
  });

  it("resolves a retried photo attach whose answer was lost to the original evidence row, and refuses changed metadata under the same checksum", async () => {
    const f = await plannedFixture();
    const queue = plannedDay(f);
    const { acks } = await drain(f, queue.slice(0, 2), () => "ok");
    const visitId = acks.get(queue[0]!.key)!.ack
      .entityId as Id<"visitExecutions">;
    const checksum = "ab".repeat(32);
    const capturedAt = Date.now() - 60_000;
    // The first attach committed (claim consumed, file stored) but the response was lost.
    // convex-test has no storage.getMetadata, so the committed row is written directly; the
    // claim and metadata checks of a first attach are covered in visits/evidence.test.ts.
    const original = await f.t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["first"]));
      return ctx.db.insert("fieldEvidenceFiles", {
        organizationId: "sunpride",
        orgUnitId: f.ids.unit,
        storageId,
        visitId,
        ownerProfileId: f.ids.profile,
        outletId: f.ids.outlets[0]!,
        mime: "image/jpeg",
        sizeBytes: 5,
        checksum,
        capturedAt,
        photoType: "shelf_display",
        uploadedAt: Date.now(),
        status: "pending",
      });
    });
    const sales = f.t.withIdentity({
      subject: "sales",
      issuer: "https://auth.test",
      tokenIdentifier: f.actor.subject,
    });
    // The phone retries: a fresh upload URL, a fresh upload of the same bytes, attach again.
    const retry = async (
      overrides: Partial<{ size: number; photoType: string }> = {},
    ) => {
      const { uploadTokenRef } = await sales.mutation(
        api.visits.evidence.generateUploadUrl,
        { visitId },
      );
      const storageId = await f.t.run((ctx) =>
        ctx.storage.store(new Blob(["first"])),
      );
      return sales.mutation(api.visits.evidence.attach, {
        uploadTokenRef,
        visitId,
        storageId,
        mime: "image/jpeg",
        size: 5,
        checksum,
        capturedAt,
        photoType: "shelf_display",
        source: "mobile",
        ...overrides,
      });
    };
    expect(await retry()).toEqual({ evidenceId: original });
    expect(await retry()).toEqual({ evidenceId: original });
    await expect(retry({ photoType: "storefront" })).rejects.toThrow(
      /conflict/,
    );
    const files = await f.t.run((ctx) =>
      ctx.db.query("fieldEvidenceFiles").collect(),
    );
    expect(files.map((file) => file._id)).toEqual([original]);
    // The photo is independent of the visit outbox: the rest of the day still drains once.
    await drain(f, queue, () => "ok", { acks });
    expect((await f.counts()).processedMobileOperations).toBe(queue.length);
  });
});
