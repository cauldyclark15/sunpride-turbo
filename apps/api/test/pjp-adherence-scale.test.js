import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness } from "./harness.js";
import { seedDemo } from "../../../packages/db/seed/index.js";
import { readAdherence } from "../src/domains/coverage/adherence.js";

/** @type {any} */ let h;
beforeAll(async () => {
  h = await startHarness();
  await seedDemo(h.db, { anchorDate: "2026-10-20", days: 90 });
  // The fixture administrator is at the national root. Preserve its real subtree
  // semantics at the harness's org-hook boundary; no domain rows are mocked.
  h.setHooks({
    scopeUnitIds: async (/** @type {any} */ db) =>
      (await db`select id from org_units where deleted_at is null`).map(
        (/** @type {any} */ r) => r.id,
      ),
    unitInScope: async () => true,
  });
}, 180000);
afterAll(async () => {
  if (h) await h.close();
}, 30000);

test("F-206 national 300-store review includes the complete current and prior windows", async () => {
  const [p] =
    await h.db`select * from profiles where role in ('admin','super_admin') and status='active' and deleted_at is null order by id limit 1`;
  const result = await readAdherence(
    {
      db: h.db,
      now: Date.parse("2026-10-20T04:00:00Z"),
      actor: {
        userId: p.user_id,
        profileId: p.id,
        role: p.role,
        orgUnitId: p.org_unit_id,
        capabilities: new Set(),
      },
    },
    {},
  );
  expect(result.summary.planned + result.prior.planned).toBeGreaterThan(10000);
  expect(result.frequency).toHaveLength(725); // rep/outlet pairs, not distinct stores
  expect(new Set(result.frequency.map((r) => r.outletId)).size).toBe(300);
  expect(result.weeks).toHaveLength(4);
  expect(result.summary.actual).toBeGreaterThan(0);
  expect(result.prior.actual).toBeGreaterThan(0);
  expect(result.rows.reduce((n, r) => n + r.planned, 0)).toBe(
    result.summary.planned,
  );
  expect(result.rows.reduce((n, r) => n + r.actual, 0)).toBe(
    result.summary.actual,
  );
}, 120000);
