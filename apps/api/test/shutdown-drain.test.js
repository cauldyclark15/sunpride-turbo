import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness } from "./harness.js";

// Rolling releases: SIGTERM must let a save that is already running finish (the client got
// "Something went wrong" when a release cut the API off mid-request), while refusing new work.

/** @type {import('./harness.js').Harness} */
let h;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});

test("stop() drains in-flight requests, then refuses new connections", async () => {
  let started = 0;
  h.app.router.post("/api/test/slow-save", async () => {
    started++;
    await Bun.sleep(700);
    return { saved: true };
  });
  const inFlight = h.fetch("/api/test/slow-save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  for (let i = 0; i < 100 && !started; i++) await Bun.sleep(10);
  expect(started).toBe(1);
  const t0 = Date.now();
  await h.app.stop({ drainMs: 5_000 });
  const res = await inFlight;
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ saved: true });
  // returned as soon as the request finished, not after the whole drain budget
  expect(Date.now() - t0).toBeLessThan(3_000);
  // a new connection is refused (server.js then exits, closing kept-alive sockets)
  const after = await h
    .fetch("/healthz", { keepalive: false, headers: { connection: "close" } })
    .catch(() => null);
  expect(after).toBeNull();
});
