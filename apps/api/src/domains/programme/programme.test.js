import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startHarness } from "../../../test/harness.js";
import { sha256Hex } from "../../core/util.js";
import { install } from "./index.js";
import { seedProgramme } from "../../../../../packages/db/seed/programme.js";
import data from "../../../../../packages/db/seed/spec-features.json" with { type: "json" };

/** @type {import('../../../test/harness.js').Harness} */ let h;
/** @type {Record<string,string>} */ const cookies = {};

beforeAll(async () => {
  h = await startHarness({ installers: [install], listen: true });
  h.setHooks({
    loadProfile: async (db, userId) => {
      const [p] = await db`select * from profiles where user_id=${userId}`;
      return p
        ? {
            id: p.id,
            userId: p.user_id,
            name: p.name,
            role: p.role,
            status: p.status,
            orgUnitId: p.org_unit_id,
          }
        : null;
    },
  });
  for (const role of ["super_admin", "admin", "manager", "analyst", "viewer"]) {
    const email = `${role}@programme.example.test`;
    const [u] =
      await h.db`insert into users (email,password_hash) values (${email},'fixture-only') returning id`;
    await h.db`insert into profiles (user_id,name,email,role,status) values (${u.id},${role},${email},${role},'active')`;
    const token = `sps_${crypto.randomUUID()}`;
    await h.db`insert into sessions (user_id,token_hash,app,expires_at) values (${u.id},${sha256Hex(token)},'web',now()+interval '1 hour')`;
    cookies[role] = `sp_session=${token}`;
  }
});
afterAll(async () => {
  await h?.close();
});

/** @param {string} role */
async function read(role) {
  const res = await h.fetch("/api/v1/programme/overview", {
    headers: { cookie: cookies[role] },
  });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}

describe("F-025 programme traceability", () => {
  test("F-025 an empty table reads as not loaded, not as zero features", async () => {
    const { status, body } = await read("admin");
    expect(status).toBe(200);
    expect(body.loaded).toBe(false);
    expect(body.featureCount).toBe(0);
  });

  test("F-025 seed loads all 146 features and 8 waves, and a repeat changes nothing", async () => {
    const first = await seedProgramme(h.db);
    expect(first).toEqual({ waves: 8, features: 146, changed: 154 });
    const again = await seedProgramme(h.db);
    expect(again.changed).toBe(0);
    const [n] = await h.db`select count(*)::int as n from spec_features`;
    expect(n.n).toBe(146);
  });

  test("F-025 a changed status in the file updates only that row", async () => {
    const copy = structuredClone(data);
    const f = copy.features.find((x) => x.id === "F-103");
    if (!f) throw new Error("fixture");
    f.status = "partly_built";
    expect((await seedProgramme(h.db, copy)).changed).toBe(1);
    expect((await seedProgramme(h.db)).changed).toBe(1);
  });

  test("F-025 seed refuses an unknown status before writing", async () => {
    const copy = structuredClone(data);
    copy.features[0].status = "done";
    await expect(seedProgramme(h.db, copy)).rejects.toThrow("Unknown status");
  });

  test("F-025 overview groups waves → blocks → features with plain status and deck exit criteria", async () => {
    const { status, body } = await read("super_admin");
    expect(status).toBe(200);
    expect(body.loaded).toBe(true);
    expect(body.waves.map((/** @type {any} */ w) => w.code)).toEqual([
      "W0",
      "W1",
      "W2",
      "W3",
      "W4",
      "W5",
      "W6",
      "TR-R",
    ]);
    expect(body.totals).toEqual({
      built: 3,
      partly_built: 88,
      changing_to_spec: 22,
      not_built: 21,
      needs_sunpride: 4,
      conditional: 8,
    });
    const w0 = body.waves[0];
    expect(w0.goNoGoOwner).toBe("CIO and VP Sales");
    expect(w0.exitCriteria).toHaveLength(5);
    expect(w0.featureCount).toBe(25);
    const sum = body.waves.reduce(
      (/** @type {number} */ n, /** @type {any} */ w) =>
        n +
        w.blocks.reduce(
          (/** @type {number} */ m, /** @type {any} */ b) =>
            m + b.features.length,
          0,
        ),
      0,
    );
    expect(sum).toBe(146);
    const f001 = w0.blocks
      .find((/** @type {any} */ b) => b.id === "BB-01")
      .features.find((/** @type {any} */ f) => f.id === "F-001");
    expect(f001.statusLabel).toBe("Partly built");
    expect(f001.laneWhen).toContain("Wave A");
    const pool = body.waves.flatMap((/** @type {any} */ w) =>
      w.blocks.flatMap((/** @type {any} */ b) =>
        b.features.filter((/** @type {any} */ f) => f.deferralPool),
      ),
    );
    expect(pool).toHaveLength(19);
  });

  test("F-025 integrated owner facts distinguish working mock paths from remaining acceptance", async () => {
    const { body } = await read("super_admin");
    const features = body.waves.flatMap((/** @type {any} */ w) =>
      w.blocks.flatMap((/** @type {any} */ b) => b.features),
    );
    const byId = new Map(features.map((/** @type {any} */ f) => [f.id, f]));
    expect(byId.get("F-002").now).toContain("one SAP gateway");
    expect(byId.get("F-003").now).toContain("durable identities");
    expect(byId.get("F-005").now).toContain("Integration screen");
    expect(byId.get("F-403").now).toContain("distributor portal");
    expect(byId.get("F-505").now).toContain("One claim object");
    expect(byId.get("F-407").next).toContain("Android");
    expect(byId.get("F-511").next).toContain("FISCAL-owned");
    for (const id of [
      "F-001",
      "F-002",
      "F-106",
      "F-107",
      "F-407",
      "F-504",
      "F-505",
    ])
      expect(byId.get(id).status).toBe("partly_built");
  });

  test("F-025 only administrators and the owner may read the programme", async () => {
    expect((await read("admin")).status).toBe(200);
    for (const role of ["manager", "analyst", "viewer"])
      expect((await read(role)).status).toBe(403);
    const res = await h.fetch("/api/v1/programme/overview");
    expect(res.status).toBe(401);
  });
});
