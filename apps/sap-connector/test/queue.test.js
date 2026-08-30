import { afterEach, describe, expect, test } from "bun:test";
import { DurableQueue } from "../src/queue/sqlite.js";

let queue;
afterEach(() => queue?.close());

describe("durable queue", () => {
  test("deduplicates by integration event id", () => {
    queue = new DurableQueue(":memory:");
    queue.enqueue({
      id: "evt-1",
      direction: "inbound",
      eventType: "inventory.snapshot",
      payload: { value: 1 },
    });
    queue.enqueue({
      id: "evt-1",
      direction: "inbound",
      eventType: "inventory.snapshot",
      payload: { value: 2 },
    });
    expect(queue.due("inbound")).toHaveLength(1);
    expect(queue.due("inbound")[0].payload.value).toBe(1);
  });

  test("marks completed records and excludes them from due work", () => {
    queue = new DurableQueue(":memory:");
    queue.enqueue({
      id: "evt-2",
      direction: "outbound",
      eventType: "sales-order.submit",
      payload: {},
    });
    queue.complete("evt-2");
    expect(queue.due("outbound")).toHaveLength(0);
    expect(queue.stats().completed).toBe(1);
  });
});
