import { test, expect, mock } from "bun:test";
import { startHarness } from "./harness.js";
import { analyticsFixture } from "./analytics-fixture.js";
import { assertHeader } from "./analytics-schema.js";
import { rebuildSalesCache } from "../src/domains/analytics/read-model.js";
mock.module("../src/domains/visits/productive.js", () => ({
  isProductive: (/** @type {any} */ f) => ({
    productive: f.activityKinds.includes("merchandising"),
    reason: "test",
  }),
}));
const { install } = await import("../src/domains/analytics/index.js");
test("90 days / 300 stores / 12 agents: measured HTTP p95 below 300 ms", async () => {
  const h = await startHarness({ installers: [install] });
  try {
    const f = await analyticsFixture(h, 90);
    await rebuildSalesCache(h.db, f.start, f.today);
    await h.db`analyze`;
    const [{ orders }] = await h.db`select count(*) as orders from orders`;
    expect(Number(orders)).toBe(27000);
    const [{ stores }] = await h.db`select count(*) as stores from outlets`;
    expect(Number(stores)).toBe(300);
    const [{ agents }] =
      await h.db`select count(*) as agents from profiles where role='sales'`;
    expect(Number(agents)).toBe(12);
    const results = [];
    const paths = {
      sales: `sales?from=${f.start}&to=${f.today}&groupBy=agent`,
      today: `today?date=${f.today}`,
      coverage: `coverage?from=${f.start}&to=${f.today}`,
      stores: `stores?from=${f.start}&to=${f.today}`,
      store: `store?storeId=${f.store}&from=${f.start}&to=${f.today}`,
      stock: `stock?from=${f.start}&to=${f.today}`,
      vans: `vans?from=${f.start}&to=${f.today}`,
      money: `money?from=${f.start}&to=${f.today}`,
      exceptions: `exceptions?from=${f.start}&to=${f.today}`,
      agentDay: `agent-day?profileId=${f.agent}&date=${f.today}`,
    };
    for (const [name, path] of Object.entries(paths)) {
      const times = [];
      for (let i = 0; i < 21; i++) {
        const start = performance.now(),
          res = await f.get("/api/v1/analytics/" + path),
          body = await res.json();
        expect(res.status, JSON.stringify(body)).toBe(200);
        assertHeader(body);
        if (i) times.push(performance.now() - start);
      }
      times.sort((a, b) => a - b);
      const p95 = times[Math.ceil(times.length * 0.95) - 1];
      const result = {
        endpoint: name,
        samples: times.length,
        p95Ms: Math.round(p95 * 100) / 100,
        maxMs: Math.round(times[times.length - 1] * 100) / 100,
      };
      results.push(result);
      console.log("ANALYTICS_ENDPOINT_PERFORMANCE", JSON.stringify(result));
    }
    console.log(
      "ANALYTICS_PERFORMANCE",
      JSON.stringify({
        orders: Number(orders),
        stores: Number(stores),
        agents: Number(agents),
        days: 90,
        results,
      }),
    );
    for (const row of results)
      expect(row.p95Ms, `${row.endpoint} p95`).toBeLessThan(300);
  } finally {
    await h.close();
  }
}, 240000);
