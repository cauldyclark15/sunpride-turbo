import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createDb } from "@sunpride/db/client";
import { migrate, MIGRATIONS_DIR } from "@sunpride/db/migrate";
import { createApp } from "../src/core/app.js";
import { resetHooks, setHooks } from "../src/core/hooks.js";
import { clearJobHandlers } from "../src/core/jobs.js";
import { clearSyncRegistry } from "../src/core/sync.js";

const FORBIDDEN_PORTS = new Set([3000, 4300, 4310]);
/** Lane name selects the lane database key file and test-db prefix (SP_LANE, default core). */
const LANE = (process.env.SP_LANE ?? "core").replace(/[^a-z0-9_]/g, "");
export const CURSOR_SECRET = "test-cursor-secret-0123456789abcdef-0123456789";

/** Base URL of the lane database (never printed). */
async function laneUrl() {
  return (
    await Bun.file(
      `${process.env.HOME}/.sunpride-keys/pg-lane-${LANE}-url`,
    ).text()
  ).trim();
}

/**
 * Throwaway database + migrated schema + API on a random free port.
 * @param {{ env?: Record<string,string|undefined>, installers?: any[], listen?: boolean }} [opts]
 */
export async function startHarness(opts = {}) {
  resetHooks();
  clearSyncRegistry();
  clearJobHandlers();
  const base = await laneUrl();
  const name = `sunpride_lane_${LANE}_t${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = createDb(base, { max: 1 });
  await admin.unsafe(`create database ${name}`);
  const u = new URL(base);
  u.pathname = `/${name}`;
  const dbUrl = u.toString();
  const db = createDb(dbUrl, { max: 10 });
  await migrate(db, MIGRATIONS_DIR);
  const filesDir = await mkdtemp(
    join(process.env.TMPDIR ?? "/tmp", "sp-core-files-"),
  );
  /** @type {Record<string, string|undefined>} */
  const env = {
    BOOTSTRAP_ADMIN_EMAILS: "boss@example.com",
    SYNC_CURSOR_SECRET: CURSOR_SECRET,
    FILES_DIR: filesDir,
    ...opts.env,
  };
  const app = createApp({
    db,
    dbUrl,
    env,
    installers: opts.installers ?? [],
    schedulerPollMs: 50,
  });
  const server = await app.start({
    port: 0,
    hostname: "127.0.0.1",
    listen: opts.listen ?? false,
    schedule: false,
  });
  if (FORBIDDEN_PORTS.has(server.port))
    throw new Error("harness picked a reserved port");
  const origin = `http://127.0.0.1:${server.port}`;

  return {
    db,
    dbUrl,
    app,
    env,
    origin,
    filesDir,
    setHooks,
    /** @param {string} path @param {RequestInit} [init] */
    fetch: (path, init) => fetch(`${origin}${path}`, init),
    async close() {
      await app.stop();
      await db.close();
      // F-025: clients are closed. Let PostgreSQL drain maintenance/parallel
      // workers without requiring the application to signal another role.
      // A leaked client still makes ordinary DROP fail rather than being hidden.
      await admin.unsafe(`drop database if exists ${name}`);
      await admin.close();
      await rm(filesDir, { recursive: true, force: true });
      resetHooks();
      clearSyncRegistry();
      clearJobHandlers();
    },
  };
}

/** @typedef {Awaited<ReturnType<typeof startHarness>>} Harness */

/**
 * In-memory profile store wired through the `loadProfile` hook.
 * @param {Harness} h
 */
export function profileStore(h) {
  /** @type {Map<string, any>} */
  const byUser = new Map();
  h.setHooks({
    loadProfile: async (_db, userId) => byUser.get(userId) ?? null,
  });
  return {
    byUser,
    /** @param {string} userId @param {{ role: string, orgUnitId?: string|null, status?: string, name?: string }} p */
    set(userId, p) {
      const existing = byUser.get(userId);
      const profile = {
        id: existing?.id ?? crypto.randomUUID(),
        userId,
        name: p.name ?? "Test Person",
        role: p.role,
        orgUnitId:
          p.orgUnitId === undefined ? crypto.randomUUID() : p.orgUnitId,
        status: p.status ?? "active",
      };
      byUser.set(userId, profile);
      return profile;
    },
  };
}

/** @param {Harness} h @param {string} email @param {string} password */
export async function createUser(h, email, password) {
  const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
  const [row] =
    await h.db`insert into users (email, password_hash) values (${email}, ${hash}) returning id`;
  return /** @type {string} */ (row.id);
}

/** @param {Harness} h @param {string} email @param {string} password @param {string} app @param {any} [deviceKey] */
export async function nativeSignIn(
  h,
  email,
  password,
  app = "field-android",
  deviceKey,
) {
  const res = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: 2,
      app,
      email,
      password,
      // F-024 explicit simulated OS assessment; production devices supply their own heuristics.
      integrity: { rooted: false, tampered: false, source: "TEST fixture" },
      ...(deviceKey ? { deviceKey } : {}),
    }),
  });
  return { res, body: /** @type {any} */ (await res.json()) };
}

