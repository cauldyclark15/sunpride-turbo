#!/usr/bin/env bun
// SP-0209 proof for the Google Play reviewer created by create-play-reviewer.js.
//
//   Rehearsal (restored scratch DB named sp209_rehearsal only; starts the API on port 0):
//     DATABASE_URL=<scratch> SP0209_RECORD=<file> bun apps/api/scripts/create-play-reviewer-proof.js
//   Live (talks to the public site; read-only DB use; no sales, orders, stock or plans):
//     DATABASE_URL=<live> bun apps/api/scripts/create-play-reviewer-proof.js --live
//
// Field app (field-android) native sign-in with a FRESH P-256 key: the phone must register itself (no office
// approval), bind, and the start-of-day download must carry exactly the 4 TEST stores and no real store or person.
// Website: the reviewer's Customers (outlets/list) and People lists must hold no real customer/profile.
// Then the proof phone is revoked (by Test User 1, a TEST super admin) and every proof session is signed out.
// Passwords come from the private records and are never printed.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createDb } from "@sunpride/db/client";
import { manilaDate } from "../src/domains/fieldsync/model.js";
import { deviceKey, nativeSignIn, bind, signedPost } from "../test/harness.js";

const LIVE = process.argv.includes("--live");
const url = process.env.DATABASE_URL;
if (!url || (!LIVE && !/\/sp209_rehearsal(\?|$)/.test(url))) {
  console.error(
    "Rehearsal needs the sp209_rehearsal scratch database; live needs --live",
  );
  process.exit(2);
}
const recordPath =
  process.env.SP0209_RECORD ??
  join(homedir(), ".sunpride-keys/play-reviewer.json");
const db = createDb(url, { max: 5 });
let server = null;
let base = "https://sunpride.cauldnclark.com";
if (!LIVE) {
  const { createApp } = await import("../src/core/app.js");
  const app = createApp({
    db,
    dbUrl: url,
    env: {
      ...process.env,
      SYNC_CURSOR_SECRET: "sp0209-scratch-cursor-secret-0123456789abcdef",
      FILES_DIR: `${process.env.TMPDIR}/sp0209-files`,
    },
  });
  server = await app.start({ port: 0, hostname: "127.0.0.1", schedule: false });
  base = `http://127.0.0.1:${server.port}`;
}
const h = { db, fetch: (p, i) => fetch(`${base}${p}`, i) };
const out = { mode: LIVE ? "live" : "rehearsal", checks: [], cleanup: [] };
const check = (name, ok, detail) => {
  out.checks.push({
    name,
    ok: Boolean(ok),
    ...(detail === undefined ? {} : { detail }),
  });
  if (!ok) throw new Error(`FAILED ${name}`);
};

const reviewer = JSON.parse(await readFile(recordPath, "utf8"));
const admins = JSON.parse(
  await readFile(
    join(homedir(), ".sunpride-keys/test-superadmins.json"),
    "utf8",
  ),
);
const test1 = Object.values(admins.databases)
  .flat()
  .find((a) => a.email === "test1@sp.test");
if (!test1) throw new Error("Test User 1 credential missing");
const [route] = await db`select id from routes where code='TEST-R1'`;
const testOutlets =
  await db`select id,code from outlets where code like 'TEST-S%' and deleted_at is null order by code`;
const testIds = new Set(testOutlets.map((o) => o.id));
const testPeople = new Set(
  (
    await db`select p.id from profiles p join org_units u on u.id=p.org_unit_id where u.code='BR-TEST'`
  ).map((r) => r.id),
);
const [flags] =
  await db`select u.must_change_password,u.temp_password_expires_at,u.disabled_at,p.role,p.app_mode,p.phone_auto_approve
  from users u join profiles p on p.user_id=u.id where lower(u.email)=${reviewer.email}`;

