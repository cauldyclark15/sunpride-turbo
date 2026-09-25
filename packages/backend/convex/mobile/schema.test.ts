import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../schema";
import { modules } from "../test.setup";

type Test = TestConvex<typeof schema>;
const org = "sunpride";
const actor = "https://identity.example|sales-1";
const time = 1_790_380_800_000;

async function seed(t: Test) {
  return t.run(async (ctx) => {
    const unit = await ctx.db.insert("orgUnits", {
      organizationId: org,
      code: "UNIT",
      name: "Unit",
      typeCode: "AREA",
      status: "active",
      effectiveFrom: time,
      createdAt: time,
      updatedAt: time,
    });
    const person = await ctx.db.insert("profiles", {
      authSubject: actor,
      name: "Rep",
      email: "rep@example.test",
      role: "sales",
      status: "active",
      orgUnitId: unit,
      updatedAt: time,
    });
    const outlet = await ctx.db.insert("outlets", {
      organizationId: org,
      code: "O1",
      name: "Outlet",
      status: "active",
      custodianOrgUnitId: unit,
      createdAt: time,
      updatedAt: time,
      createdBy: actor,
    });
    const customer = await ctx.db.insert("customers", {
      code: "C1",
      name: "Customer",
      channel: "store",
      territory: "unit",
      creditLimit: 0,
      active: true,
      updatedAt: time,
    });
    const device = await ctx.db.insert("registeredDevices", {
      organizationId: org,
      orgUnitId: unit,
      inventoryTag: "TAG-1",
      profileId: person,
      boundSubject: actor,
      allowedApp: "IOS",
      platform: "ios",
      model: "test",
      osVersion: "17",
      appVersion: "1",
      publicKey: "public-only",
      credentialId: "credential-1",
      registeredAt: time,
      status: "active",
    });
    const challenge = await ctx.db.insert("deviceChallenges", {
      organizationId: org,
      deviceId: device,
      nonce: "nonce-1",
      expiresAt: time + 1000,
      issuedAt: time,
    });
    const visit = await ctx.db.insert("visitExecutions", {
      organizationId: org,
      clientVisitId: "018f5800-1234-7000-8000-000000000001",
      assigneeProfileId: person,
      outletId: outlet,
      orgUnitId: unit,
      customerId: customer,
      serviceDate: "2026-09-26",
      source: "unplanned",
      intents: ["merchandise"],
      state: "checked-in",
      productivity: "pending",
      createdAt: time,
      lastServerTime: time,
      checkedInAt: time,
    });
    const task = await ctx.db.insert("fieldTasks", {
      organizationId: org,
      orgUnitId: unit,
      assigneeProfileId: person,
      outletId: outlet,
      visitId: visit,
      kind: "merchandising",
      required: true,
      effectiveFrom: time,
      status: "open",
      evidenceIds: [],
      createdAt: time,
    });
    const storageId = await ctx.storage.store(new Blob(["photo"]));
    const file = await ctx.db.insert("fieldEvidenceFiles", {
      organizationId: org,
      orgUnitId: unit,
      storageId,
      visitId: visit,
      taskId: task,
      ownerProfileId: person,
      outletId: outlet,
      mime: "image/jpeg",
      sizeBytes: 5,
      checksum: "sha256:sample",
      capturedAt: time,
      uploadedAt: time,
      status: "pending",
    });
    const activity = await ctx.db.insert("visitActivities", {
      organizationId: org,
      orgUnitId: unit,
      visitId: visit,
      assigneeProfileId: person,
      outletId: outlet,
      activity: { kind: "merchandising", displayCondition: "compliant" },
      evidenceIds: [file],
      deviceTime: time,
      serverTime: time,
    });
    const location = await ctx.db.insert("visitLocationEvidence", {
      organizationId: org,
      orgUnitId: unit,
      visitId: visit,
      event: "check_in",
      provider: "unknown",
      policyVersion: "policy-1",
      result: "unavailable",
      reviewStatus: "pending_review",
      deviceTime: time,
      serverTime: time,
      retentionDueAt: time + 10000,
    });
    const collection = await ctx.db.insert("fieldCollections", {
      organizationId: org,
      orgUnitId: unit,
      customerId: customer,
      outletId: outlet,
      visitId: visit,
      assigneeProfileId: person,
      amountMinor: 100n,
      currency: "PHP",
      method: "cash",
      reference: "intent-only",
      status: "pending_review",
      deviceTime: time,
      serverTime: time,
    });
    const event = await ctx.db.insert("executionEvents", {
      organizationId: org,
      orgUnitId: unit,
      entityType: "visit",
      entityId: visit,
      kind: "check_in",
      actorSubject: actor,
      actorRole: "sales",
      actorOrgUnitId: unit,
      deviceId: device,
      source: "mobile",
      operationKey: "018f5800-1234-7000-8000-000000000002",
      occurredAt: time,
      serverAt: time,
      summary: { after: "checked-in" },
      schemaVersion: 1,
    });
    const processed = await ctx.db.insert("processedMobileOperations", {
      organizationId: org,
      kind: "visit.checkIn",
      clientRequestId: "018f5800-1234-7000-8000-000000000002",
      profileId: person,
      deviceId: device,
      payloadHash: "sha256:payload",
      result: { entityId: visit, eventIds: [event], serverTime: time },
      serverAt: time,
    });
    const change = await ctx.db.insert("mobileChanges", {
      organizationId: org,
      orgUnitId: unit,
      sequence: 1,
      entity: "visit",
      entityId: visit,
      revision: 1,
      op: "upsert",
      ownerProfileId: person,
      ownerSubject: actor,
      serverAt: time,
      payloadVersion: 1,
    });
    const sync = await ctx.db.insert("mobileSyncState", {
      organizationId: org,
      orgUnitId: unit,
      deviceId: device,
      watermark: 1,
      scopeFingerprint: "scope-1",
      leaseIssuedAt: time,
      leaseExpiresAt: time + 10000,
      updatedAt: time,
    });
    return {
      unit,
      person,
      outlet,
      customer,
      device,
      challenge,
      visit,
      task,
      file,
      activity,
      location,
      collection,
      event,
      processed,
      change,
      sync,
    };
  });
}

