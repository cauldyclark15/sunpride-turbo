import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { internal } from "../_generated/api";
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
  const faults: Fault[] = [];
  for (let attempt = 0; attempt < 400; attempt++) {
    const next = queue.find((intent) => !acks.has(intent.key));
    if (!next) return { acks, faults };
    const op = next.build(acks);
    // The outbox never sends a dependent before its dependency's durable ack.
    expect(op, `${next.key} must be buildable in order`).not.toBeNull();
    const bytes = JSON.stringify(op);
    expect(frozen.get(next.key) ?? bytes).toBe(bytes); // byte-identical replay
    frozen.set(next.key, bytes);
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
      const replay = JSON.parse(frozen.get(old.key)!) as Operation;
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
