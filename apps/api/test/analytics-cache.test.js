import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness } from "./harness.js";
import { analyticsFixture } from "./analytics-fixture.js";
import {
  rebuildSalesCache,
  salesSource,
} from "../src/domains/analytics/read-model.js";

/** @type {import('./harness.js').Harness} */ let h;
/** @type {any} */ let f;
beforeAll(async () => {
  h = await startHarness({ installers: [] });
  f = await analyticsFixture(h);
  await rebuildSalesCache(h.db, f.start, f.today);
});
afterAll(async () => {
  await h?.close();
});
const source = () => salesSource(h.db, { from: f.start, to: f.today }, {});

test("F-025 sales-cache validation detects a same-count missing and extra line identity", async () => {
  expect(await source()).toBe("tiles");
  const [row] =
    await h.db`select line_id from analytics_sales_cache order by line_id limit 1`;
  const replacement = crypto.randomUUID();
  await h.db`update analytics_sales_cache set line_id=${replacement} where line_id=${row.line_id}`;
  try {
    expect(await source()).toBe("analytics_sales_facts");
  } finally {
    await h.db`update analytics_sales_cache set line_id=${row.line_id} where line_id=${replacement}`;
  }
  expect(await source()).toBe("tiles");
});

test("F-025 sales-cache validation compares exact version tuples, not counts or version sums", async () => {
  const [a, b] =
    await h.db`select line_id,source_line_seq from analytics_sales_cache order by line_id limit 2`;
  expect(a.source_line_seq).not.toBe(b.source_line_seq);
  await h.db`update analytics_sales_cache set source_line_seq=case when line_id=${a.line_id} then ${b.source_line_seq}::bigint else ${a.source_line_seq}::bigint end where line_id in (${a.line_id},${b.line_id})`;
  try {
    expect(await source()).toBe("analytics_sales_facts");
  } finally {
    await h.db`update analytics_sales_cache set source_line_seq=case when line_id=${a.line_id} then ${a.source_line_seq}::bigint else ${b.source_line_seq}::bigint end where line_id in (${a.line_id},${b.line_id})`;
  }
  expect(await source()).toBe("tiles");
});

test("F-025 restoring original source facts still invalidates the cached revision", async () => {
  const [row] =
    await h.db`select c.order_id,o.status from analytics_sales_cache c join orders o on o.id=c.order_id order by c.line_id limit 1`;
  const temporary =
    row.status === "pending_approval" ? "approved" : "pending_approval";
  await h.db`update orders set status=${temporary} where id=${row.order_id}`;
  await h.db`update orders set status=${row.status} where id=${row.order_id}`;
  expect(await source()).toBe("analytics_sales_facts");
  await rebuildSalesCache(h.db, f.start, f.today);
  expect(await source()).toBe("tiles");
});