/** P-256 key pair + helpers. */
export async function deviceKey() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const spki = new Uint8Array(
    await crypto.subtle.exportKey("spki", pair.publicKey),
  );
  const publicKeySpki = Buffer.from(spki).toString("base64");
  const keyId = new Bun.CryptoHasher("sha256").update(spki).digest("hex");
  return {
    pair,
    publicKeySpki,
    keyId,
    /** @param {string} message */
    async sign(message) {
      const sig = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        pair.privateKey,
        new TextEncoder().encode(message),
      );
      return Buffer.from(new Uint8Array(sig)).toString("base64");
    },
  };
}

/**
 * Insert an admin-registered device row.
 * @param {Harness} h @param {{ profileId: string, orgUnitId: string|null, app?: string, key: Awaited<ReturnType<typeof deviceKey>> }} d
 */
export async function registerDevice(h, d) {
  const app = d.app ?? "field-android";
  const platform = app === "field-ios" ? "ios" : "android";
  const [row] = await h.db`
    insert into registered_devices (profile_id, app, platform, inventory_tag, public_key_spki, key_id, org_unit_id)
    values (${d.profileId}, ${app}, ${platform}, ${`TAG-${crypto.randomUUID().slice(0, 8)}`}, ${d.key.publicKeySpki}, ${d.key.keyId}, ${d.orgUnitId})
    returning id`;
  return /** @type {string} */ (row.id);
}

/** @param {Harness} h @param {string} access @param {string} deviceId */
export async function challenge(h, access, deviceId) {
  const res = await h.fetch("/api/devices/challenge", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${access}`,
    },
    body: JSON.stringify({ version: 2, deviceId }),
  });
  return { res, body: /** @type {any} */ (await res.json()) };
}

/** @param {Harness} h @param {string} access @param {string} deviceId @param {Awaited<ReturnType<typeof deviceKey>>} key */
export async function bind(
  h,
  access,
  deviceId,
  key,
  credentialId = crypto.randomUUID(),
) {
  const { body: ch } = await challenge(h, access, deviceId);
  const timestamp = Date.now();
  const proof = await key.sign(
    `BIND|${deviceId}|${credentialId}|${ch.nonce}|${timestamp}`,
  );
  const res = await h.fetch("/api/devices/bind", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${access}`,
    },
    body: JSON.stringify({
      version: 2,
      deviceId,
      credentialId,
      attestation: { format: "test-unverified", keyId: null },
      nonce: ch.nonce,
      timestamp,
      proof,
    }),
  });
  return { res, body: /** @type {any} */ (await res.json()) };
}

/**
 * POST a device-signed request. Overrides let tests tamper with nonce/timestamp/body.
 * @param {Harness} h
 * @param {{ access: string, deviceId: string, key: Awaited<ReturnType<typeof deviceKey>> }} who
 * @param {string} path @param {unknown} body
 * @param {{ nonce?: string, timestamp?: number, signedBody?: string }} [over]
 */
export async function signedPost(h, who, path, body, over = {}) {
  const raw = JSON.stringify(body);
  const nonce =
    over.nonce ?? (await challenge(h, who.access, who.deviceId)).body.nonce;
  const timestamp = over.timestamp ?? Date.now();
  const digest = new Bun.CryptoHasher("sha256")
    .update(over.signedBody ?? raw)
    .digest("hex");
  const signature = await who.key.sign(
    `POST|${path}|${digest}|${nonce}|${timestamp}`,
  );
  const res = await h.fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${who.access}`,
      "x-device-id": who.deviceId,
      "x-device-nonce": nonce,
      "x-device-timestamp": String(timestamp),
      "x-device-signature": signature,
    },
    body: raw,
  });
  return { res, body: /** @type {any} */ (await res.json()), nonce };
}

/**
 * Full native fixture: user + active profile + bound device + access token.
 * @param {Harness} h @param {ReturnType<typeof profileStore>} profiles
 * @param {{ role?: string, app?: string, orgUnitId?: string|null }} [o]
 */
export async function boundDevice(h, profiles, o = {}) {
  const email = `p${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "correct horse battery";
  const userId = await createUser(h, email, password);
  const profile = profiles.set(userId, {
    role: o.role ?? "sales",
    orgUnitId: o.orgUnitId ?? crypto.randomUUID(),
  });
  const key = await deviceKey();
  const app = o.app ?? "field-android";
  const deviceId = await registerDevice(h, {
    profileId: profile.id,
    orgUnitId: profile.orgUnitId,
    app,
    key,
  });
  const { body: tokens } = await nativeSignIn(h, email, password, app, {
    keyId: key.keyId,
    publicKeySpki: key.publicKeySpki,
  });
  const access = tokens.accessToken;
  const b = await bind(h, access, deviceId, key);
  if (b.body.bindingStatus !== "bound")
    throw new Error(`bind failed: ${JSON.stringify(b.body)}`);
  return {
    userId,
    email,
    password,
    profile,
    key,
    deviceId,
    access,
    session: tokens.sessionToken,
    app,
  };
}