describe("mobile additive schema", () => {
  it("inserts every new table and reads every declared index", async () => {
    const t = convexTest(schema, modules);
    const x = await seed(t);
    await t.run(async (ctx) => {
      const check = async (rows: { _id: string }[], expected: string) =>
        expect(rows.map((r) => r._id)).toContain(expected);
      await check(
        await ctx.db
          .query("registeredDevices")
          .withIndex("by_organizationId_and_inventoryTag", (q) =>
            q.eq("organizationId", org).eq("inventoryTag", "TAG-1"),
          )
          .collect(),
        x.device,
      );
      await check(
        await ctx.db
          .query("registeredDevices")
          .withIndex("by_profileId_and_status", (q) =>
            q.eq("profileId", x.person).eq("status", "active"),
          )
          .collect(),
        x.device,
      );
      await check(
        await ctx.db
          .query("registeredDevices")
          .withIndex("by_credentialId", (q) =>
            q.eq("credentialId", "credential-1"),
          )
          .collect(),
        x.device,
      );
      await check(
        await ctx.db
          .query("deviceChallenges")
          .withIndex("by_deviceId_and_nonce", (q) =>
            q.eq("deviceId", x.device).eq("nonce", "nonce-1"),
          )
          .collect(),
        x.challenge,
      );
      await check(
        await ctx.db
          .query("deviceChallenges")
          .withIndex("by_expiresAt", (q) => q.eq("expiresAt", time + 1000))
          .collect(),
        x.challenge,
      );
      await check(
        await ctx.db
          .query("visitExecutions")
          .withIndex(
            "by_organizationId_and_assigneeProfileId_and_serviceDate",
            (q) =>
              q
                .eq("organizationId", org)
                .eq("assigneeProfileId", x.person)
                .eq("serviceDate", "2026-09-26"),
          )
          .collect(),
        x.visit,
      );
      await check(
        await ctx.db
          .query("visitExecutions")
          .withIndex("by_plannedVisitId", (q) =>
            q.eq("plannedVisitId", undefined),
          )
          .collect(),
        x.visit,
      );
      await check(
        await ctx.db
          .query("visitExecutions")
          .withIndex("by_organizationId_and_clientVisitId", (q) =>
            q
              .eq("organizationId", org)
              .eq("clientVisitId", "018f5800-1234-7000-8000-000000000001"),
          )
          .collect(),
        x.visit,
      );
      await check(
        await ctx.db
          .query("visitActivities")
          .withIndex("by_visitId_and_serverTime", (q) =>
            q.eq("visitId", x.visit).eq("serverTime", time),
          )
          .collect(),
        x.activity,
      );
      await check(
        await ctx.db
          .query("visitLocationEvidence")
          .withIndex("by_visitId_and_serverTime", (q) =>
            q.eq("visitId", x.visit).eq("serverTime", time),
          )
          .collect(),
        x.location,
      );
      await check(
        await ctx.db
          .query("visitLocationEvidence")
          .withIndex("by_orgUnitId_and_reviewStatus_and_serverTime", (q) =>
            q
              .eq("orgUnitId", x.unit)
              .eq("reviewStatus", "pending_review")
              .eq("serverTime", time),
          )
          .collect(),
        x.location,
      );
      await check(
        await ctx.db
          .query("visitLocationEvidence")
          .withIndex("by_retentionDueAt", (q) =>
            q.eq("retentionDueAt", time + 10000),
          )
          .collect(),
        x.location,
      );
      await check(
        await ctx.db
          .query("fieldTasks")
          .withIndex("by_assigneeProfileId_and_effectiveFrom", (q) =>
            q.eq("assigneeProfileId", x.person).eq("effectiveFrom", time),
          )
          .collect(),
        x.task,
      );
      await check(
        await ctx.db
          .query("fieldTasks")
          .withIndex("by_visitId", (q) => q.eq("visitId", x.visit))
          .collect(),
        x.task,
      );
      await check(
        await ctx.db
          .query("fieldCollections")
          .withIndex("by_visitId_and_serverTime", (q) =>
            q.eq("visitId", x.visit).eq("serverTime", time),
          )
          .collect(),
        x.collection,
      );
      await check(
        await ctx.db
          .query("fieldCollections")
          .withIndex("by_customerId_and_serverTime", (q) =>
            q.eq("customerId", x.customer).eq("serverTime", time),
          )
          .collect(),
        x.collection,
      );
      await check(
        await ctx.db
          .query("fieldEvidenceFiles")
          .withIndex("by_visitId_and_uploadedAt", (q) =>
            q.eq("visitId", x.visit).eq("uploadedAt", time),
          )
          .collect(),
        x.file,
      );
      await check(
        await ctx.db
          .query("fieldEvidenceFiles")
          .withIndex("by_orgUnitId_and_uploadedAt", (q) =>
            q.eq("orgUnitId", x.unit).eq("uploadedAt", time),
          )
          .collect(),
        x.file,
      );
      await check(
        await ctx.db
          .query("executionEvents")
          .withIndex("by_entityType_and_entityId_and_serverAt", (q) =>
            q
              .eq("entityType", "visit")
              .eq("entityId", x.visit)
              .eq("serverAt", time),
          )
          .collect(),
        x.event,
      );
      await check(
        await ctx.db
          .query("executionEvents")
          .withIndex("by_orgUnitId_and_serverAt", (q) =>
            q.eq("orgUnitId", x.unit).eq("serverAt", time),
          )
          .collect(),
        x.event,
      );
      await check(
        await ctx.db
          .query("executionEvents")
          .withIndex("by_organizationId_and_serverAt", (q) =>
            q.eq("organizationId", org).eq("serverAt", time),
          )
          .collect(),
        x.event,
      );
      await check(
        await ctx.db
          .query("processedMobileOperations")
          .withIndex("by_organizationId_and_kind_and_clientRequestId", (q) =>
            q
              .eq("organizationId", org)
              .eq("kind", "visit.checkIn")
              .eq("clientRequestId", "018f5800-1234-7000-8000-000000000002"),
          )
          .collect(),
        x.processed,
      );
      await check(
        await ctx.db
          .query("mobileChanges")
          .withIndex("by_organizationId_and_sequence", (q) =>
            q.eq("organizationId", org).eq("sequence", 1),
          )
          .collect(),
        x.change,
      );
      await check(
        await ctx.db
          .query("mobileChanges")
          .withIndex("by_orgUnitId_and_sequence", (q) =>
            q.eq("orgUnitId", x.unit).eq("sequence", 1),
          )
          .collect(),
        x.change,
      );
      await check(
        await ctx.db
          .query("mobileSyncState")
          .withIndex("by_deviceId", (q) => q.eq("deviceId", x.device))
          .collect(),
        x.sync,
      );
      expect((await ctx.db.get(x.event))?.actorSubject).toBe(actor);
    });
  });
});
