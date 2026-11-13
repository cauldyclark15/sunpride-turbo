import { test, expect, mock } from "bun:test";
import { startHarness } from "./harness.js";
import { analyticsFixture } from "./analytics-fixture.js";
import { rebuildSalesCache } from "../src/domains/analytics/read-model.js";
mock.module("../src/domains/visits/productive.js", () => ({
  isProductive: (/** @type {any} */ f) => ({
    productive: f.activityKinds.includes("merchandising"),
    reason: "test",
  }),
}));
const { install } = await import("../src/domains/analytics/index.js");
const BURST = 64,
  ROUNDS = 3;
test(
  `${ROUNDS} bursts of ${BURST} concurrent analytics requests all answer 200 and the pool stays healthy`,
  async () => {
    const h = await startHarness({ installers: [install] });
    try {
      const f = await analyticsFixture(h, 14);
      await rebuildSalesCache(h.db, f.start, f.today);
      const paths = [
        `sales?from=${f.start}&to=${f.today}&groupBy=agent`,
        `today?date=${f.today}`,
        `coverage?from=${f.start}&to=${f.today}`,
        `stores?from=${f.start}&to=${f.today}`,
        `store?storeId=${f.store}&from=${f.start}&to=${f.today}`,
        `stock?from=${f.start}&to=${f.today}`,
        `vans?from=${f.start}&to=${f.today}`,
        `money?from=${f.start}&to=${f.today}`,
        `exceptions?from=${f.start}&to=${f.today}`,
        `agent-day?profileId=${f.agent}&date=${f.today}`,
      ];
      /** @type {Record<string, number>} */ const failures = {};
      let ok = 0;
      for (let r = 0; r < ROUNDS; r++) {
        const results = await Promise.all(
          Array.from({ length: BURST }, async (_, i) => {
            const path = paths[i % paths.length];
            try {
              const res = await Promise.race([
                f.get("/api/v1/analytics/" + path),
                Bun.sleep(20_000).then(() => null),
              ]);
              if (!res) return `timeout ${path.split("?")[0]}`;
              const body = await res.text();
              return res.status === 200
                ? null
                : `${res.status} ${path.split("?")[0]} ${body.slice(0, 120)}`;
            } catch (e) {
              return `throw ${String(e).slice(0, 120)}`;
            }
          }),
        );
        for (const x of results)
          if (x) failures[x] = (failures[x] ?? 0) + 1;
          else ok++;
      }
      // The pool must still answer after the bursts.
      const [{ one }] = await Promise.race([
        h.db`select 1 as one`,
        Bun.sleep(5_000).then(() => [{ one: "hung" }]),
      ]);
      console.log(
        "SQL_CONCURRENCY_STRESS",
        JSON.stringify({ requests: BURST * ROUNDS, ok, failures }),
      );
      expect(failures).toEqual({});
      expect(ok).toBe(BURST * ROUNDS);
      expect(one).toBe(1);
    } finally {
      await h.close();
    }
  },
  180_000,
);
