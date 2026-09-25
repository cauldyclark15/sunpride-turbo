import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";

describe("profile ensure recovery audit", () => {
  it("audits verified-email subject rebind and disabled-profile reactivation, but not ordinary ensure", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
    const root = t.withIdentity({
      subject: "root",
      email: "jcing.jc@gmail.com",
    });
    await root.mutation(api.domains.profiles.ensure, {});
    await root.mutation(api.domains.profiles.invite, {
      email: "rebind@example.test",
      role: "viewer",
    });
    const old = t.withIdentity({
      subject: "old",
      email: "rebind@example.test",
    });
    const id = await old.mutation(api.domains.profiles.ensure, {});
    const replacement = t.withIdentity({
      subject: "new",
      email: "rebind@example.test",
    });
    await replacement.mutation(api.domains.profiles.ensure, {});
    await t.run((ctx) => ctx.db.patch(id, { status: "disabled" }));
    await replacement.mutation(api.domains.profiles.ensure, {});
    await replacement.mutation(api.domains.profiles.ensure, {});
    const audits = await t.run((ctx) =>
      ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) =>
          q.eq("entityType", "profile").eq("entityId", id),
        )
        .take(20),
    );
    const recovery = audits.filter(
      (row) => row.action === "profile.reactivated_or_rebound",
    );
    expect(recovery).toHaveLength(2);
    expect(
      recovery.map((row) => JSON.parse(row.details ?? "{}").reason),
    ).toEqual(["verified email subject rebind", "invitation reactivation"]);
    expect(recovery.every((row) => !!row.subject)).toBe(true);
  });
});
