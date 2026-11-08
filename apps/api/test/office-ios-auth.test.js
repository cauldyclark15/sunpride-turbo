import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createUser,
  deviceKey,
  nativeSignIn,
  profileStore,
  startHarness,
} from "./harness.js";

/**
 * SP-0165: the native Office app (`office-ios`) signs in like a native app (session + short
 * access token, refresh) but is treated exactly like a web session for the same user:
 * web-shaped `/api/me` with the same capabilities, the same office reads, and no handheld
 * registration — device-only operations still refuse it.
 */

/** @type {import('./harness.js').Harness} */
let h;
/** @type {ReturnType<typeof profileStore>} */
let profiles;
const PASSWORD = "office-ios-test-pw";

const { install: installInventory } = await import("../src/domains/inventory/index.js");
const { install: installStorepos } = await import("../src/domains/storepos/index.js");
const { install: installVan } = await import("../src/domains/van/index.js");
const { install: installDecide } = await import("../src/domains/decide/index.js");

beforeAll(async () => {
  h = await startHarness({
    installers: [installInventory, installVan, installStorepos, installDecide],
  });
  profiles = profileStore(h);
});
afterAll(async () => {
  await h?.close();
});

/** @param {string} path @param {unknown} body @param {Record<string,string>} [headers] */
const post = (path, body, headers = {}) =>
  h.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

/** @param {Response} res */
const cookieOf = (res) => {
  const m = /sp_session=([^;]*)/.exec(res.headers.get("set-cookie") ?? "");
  return m ? `sp_session=${m[1]}` : "";
};

/** @param {string} role */
async function person(role) {
  const email = `office-${role}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const userId = await createUser(h, email, PASSWORD);
  profiles.set(userId, { role, name: `Office ${role}` });
  const web = await post("/api/auth/sign-in", { email, password: PASSWORD });
  expect(web.status).toBe(200);
  return { email, userId, cookie: cookieOf(web) };
}

describe("office-ios native sign-in", () => {
  test("issues a session + access token and refreshes like other native apps", async () => {
    const p = await person("manager");
    const { res, body } = await nativeSignIn(h, p.email, PASSWORD, "office-ios");
    expect(res.status).toBe(200);
    expect(body.sessionToken).toMatch(/^sps_/);
    expect(body.accessToken).toMatch(/^spa_/);
    const [row] =
      await h.db`select app, device_key_id from sessions where user_id=${p.userId} and app='office-ios'`;
    expect(row).toEqual({ app: "office-ios", device_key_id: null });
    const refreshed = await post(
      "/api/auth/refresh",
      { version: 2, app: "office-ios" },
      { authorization: `Bearer ${body.sessionToken}` },
    );
    expect(refreshed.status).toBe(200);
    expect((await refreshed.json()).accessToken).toMatch(/^spa_/);
    // A session of the office app cannot be refreshed as another app.
    const wrong = await post(
      "/api/auth/refresh",
      { version: 2, app: "field-ios" },
      { authorization: `Bearer ${body.sessionToken}` },
    );
    expect(wrong.status).toBe(401);
  });

  test("refuses a device key: the office app never registers a handheld", async () => {
    const p = await person("manager");
    const key = await deviceKey();
    const { res } = await nativeSignIn(h, p.email, PASSWORD, "office-ios", {
      keyId: key.keyId,
      publicKeySpki: key.publicKeySpki,
    });
    expect(res.status).toBe(400);
    const devices = await h.db`select 1 from registered_devices where app='office-ios'`;
    expect(devices.length).toBe(0);
  });

  test("/api/me answers the web shape with the same capabilities as the web session", async () => {
    for (const role of ["manager", "viewer", "admin"]) {
      const p = await person(role);
      const { body } = await nativeSignIn(h, p.email, PASSWORD, "office-ios");
      const viaBearer = await h.fetch("/api/me", {
        headers: { authorization: `Bearer ${body.accessToken}` },
      });
      const viaCookie = await h.fetch("/api/me", {
        headers: { cookie: p.cookie },
      });
      expect(viaBearer.status).toBe(200);
      const a = await viaBearer.json();
      const b = await viaCookie.json();
      expect(a).toEqual(b);
      expect(a.version).toBeUndefined();
      expect(Array.isArray(a.capabilities)).toBe(true);
      expect(a.capabilities.length).toBeGreaterThan(0);
    }
  });

  test("office reads answer the bearer exactly as the web session (same status and body)", async () => {
    const p = await person("manager");
    const { body } = await nativeSignIn(h, p.email, PASSWORD, "office-ios");
    for (const path of [
      "/api/v1/decide/inbox",
      "/api/v1/inventory/locations",
      "/api/v1/inventory/counts/mine",
      "/api/v1/storepos/workspace",
    ]) {
      const a = await h.fetch(path, {
        headers: { authorization: `Bearer ${body.accessToken}` },
      });
      const b = await h.fetch(path, { headers: { cookie: p.cookie } });
      expect([path, a.status]).toEqual([path, b.status]);
      if (!path.includes("storepos")) expect([path, a.status]).toEqual([path, 200]);
      const strip = (/** @type {any} */ j) => {
        if (j && typeof j === "object") {
          delete j.asOf;
          delete j.serverTime;
        }
        return j;
      };
      const ja = strip(await a.json());
      const jb = strip(await b.json());
      expect(ja).toEqual(jb);
    }
  });

  test("capabilities stay role-bound: a viewer cannot act in Decide through the office app", async () => {
    const p = await person("viewer");
    const { body } = await nativeSignIn(h, p.email, PASSWORD, "office-ios");
    const auth = { authorization: `Bearer ${body.accessToken}` };
    const act = { id: "x", verdict: "approve", reason: "", idempotencyKey: crypto.randomUUID() };
    const a = await post("/api/v1/decide/act", act, auth);
    const b = await post("/api/v1/decide/act", act, { cookie: p.cookie });
    expect(a.status).toBe(b.status);
    expect(a.status).toBeGreaterThanOrEqual(400);
    // The refusal carries the server's own words, exactly as the web session gets them.
    expect(await a.json()).toEqual(await b.json());
  });

  test("device-only operations still refuse the office app", async () => {
    const p = await person("sales");
    const { body } = await nativeSignIn(h, p.email, PASSWORD, "office-ios");
    const auth = {
      authorization: `Bearer ${body.accessToken}`,
      "x-app": "office-ios",
    };
    const register = await post(
      "/api/v1/devices/register",
      { app: "office-ios", platform: "ios" },
      auth,
    );
    expect(register.status).toBeGreaterThanOrEqual(400);
    const sync = await post("/mobile/v1/sync/push", { version: 1, ops: [] }, auth);
    expect(sync.status).toBeGreaterThanOrEqual(400);
    const bootstrap = await h.fetch("/mobile/v1/bootstrap", { headers: auth });
    expect(bootstrap.status).toBeGreaterThanOrEqual(400);
  });

  test("native field apps keep the v2 error envelope", async () => {
    const p = await person("manager");
    const { body } = await nativeSignIn(h, p.email, PASSWORD, "field-ios");
    const res = await post(
      "/api/v1/decide/act",
      { id: "x", verdict: "maybe", idempotencyKey: crypto.randomUUID() },
      { authorization: `Bearer ${body.accessToken}` },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    const j = await res.json();
    expect(j.version).toBe(2);
  });

  test("an unknown app is still refused", async () => {
    const p = await person("manager");
    const { res } = await nativeSignIn(h, p.email, PASSWORD, "office-android");
    expect(res.status).toBe(400);
  });
});
