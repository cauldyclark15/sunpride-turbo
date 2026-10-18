import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness } from "./harness.js";

/** @type {import('./harness.js').Harness} */
let h;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});

test("src/server.js boots on PORT with DATABASE_URL and serves /healthz", async () => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  expect([3000, 4300, 4310]).not.toContain(port);
  const proc = Bun.spawn(["bun", "src/server.js"], {
    cwd: `${import.meta.dir}/..`,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: h.dbUrl,
      SYNC_CURSOR_SECRET: "x".repeat(40),
      FILES_DIR: h.filesDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    let body = null;
    for (let i = 0; i < 50 && !body; i++) {
      await Bun.sleep(100);
      body = await fetch(`http://127.0.0.1:${port}/healthz`)
        .then((r) => r.json())
        .catch(() => null);
    }
    expect(body).toEqual({ ok: true, db: true });
  } finally {
    proc.kill("SIGTERM");
    await proc.exited;
  }
});