async function web(email, password) {
  const r = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email, password }),
  });
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  const call = async (method, path, body) => {
    const res = await h.fetch(path, {
      method,
      headers: {
        cookie,
        origin: base,
        ...(body
          ? {
              "content-type": "application/json",
              "idempotency-key": crypto.randomUUID(),
            }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {}
    return { status: res.status, body: json };
  };
  return {
    status: r.status,
    cookie,
    call,
    signOut: () => call("POST", "/api/auth/sign-out", {}),
  };
}

async function download(who) {
  const params = {
    dayFrom: manilaDate(Date.now()),
    includeWorkforce: true,
    schemeEngine: 1,
  };
  const outlets = [];
  let first = null,
    page = null;
  for (let i = 0; i < 20; i++) {
    const r = await signedPost(h, who, "/api/sync/pull", {
      version: 2,
      app: "field-android",
      deviceId: who.deviceId,
      since: null,
      pageCursor: page,
      limit: 100,
      scopes: [
        { scopeId: who.me.scope.id, projection: "field.bundle", params },
      ],
    });
    if (r.res.status !== 200)
      return {
        status: r.res.status,
        code: r.body?.error?.code ?? r.body?.code,
        body: JSON.stringify(r.body).slice(0, 300),
      };
    const b = r.body.bundles[0];
    first ??= b;
    outlets.push(...b.data.outlets);
    page = r.body.nextPageCursor;
    if (!page) break;
  }
  return { status: 200, bundle: first, outlets };
}

const sessions = [];
let phone = null;
try {
  check(
    "password never forces a change and never expires",
    flags &&
      !flags.must_change_password &&
      !flags.temp_password_expires_at &&
      !flags.disabled_at,
    {
      role: flags?.role,
      appMode: flags?.app_mode,
      phoneAutoApprove: flags?.phone_auto_approve,
    },
  );
  check(
    "role sales, app mode mapping, phone auto-approve on",
    flags.role === "sales" &&
      flags.app_mode === "mapping" &&
      flags.phone_auto_approve === true,
  );

  // ---- Field app on a fresh phone -------------------------------------------------------------------
  const key = await deviceKey();
  const r = await nativeSignIn(
    h,
    reviewer.email,
    reviewer.password,
    "field-android",
    {
      keyId: key.keyId,
      publicKeySpki: key.publicKeySpki,
    },
  );
  check(
    "Field native sign-in (fresh phone)",
    r.res.status === 200,
    r.res.status,
  );
  const access = r.body.accessToken;
  const get = async (path, keyId) => {
    const res = await h.fetch(path, {
      headers: {
        authorization: `Bearer ${access}`,
        "x-app": "field-android",
        ...(keyId ? { "x-device-key-id": keyId } : {}),
      },
    });
    return { status: res.status, body: await res.json() };
  };
  const me1 = (await get("/api/me", key.keyId)).body;
  check(
    "phone registered itself (no office approval, no handover)",
    me1.device?.status === "active" && me1.handoverRequired === false,
    {
      device: me1.device?.status,
      handover: me1.handoverRequired,
      appMode: me1.profile?.appMode ?? me1.profile?.app_mode,
    },
  );
  phone = { key, access, deviceId: me1.device.id };
  const b = await bind(h, access, phone.deviceId, key);
  check("phone bound", b.body.bindingStatus === "bound", b.body.bindingStatus);
  phone.me = (await get("/api/me")).body;
  const day = await download(phone);
  check(
    "day download 200",
    day.status === 200,
    day.status === 200 ? undefined : day,
  );
  const ids = day.outlets.map((o) => o.id);
  check(
    "download = exactly the 4 TEST stores, no real store",
    ids.length === testOutlets.length && ids.every((id) => testIds.has(id)),
    {
      stores: ids.length,
      test: ids.filter((id) => testIds.has(id)).length,
      real: ids.filter((id) => !testIds.has(id)).length,
    },
  );
  // Every UUID anywhere in the download, matched against all profiles and outlets in the database.
  const uuids = [
    ...new Set(
      JSON.stringify(day.bundle.data).match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      ) ?? [],
    ),
  ];
  const arr = db.array(uuids.length ? uuids : ["-"], "TEXT");
  const realPeople = (
    await db`select id from profiles where id::text=any(${arr}::text[]) or user_id::text=any(${arr}::text[])`
  ).filter((p) => !testPeople.has(p.id));
  check("download names no real person", realPeople.length === 0, {
    uuids: uuids.length,
    realPeople: realPeople.length,
  });
  const realOutlets = (
    await db`select id from outlets where id::text=any(${arr}::text[])`
  ).filter((o) => !testIds.has(o.id));
  check(
    "download references no real store anywhere",
    realOutlets.length === 0,
    { realStores: realOutlets.length },
  );
  out.bundleKeys = Object.keys(day.bundle.data).sort();
  out.employee = { role: day.bundle.data.employee?.role };

  // ---- Website lists as the reviewer --------------------------------------------------------------------
  const w = await web(reviewer.email, reviewer.password);
  sessions.push(w);
  out.webSignIn = w.status;
  if (w.status === 200) {
    const ol = await w.call("GET", "/api/v1/outlets/list?limit=50");
    const rows =
      ol.body?.items ??
      ol.body?.rows ??
      ol.body?.outlets ??
      ol.body?.page ??
      [];
    out.outletListKeys = Object.keys(ol.body ?? {});
    check(
      "web Customers list = TEST stores only",
      ol.status === 200 &&
        rows.length > 0 &&
        rows.every((o) => testIds.has(o.id)),
      {
        status: ol.status,
        rows: rows.length,
        real: rows.filter((o) => !testIds.has(o.id)).length,
      },
    );
    const pl = await w.call("GET", "/api/v1/people/list?limit=50");
    const prow = pl.body?.items ?? pl.body?.rows ?? pl.body?.people ?? [];
    check(
      "web People list has no real person",
      pl.status !== 200 ||
        prow.every((p) => testPeople.has(p.id ?? p.profileId)),
      {
        status: pl.status,
        rows: prow.length,
        real: prow.filter((p) => !testPeople.has(p.id ?? p.profileId)).length,
      },
    );
  }
} catch (e) {
  out.error = String(e?.message ?? e).slice(0, 500);
} finally {
  // Revoke the proof phone (Test User 1, TEST super admin) and sign every proof session out.
  if (phone?.deviceId) {
    const admin = await web(test1.email, test1.password);
    const rv = await admin.call("POST", "/api/v1/people/devices/revoke", {
      deviceId: phone.deviceId,
      reason: "decommissioned",
    });
    out.cleanup.push({ deviceRevoked: rv.status === 200 });
    const so = await admin.signOut();
    out.cleanup.push({ adminSignedOut: so.status === 200 });
  }
  if (phone?.access) {
    const so = await h.fetch("/api/auth/sign-out", {
      method: "POST",
      headers: {
        authorization: `Bearer ${phone.access}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    out.cleanup.push({ phoneSignedOut: so.status === 200 });
  }
  for (const w of sessions) {
    const r = await w.signOut().catch(() => ({ status: 0 }));
    out.cleanup.push({ webSignedOut: r.status === 200 });
  }
  const [rest] =
    await db`select (select count(*)::int from sessions s join users u on u.id=s.user_id where lower(u.email)=${reviewer.email} and s.revoked_at is null and s.expires_at>now()) as open,
      (select count(*)::int from registered_devices d join profiles p on p.id=d.profile_id where lower(p.email)=${reviewer.email} and d.status='active') as active`.catch(
      (e) => [{ error: String(e.message).slice(0, 120) }],
    );
  out.after = rest;
  if (server) server.stop(true);
}
out.ok =
  !out.error &&
  out.checks.every((c) => c.ok) &&
  out.cleanup.every((c) => Object.values(c).every(Boolean));
console.log(JSON.stringify(out, null, 1));
await db.close();
process.exit(out.ok ? 0 : 1);
