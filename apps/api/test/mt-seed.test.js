import { beforeAll, afterAll, test, expect } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { startHarness } from "./harness.js";
import { install as org } from "../src/domains/org/index.js";
import { install as mt } from "../src/domains/mt/index.js";
import { seedDemo } from "../../../packages/db/seed/index.js";
import { seedModernTrade } from "../../../packages/db/seed/modern-trade.js";
import { createPortalAccounts } from "../../../packages/db/seed/portal-accounts.js";
/** @type {import('./harness.js').Harness} */ let h;
beforeAll(async () => {
  h = await startHarness({ installers: [org, mt] });
  await seedDemo(h.db, { days: 42 });
}, 120000);
afterAll(async () => {
  await h?.close();
});
test("F-306 F-307 F-309 sample seed is additive, marked and idempotent; negative return orders never become invoices", async () => {
  const [before] = await h.db`select count(*)::int n from orders`;
  const first = await seedModernTrade(h.db);
  expect(first.created).toBeGreaterThan(0);
  const repeat = await seedModernTrade(h.db);
  expect(repeat.created).toBe(0);
  expect((await h.db`select count(*)::int n from orders`)[0].n).toBe(before.n);
  expect(
    (
      await h.db`select count(*)::int n from mt_invoice_replicas where amount_centavos<0`
    )[0].n,
  ).toBe(0);
  expect(
    (
      await h.db`select count(*)::int n from sample_data_rows where batch='sunpride-mt-v1'`
    )[0].n,
  ).toBe(first.created);
  expect(
    (
      await h.db`select count(*)::int n from inbound_purchase_orders p join orders o on o.id=p.order_id`
    )[0].n,
  ).toBeGreaterThan(0);
});
test("F-611 sample external logins keep 0600 credentials out of employee profiles and authenticate two isolated chains", async () => {
  const recordPath = join(h.filesDir, "portal-private.json"),
    outPath = join(h.filesDir, "portal-handout.txt");
  expect(
    (await createPortalAccounts(h.db, { recordPath, outPath })).accounts,
  ).toBe(2);
  expect(
    (await createPortalAccounts(h.db, { recordPath, outPath })).accounts,
  ).toBe(2);
  expect((await stat(recordPath)).mode & 0o777).toBe(0o600);
  expect((await stat(outPath)).mode & 0o777).toBe(0o600);
  const record = await Bun.file(recordPath).json(),
    accounts = Object.values(record.databases).flat();
  const totals = [];
  for (const a of /** @type {any[]} */ (accounts)) {
    const r = await h.fetch("/api/auth/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: a.email, password: a.password }),
    });
    expect(r.status).toBe(200);
    const cookie = r.headers.get("set-cookie")?.split(";")[0] ?? "";
    const response = await h.fetch("/api/v1/portal/overview", {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    const body = /** @type {any} */ (await response.json());
    totals.push(body.invoices.length);
    expect(
      (
        await h.db`select count(*)::int n from profiles where user_id=${a.userId}`
      )[0].n,
    ).toBe(0);
  }
  expect(totals[0]).toBeGreaterThan(0);
  expect(totals[1]).toBeGreaterThan(0);
});
