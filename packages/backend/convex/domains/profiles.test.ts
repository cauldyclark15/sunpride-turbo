import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";

describe("legacy profile mutation funnels", () => {
  it("setRole and repeat invite preserve assignment history; bootstrap role is immutable", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
    const root = t.withIdentity({
      subject: "root",
      email: "jcing.jc@gmail.com",
    });
    await root.mutation(api.domains.profiles.ensure, {});
    await t.mutation(internal.migrations.seedOrganizationFoundation, {});
    await root.mutation(api.domains.profiles.invite, {
      email: "user@example.test",
      role: "viewer",
    });
    const user = t.withIdentity({
      subject: "user",
      email: "user@example.test",
    });
    await user.mutation(api.domains.profiles.ensure, {});
    const id = (await user.query(api.domains.profiles.current, {}))!._id;
    await root.mutation(api.domains.profiles.setRole, {
      profileId: id,
      role: "sales",
    });
    await root.mutation(api.domains.profiles.invite, {
      email: "user@example.test",
      role: "viewer",
    });
    expect((await user.query(api.domains.profiles.current, {}))?.role).toBe(
      "viewer",
    );
    expect(
      (await root.query(api.people.queries.history, { profileId: id })).map(
        (row) => row.role,
      ),
    ).toEqual(["viewer", "sales", "viewer"]);
    const rootId = (await root.query(api.domains.profiles.current, {}))!._id;
    await expect(
      root.mutation(api.domains.profiles.setRole, {
        profileId: rootId,
        role: "viewer",
      }),
    ).rejects.toThrow(/super admin/);
  });
});
