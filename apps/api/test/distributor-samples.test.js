import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { startHarness } from "./harness.js";
import { seedDemo } from "../../../packages/db/seed/index.js";
import { seedDistributors } from "../../../packages/db/seed/distributors.js";
import { install as org } from "../src/domains/org/index.js";
import { install as orders } from "../src/domains/orders/index.js";
import { install as distributors } from "../src/domains/distributors/index.js";
import { today } from "../src/domains/distributors/model.js";
/** @type {import('./harness.js').Harness} */ let h;
/** @type {Record<string,any>} */ let accounts;
let credentialsPath = "";
beforeAll(async () => {
  h = await startHarness({ installers: [org, orders, distributors] });
  await seedDemo(h.db, { days: 7 });
  credentialsPath = join(h.filesDir, "portal-logins.json");
  const first = await seedDistributors(h.db, { credentialsPath });
  expect(first.distributors).toBe(2);
  expect(first.added).toBeGreaterThan(1000);
  const before = await readFile(credentialsPath, "utf8");
  expect((await seedDistributors(h.db, { credentialsPath })).added).toBe(0);
  expect(await readFile(credentialsPath, "utf8")).toBe(before);
  const [{ name }] = await h.db`select current_database() as name`;
  accounts = JSON.parse(before)[name];
}, 180000);
afterAll(async () => {
  if (h) await h.close();
}, 180000);
/** @param {any} account */
async function login(account) {
  const response = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}
/** @param {string} cookie @param {string} path @param {any} [body] */
async function api(cookie, path, body) {
  const response = await h.fetch("/api/v1/distributors" + path, {
    method: body ? "POST" : "GET",
    headers: { cookie, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: response.status,
    body: /** @type {any} */ (await response.json()),
  };
}

test("F-401 F-402 sample portal credentials are 0600 and both authenticate with isolated real workspaces", async () => {
  expect((await stat(credentialsPath)).mode & 0o777).toBe(0o600);
  for (const account of Object.values(accounts)) {
    const cookie = await login(account),
      list = await api(cookie, "");
    expect(list.body.rows).toHaveLength(1);
    const id = list.body.rows[0].id,
      w = await api(cookie, `/workspace?distributorId=${id}`);
    expect(w.status).toBe(200);
    expect(w.body.catalog).toHaveLength(3);
    expect(w.body.outlets).toHaveLength(8);
    expect(typeof w.body.policy).toBe("object");
    const docs = await api(cookie, `/documents?distributorId=${id}`);
    expect(docs.status).toBe(200);
    expect(docs.body.rows.length).toBeGreaterThan(1);
    const doc = docs.body.rows.find(
      (/** @type {any} */ d) => d.kind === "circular",
    );
    const pdf = await h.fetch(
      `/api/v1/distributors/documents/${doc.id}?distributorId=${id}`,
      { headers: { cookie } },
    );
    expect(pdf.status).toBe(200);
    expect(await pdf.text()).toContain("%PDF-1.4");
  }
});
test("F-402 sample JSON columns are objects, not doubly encoded strings; active replicas survive reruns", async () => {
  const rows =
    await h.db`select jsonb_typeof(payload) as kind from distributor_master_versions where effective_to is null`;
  expect(rows).toHaveLength(2);
  expect(rows.every((/** @type {any} */ r) => r.kind === "object")).toBe(true);
  const policies =
    await h.db`select jsonb_typeof(settings) as kind from distributor_policies`;
  expect(policies.every((/** @type {any} */ r) => r.kind === "object")).toBe(
    true,
  );
});
test("F-403 F-410 sample schemes apply only against dedicated distributor price lists", async () => {
  const account = accounts.harbour,
    cookie = await login(account),
    id = (await api(cookie, "")).body.rows[0].id;
  const w = (await api(cookie, `/workspace?distributorId=${id}`)).body;
  const q = await api(cookie, "/quote", {
    distributorId: id,
    requestKey: crypto.randomUUID(),
    lines: [{ productId: w.catalog[0].productId, quantity: 1 }],
  });
  expect(q.status).toBe(200);
  expect(q.body.canConfirm).toBe(true);
  expect(q.body.totalCentavos).toBe(22800);
  expect(q.body.schemes[0].applied).toBe(true);
  const promotions =
    await h.db`select p.price_list_id,l.channel_key from promotions p join price_lists l on l.id=p.price_list_id where p.code like 'SAMPLE-PARTNER-%'`;
  expect(promotions).toHaveLength(2);
  expect(
    promotions.every((/** @type {any} */ p) => p.channel_key === "distributor"),
  ).toBe(true);
});
test("F-411 F-416 samples provide 56-day offtake, stock DOI and a real variance counterexample", async () => {
  for (const [slug, account] of Object.entries(accounts)) {
    const cookie = await login(account),
      id = (await api(cookie, "")).body.rows[0].id;
    const health = await api(cookie, `/stock-health?distributorId=${id}`);
    expect(health.status).toBe(200);
    expect(health.body.offtakeComplete).toBe(true);
    expect(health.body.completeOfftakeDays).toBe(28);
    expect(
      health.body.rows.every((/** @type {any} */ r) => r.daysOfInventory > 0),
    ).toBe(true);
    const recon = await api(
      cookie,
      `/reconciliation?distributorId=${id}&from=${today()}&to=${today()}`,
    );
    expect(recon.status).toBe(200);
    expect(
      recon.body.rows.every(
        (/** @type {any} */ r) =>
          r.status === (slug === "harbour" ? "balanced" : "exception"),
      ),
    ).toBe(true);
  }
});
