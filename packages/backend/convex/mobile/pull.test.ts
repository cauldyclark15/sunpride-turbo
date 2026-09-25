import { describe, expect, it, vi, afterEach } from "vitest";
import { internal } from "../_generated/api";
import { fixture } from "./bootstrap.test";
import { readCursor, signCursor } from "./cursor";

async function change(
  f: Awaited<ReturnType<typeof fixture>>,
  sequence: number,
  owner: typeof f.ids.person,
  entity: string,
  entityId: string,
  op: "upsert" | "tombstone" = "upsert",
) {
  await f.t.run((ctx) =>
    ctx.db.insert("mobileChanges", {
      organizationId: "sunpride",
      orgUnitId: f.ids.unit,
      sequence,
      entity,
      entityId,
      revision: sequence,
      op,
      ownerProfileId: owner,
      serverAt: Date.now(),
      payloadVersion: 1,
    }),
  );
}
afterEach(() => vi.useRealTimers());
describe("mobile delta pull", () => {
  it("projects own upsert/tombstone and skips foreign-only pages with continuation", async () => {
    const f = await fixture();
    const boot = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
    });
    const execution = await f.t.run((ctx) =>
      ctx.db.insert("visitExecutions", {
        organizationId: "sunpride",
        clientVisitId: "client",
        assigneeProfileId: f.ids.person,
        outletId: f.ids.outlet,
        orgUnitId: f.ids.unit,
        serviceDate: f.day,
        source: "planned",
        plannedVisitId: f.ids.visit,
        planId: f.ids.plan,
        slotId: f.ids.slot,
        planVersion: 1,
        intents: ["sell"],
        state: "checked-in",
        productivity: "pending",
        createdAt: Date.now(),
        lastServerTime: Date.now(),
      }),
    );
    await change(f, 1, f.ids.stranger, "visit", execution);
    await change(f, 2, f.ids.person, "visit", execution);
    await change(f, 3, f.ids.person, "visit", execution, "tombstone");
    const empty = await f.caller.query(internal.mobile.pull.delta, {
      actor: f.actor,
      cursor: boot.syncCursor!,
      limit: 1,
    });
    expect(empty.changes).toEqual([]);
    expect(empty.hasMore).toBe(true);
    const own = await f.caller.query(internal.mobile.pull.delta, {
      actor: f.actor,
      cursor: empty.nextCursor,
      limit: 1,
    });
    expect(own.changes).toMatchObject([
      { seq: 2, op: "upsert", value: { id: execution, state: "checked-in" } },
    ]);
    const gone = await f.caller.query(internal.mobile.pull.delta, {
      actor: f.actor,
      cursor: own.nextCursor,
      limit: 1,
    });
    expect(gone.changes).toEqual([
      { seq: 3, entity: "visit", id: execution, revision: 3, op: "tombstone" },
    ]);
    expect(gone.hasMore).toBe(false);
  });
  it("rejects feed gaps, malformed or expired cursor, other device and scope transfer", async () => {
    const f = await fixture();
    const boot = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
    });
    const args = { actor: f.actor, cursor: boot.syncCursor! };
    await expect(
      f.caller.query(internal.mobile.pull.delta, {
        ...args,
        cursor: args.cursor + "x",
      }),
    ).rejects.toThrow("rebootstrap_required");
    const decoded = await readCursor(args.cursor, "pull", f.actor, Date.now());
    await expect(
      f.caller.query(internal.mobile.pull.delta, {
        ...args,
        cursor: await signCursor({ ...decoded, expires: Date.now() - 1 }),
      }),
    ).rejects.toThrow("rebootstrap_required");
    await expect(
      f.caller.query(internal.mobile.pull.delta, {
        ...args,
        cursor: await signCursor({ ...decoded, device: "other-device" }),
      }),
    ).rejects.toThrow("rebootstrap_required");
    await change(f, 2, f.ids.stranger, "visit", f.ids.visit);
    await expect(
      f.caller.query(internal.mobile.pull.delta, args),
    ).rejects.toThrow("rebootstrap_required");
    await f.t.run((ctx) => ctx.db.patch(f.ids.assignment, { role: "manager" }));
    await expect(
      f.caller.query(internal.mobile.pull.delta, args),
    ).rejects.toThrow("rebootstrap_required");
  });
  it("emits a tombstone rather than a foreign projection after outlet transfer", async () => {
    const f = await fixture();
    const boot = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
    });
    const execution = await f.t.run((ctx) =>
      ctx.db.insert("visitExecutions", {
        organizationId: "sunpride",
        clientVisitId: "transferred",
        assigneeProfileId: f.ids.person,
        outletId: f.ids.outlet,
        orgUnitId: f.ids.unit,
        serviceDate: f.day,
        source: "planned",
        plannedVisitId: f.ids.visit,
        planId: f.ids.plan,
        slotId: f.ids.slot,
        planVersion: 1,
        intents: [],
        state: "checked-in",
        productivity: "pending",
        createdAt: Date.now(),
        lastServerTime: Date.now(),
      }),
    );
    await change(f, 1, f.ids.person, "visit", execution);
    const foreignOutlet = await f.t.run((ctx) =>
      ctx.db.insert("outlets", {
        organizationId: "sunpride",
        code: "F",
        name: "Foreign",
        status: "active",
        custodianOrgUnitId: f.ids.foreignUnit,
        createdAt: f.now,
        updatedAt: f.now,
        createdBy: f.actor.subject,
      }),
    );
    await f.t.run((ctx) =>
      ctx.db.patch(execution, { outletId: foreignOutlet }),
    );
    const result = await f.caller.query(internal.mobile.pull.delta, {
      actor: f.actor,
      cursor: boot.syncCursor!,
    });
    expect(result.changes).toEqual([
      { seq: 1, entity: "visit", id: execution, revision: 1, op: "tombstone" },
    ]);
  });
  it("invalidates the cursor when route membership changes without a feed hook", async () => {
    const f = await fixture();
    const boot = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
    });
    await f.t.run((ctx) =>
      ctx.db.insert("territorySalespeople", {
        territoryId: f.ids.territory,
        profileId: f.ids.person,
        kind: "primary",
        effectiveFrom: f.now - 1000,
        actorSubject: f.actor.subject,
        reason: "reassigned",
        createdAt: f.now,
      }),
    );
    await expect(
      f.caller.query(internal.mobile.pull.delta, {
        actor: f.actor,
        cursor: boot.syncCursor!,
      }),
    ).rejects.toThrow("rebootstrap_required");
  });
  it("delivers writes made during snapshot pagination after the starting high-water", async () => {
    const f = await fixture();
    await f.t.run((ctx) =>
      ctx.db.insert("plannedVisits", {
        generationKey: "second",
        planId: f.ids.plan,
        planVersion: 1,
        planSlotId: f.ids.slot,
        assigneeProfileId: f.ids.person,
        outletId: f.ids.outlet,
        serviceDate: f.day,
        status: "planned",
        approvedSnapshot: f.ids.snapshot,
        requiredObjectives: [],
        intents: [],
        expectedDurationMinutes: 15,
        generatedAt: Date.now(),
      }),
    );
    const first = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
      limit: 1,
    });
    expect(first.syncCursor).toBeNull();
    const execution = await f.t.run((ctx) =>
      ctx.db.insert("visitExecutions", {
        organizationId: "sunpride",
        clientVisitId: "during",
        assigneeProfileId: f.ids.person,
        outletId: f.ids.outlet,
        orgUnitId: f.ids.unit,
        serviceDate: f.day,
        source: "planned",
        plannedVisitId: f.ids.visit,
        planId: f.ids.plan,
        slotId: f.ids.slot,
        planVersion: 1,
        intents: ["sell"],
        state: "checked-in",
        productivity: "pending",
        createdAt: Date.now(),
        lastServerTime: Date.now(),
      }),
    );
    await change(f, 1, f.ids.person, "visit", execution);
    const final = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
      pageCursor: first.nextPageCursor!,
      limit: 1,
    });
    expect(final.syncCursor).toBeTruthy();
    const delta = await f.caller.query(internal.mobile.pull.delta, {
      actor: f.actor,
      cursor: final.syncCursor!,
    });
    expect(delta.changes).toMatchObject([
      { seq: 1, id: execution, op: "upsert" },
    ]);
  });
  it("detects untracked plan edits and concurrent snapshot writes rather than losing them", async () => {
    const f = await fixture();
    await f.t.run((ctx) =>
      ctx.db.insert("plannedVisits", {
        generationKey: "second",
        planId: f.ids.plan,
        planVersion: 1,
        planSlotId: f.ids.slot,
        assigneeProfileId: f.ids.person,
        outletId: f.ids.outlet,
        serviceDate: f.day,
        status: "planned",
        approvedSnapshot: f.ids.snapshot,
        requiredObjectives: [],
        intents: [],
        expectedDurationMinutes: 15,
        generatedAt: Date.now(),
      }),
    );
    const first = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
      limit: 1,
    });
    await f.t.run((ctx) =>
      ctx.db.insert("plannedVisits", {
        generationKey: "late",
        planId: f.ids.plan,
        planVersion: 1,
        planSlotId: f.ids.slot,
        assigneeProfileId: f.ids.person,
        outletId: f.ids.outlet,
        serviceDate: f.day,
        status: "planned",
        approvedSnapshot: f.ids.snapshot,
        requiredObjectives: [],
        intents: [],
        expectedDurationMinutes: 15,
        generatedAt: Date.now(),
      }),
    );
    await expect(
      f.caller.query(internal.mobile.bootstrap.snapshot, {
        actor: f.actor,
        pageCursor: first.nextPageCursor!,
        limit: 1,
      }),
    ).rejects.toThrow("rebootstrap_required");
    const fresh = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
    });
    await f.t.run((ctx) => ctx.db.patch(f.ids.visit, { intents: ["audit"] }));
    await expect(
      f.caller.query(internal.mobile.pull.delta, {
        actor: f.actor,
        cursor: fresh.syncCursor!,
      }),
    ).rejects.toThrow("rebootstrap_required");
  });
});
