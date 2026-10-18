import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tx } from "@sunpride/db/client";
import { registerTopic } from "../src/core/hooks.js";
import { publish } from "../src/core/realtime.js";
import { createUser, profileStore, startHarness } from "./harness.js";

/** @type {import('./harness.js').Harness} */
let h;
/** @type {ReturnType<typeof profileStore>} */
let profiles;

beforeAll(async () => {
  h = await startHarness({ listen: true });
  profiles = profileStore(h);
  registerTopic("issues", (actor) => actor.capabilities.has("issues.read"));
  registerTopic("admin", (actor) => actor.capabilities.has("admin.manage"));
});
afterAll(async () => {
  await h?.close();
});

/** @param {string} cookie */
function openWs(cookie) {
  const url = h.origin.replace("http", "ws") + "/ws";
  const ws = new WebSocket(
    url,
    /** @type {any} */ ({ headers: cookie ? { cookie } : {} }),
  );
  /** @type {any[]} */
  const inbox = [];
  /** @type {Array<() => void>} */
  const waiters = [];
  ws.addEventListener("message", (e) => {
    inbox.push(JSON.parse(String(e.data)));
    for (const w of waiters.splice(0)) w();
  });
  return {
    ws,
    inbox,
    opened: new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(undefined));
      ws.addEventListener("error", () => reject(new Error("ws error")));
      ws.addEventListener("close", (e) =>
        reject(new Error(`closed ${e.code}`)),
      );
    }),
    /** @param {(m: any) => boolean} pred @param {number} [ms] */
    async next(pred, ms = 3000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const i = inbox.findIndex(pred);
        if (i >= 0) return inbox.splice(i, 1)[0];
        const left = deadline - Date.now();
        if (left <= 0) return null;
        await Promise.race([
          new Promise((r) => waiters.push(() => r(undefined))),
          Bun.sleep(left),
        ]);
      }
    },
  };
}

/** @param {string} role */
async function signedInCookie(role) {
  const email = `ws${crypto.randomUUID().slice(0, 8)}@example.com`;
  const userId = await createUser(h, email, "ws password 1");
  profiles.set(userId, { role });
  const res = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "ws password 1" }),
  });
  const m = /sp_session=([^;]*)/.exec(res.headers.get("set-cookie") ?? "");
  return `sp_session=${m?.[1]}`;
}

describe("realtime /ws", () => {
  test("subscribe, unauthorized topic refused, publish after commit arrives as invalidate", async () => {
    const cookie = await signedInCookie("sales");
    const c = openWs(cookie);
    await c.opened;
    c.ws.send(
      JSON.stringify({
        type: "subscribe",
        topics: ["issues", "issue:142", "admin", "Bad Topic!"],
      }),
    );
    const sub = await c.next((m) => m.type === "subscribed");
    expect(sub.topics).toEqual(["issues"]);
    expect(
      await c.next((m) => m.type === "error" && m.topic === "admin"),
    ).toEqual({ type: "error", code: "forbidden", topic: "admin" });
    expect(
      await c.next((m) => m.type === "error" && m.topic === "issue:142"),
    ).toEqual({ type: "error", code: "forbidden", topic: "issue:142" });
    expect(
      (await c.next((m) => m.type === "error" && m.code === "invalid_topic"))
        ?.topic,
    ).toBe("Bad Topic!");

    // NOTIFY inside a transaction is held until COMMIT.
    let commit = () => {};
    const gate = new Promise((r) => (commit = () => r(undefined)));
    const done = tx(h.db, async (t) => {
      await publish(t, "issues");
      await gate;
    });
    expect(await c.next((m) => m.type === "invalidate", 300)).toBeNull();
    commit();
    await done;
    const inv = await c.next((m) => m.type === "invalidate");
    expect(inv).toMatchObject({ type: "invalidate", topic: "issues" });
    expect(Number.isSafeInteger(inv.seq)).toBe(true);

    // Rolled-back publish never arrives; topics not subscribed never arrive.
    await tx(h.db, async (t) => {
      await publish(t, "issues");
      throw new Error("rollback");
    }).catch(() => {});
    await publish(h.db, "admin");
    expect(await c.next((m) => m.type === "invalidate", 300)).toBeNull();

    await publish(h.db, "issues");
    const inv2 = await c.next((m) => m.type === "invalidate");
    expect(inv2.seq).toBeGreaterThan(inv.seq);
    c.ws.close();
  });

  test("admin may subscribe to the admin topic", async () => {
    const c = openWs(await signedInCookie("admin"));
    await c.opened;
    c.ws.send(JSON.stringify({ type: "subscribe", topics: ["admin"] }));
    expect((await c.next((m) => m.type === "subscribed"))?.topics).toEqual([
      "admin",
    ]);
    c.ws.close();
  });

  test("unauthenticated upgrade is refused", async () => {
    const res = await h.fetch("/ws", {
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    expect(res.status).toBe(401);
    const c = openWs("");
    await expect(c.opened).rejects.toThrow();
  });
});
