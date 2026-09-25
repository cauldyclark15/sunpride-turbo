import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../schema";
import { modules } from "../test.setup";
import {
  consumeUploadClaim,
  matchesChecksum,
  verifyStoredEvidence,
} from "./evidence";

const now = Date.parse("2026-09-28T04:00:00Z");
type T = TestConvex<typeof schema>;

describe("stored evidence checksum", () => {
  it("compares Convex base64 SHA-256 metadata against canonical hex and rejects mismatches", () => {
    const base64 = "VcZND81vnV98goCThX4/39poR4u06b0k1IHvORx4BOg=";
    const hex =
      "55c64d0fcd6f9d5f7c828093857e3fdfda68478bb4e9bd24d481ef391c7804e8";
    expect(matchesChecksum(base64, hex)).toBe(true);
    expect(matchesChecksum(base64, "a".repeat(64))).toBe(false);
    expect(matchesChecksum("garbage", hex)).toBe(false);
  });
  it("isolates storage metadata validation from claim mutations", async () => {
    const storageId = "storage-id" as Parameters<
      typeof verifyStoredEvidence
    >[1];
    const metadata = {
      sha256: "VcZND81vnV98goCThX4/39poR4u06b0k1IHvORx4BOg=",
      contentType: "image/jpeg",
      size: 5,
    };
    const storage = {
      getMetadata: async () => metadata,
    } as unknown as Parameters<typeof verifyStoredEvidence>[0];
    const hex =
      "55c64d0fcd6f9d5f7c828093857e3fdfda68478bb4e9bd24d481ef391c7804e8";
    await expect(
      verifyStoredEvidence(storage, storageId, 5, "image/jpeg", hex),
    ).resolves.toBeUndefined();
    await expect(
      verifyStoredEvidence(storage, storageId, 6, "image/jpeg", hex),
    ).rejects.toThrow();
  });
});

describe("durable upload claim", () => {
  async function fixture() {
    const t: T = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const unit = await ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code: "SUNPRIDE",
        name: "National",
        typeCode: "NATIONAL",
        status: "active",
        effectiveFrom: now - 10000,
        createdAt: now,
        updatedAt: now,
      });
      const person = (name: string) =>
        ctx.db.insert("profiles", {
          authSubject: `https://auth.test|${name}`,
          name,
          email: `${name}@test.local`,
          role: "sales",
          status: "active",
          orgUnitId: unit,
          updatedAt: now,
        });
      const profileId = await person("sales"),
        otherId = await person("other");
      const outletId = await ctx.db.insert("outlets", {
        organizationId: "sunpride",
        code: "O",
        name: "Outlet",
        status: "active",
        custodianOrgUnitId: unit,
        createdAt: now,
        updatedAt: now,
        createdBy: "fixture",
      });
      const visitId = await ctx.db.insert("visitExecutions", {
        organizationId: "sunpride",
        clientVisitId: "visit",
        assigneeProfileId: profileId,
        outletId,
        orgUnitId: unit,
        serviceDate: "2026-09-28",
        source: "unplanned",
        intents: [],
        state: "checked-in",
        productivity: "pending",
        createdAt: now,
        lastServerTime: now,
        checkedInAt: now,
      });
      const storageId = await ctx.storage.store(new Blob(["photo"]));
      const claimId = await ctx.db.insert("evidenceUploadClaims", {
        organizationId: "sunpride",
        visitId,
        profileId,
        subject: "https://auth.test|sales",
        issuedAt: now,
        expiresAt: now + 60000,
      });
      return { profileId, otherId, visitId, storageId, claimId };
    });
    const args = {
      claimId: ids.claimId,
      visitId: ids.visitId,
      profileId: ids.profileId,
      subject: "https://auth.test|sales",
      storageId: ids.storageId,
      now,
    };
    const indexed = await t.run(async (ctx) => ({
      owner: await ctx.db
        .query("evidenceUploadClaims")
        .withIndex("by_visitId_and_profileId", (q) =>
          q.eq("visitId", ids.visitId).eq("profileId", ids.profileId),
        )
        .collect(),
      expiry: await ctx.db
        .query("evidenceUploadClaims")
        .withIndex("by_expiresAt", (q) => q.lte("expiresAt", now + 60000))
        .collect(),
    }));
    expect(indexed.owner).toHaveLength(1);
    expect(indexed.expiry).toHaveLength(1);
    return { t, ids, args };
  }
  it("rejects absent claim, expired claim, another person and a mismatched visit without a write", async () => {
    const f = await fixture();
    await expect(
      f.t.run((ctx) =>
        consumeUploadClaim(ctx, {
          ...f.args,
          claimId: f.ids.visitId as unknown as typeof f.ids.claimId,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      f.t.run((ctx) =>
        consumeUploadClaim(ctx, { ...f.args, now: now + 60000 }),
      ),
    ).rejects.toThrow();
    await expect(
      f.t.run((ctx) =>
        consumeUploadClaim(ctx, { ...f.args, profileId: f.ids.otherId }),
      ),
    ).rejects.toThrow();
    await expect(
      f.t.run((ctx) =>
        consumeUploadClaim(ctx, {
          ...f.args,
          subject: "https://auth.test|other",
        }),
      ),
    ).rejects.toThrow();
    await expect(
      f.t.run((ctx) =>
        consumeUploadClaim(ctx, {
          ...f.args,
          visitId: f.ids.claimId as unknown as typeof f.ids.visitId,
        }),
      ),
    ).rejects.toThrow();
    expect(
      (await f.t.run((ctx) => ctx.db.get(f.ids.claimId)))?.consumedAt,
    ).toBeUndefined();
  });
  it("consumes once, stores storage ID, refuses reuse of claim or storage ID", async () => {
    const f = await fixture();
    await f.t.run((ctx) => consumeUploadClaim(ctx, f.args));
    expect((await f.t.run((ctx) => ctx.db.get(f.ids.claimId)))?.storageId).toBe(
      f.ids.storageId,
    );
    await expect(
      f.t.run((ctx) => consumeUploadClaim(ctx, f.args)),
    ).rejects.toThrow();
    const second = await f.t.run((ctx) =>
      ctx.db.insert("evidenceUploadClaims", {
        organizationId: "sunpride",
        visitId: f.ids.visitId,
        profileId: f.ids.profileId,
        subject: f.args.subject,
        issuedAt: now,
        expiresAt: now + 60000,
      }),
    );
    await expect(
      f.t.run((ctx) => consumeUploadClaim(ctx, { ...f.args, claimId: second })),
    ).rejects.toThrow();
    expect(
      (await f.t.run((ctx) => ctx.db.get(second)))?.consumedAt,
    ).toBeUndefined();
  });
});
