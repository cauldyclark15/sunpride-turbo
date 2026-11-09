#!/usr/bin/env bun
// Approve an emulator's phone for a test user in a LANE database only.
//
//   DATABASE_URL="$(cat ~/.sunpride-keys/pg-lane-<lane>-url)" \
//     bun scripts/lane-approve-device.js --email agent@sunpride.test [--app field-android|van-android] [--as admin@sunpride.test]
//
// First sign the emulator in, so it shows "Register phone", and tap "Get code" under "Replacing another phone?"
// (that records the phone's public key server-side). Pass `--key <base64 SPKI>` instead to use the
// "Show full code" text. Then this script runs the office's own domain functions as the admin:
//   - person has no phone yet  -> org `registerDevice`
//   - person already has one   -> integrity `requestHandover` + `completeHandover` (old phone recorded as lost)
// Refuses any database whose name does not start with `sunpride_lane_`. Prints no secrets or keys.
import { createDb, tx } from "../packages/db/src/client.js";
import { actorFor } from "../apps/api/src/core/context.js";
import { setHooks } from "../apps/api/src/core/hooks.js";
import { identityHooks } from "../apps/api/src/domains/org/identity.js";
import { registerDevice } from "../apps/api/src/domains/org/devices.js";
import {
  completeHandover,
  requestHandover,
} from "../apps/api/src/domains/integrity/governance.js";

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {Record<string,string>} */ const out = {
    app: "field-android",
    as: "admin@sunpride.test",
  };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, "");
    if (
      !k ||
      !["email", "app", "as", "key", "tag"].includes(k) ||
      argv[i + 1] === undefined
    )
      throw new Error(`Unknown or empty argument: ${argv[i]}`);
    out[k] = argv[i + 1];
  }
  if (!out.email) throw new Error("--email is required");
  if (!["field-android", "van-android"].includes(out.app))
    throw new Error("--app must be field-android or van-android");
  return out;
}

/** @param {string|undefined} url */
export function laneDbName(url) {
  if (!url?.trim()) throw new Error("DATABASE_URL is required");
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  if (!name.startsWith("sunpride_lane_"))
    throw new Error("Refusing: DATABASE_URL is not a sunpride_lane_* database");
  return name;
}

/** @param {any} db @param {Record<string,string>} a */
export async function approve(db, a) {
  // Same profile loader the API server installs (core/hooks defaults to "no profile").
  setHooks(identityHooks({}));
  return tx(db, async (/** @type {any} */ t) => {
    const [admin] =
      await t`select id from users where lower(email)=lower(${a.as})`;
    const actor = admin && (await actorFor(t, admin.id));
    if (!actor) throw new Error(`No active office account ${a.as}`);
    const [person] =
      await t`select p.id from profiles p join users u on u.id=p.user_id where lower(u.email)=lower(${a.email})`;
    if (!person) throw new Error(`No person ${a.email}`);
    const c = { db: t, actor, user: { id: admin.id }, publish: async () => {} };
    let spki = a.key;
    if (!spki) {
      const [req] =
        await t`select id,public_key_spki from device_pairing_requests where profile_id=${person.id} and app=${a.app} and consumed_at is null order by created_at desc limit 1`;
      if (!req)
        throw new Error(
          "No phone code yet: on the emulator tap Get code under 'Replacing another phone?', or pass --key",
        );
      spki = req.public_key_spki;
      await t`update device_pairing_requests set consumed_at=now() where id=${req.id}`;
    }
    const keyId = new Bun.CryptoHasher("sha256")
      .update(Buffer.from(spki, "base64"))
      .digest("hex");
    const [same] =
      await t`select id,status from registered_devices where profile_id=${person.id} and key_id=${keyId} and app=${a.app}`;
    if (same?.status === "active")
      return { result: "already_active", deviceId: same.id };
    const tag = a.tag ?? `LANE-EMU-${keyId.slice(0, 8)}`;
    const [old] =
      await t`select id from registered_devices where profile_id=${person.id} and status<>'revoked' order by created_at desc limit 1`;
    const [anyRow] =
      await t`select id from registered_devices where profile_id=${person.id} limit 1`;
    if (!anyRow) {
      const r = await registerDevice(c, {
        profileId: person.id,
        app: a.app,
        inventoryTag: tag,
        publicKeySpki: spki,
      });
      return { result: "registered", deviceId: r.deviceId };
    }
    const from =
      old ??
      (
        await t`select id from registered_devices where profile_id=${person.id} order by created_at desc limit 1`
      )[0];
    const h = await requestHandover({
      ...c,
      body: {
        deviceId: from.id,
        app: a.app,
        publicKeySpki: spki,
        inventoryTag: tag,
        reasonCode: "replacement",
      },
    });
    const done = await completeHandover({
      ...c,
      body: {
        handoverId: h.handoverId,
        reconciliation: "lost_phone_work_unrecoverable",
      },
    });
    return { result: "handed_over", deviceId: done.deviceId };
  });
}

if (import.meta.main) {
  let db;
  try {
    const args = parseArgs(process.argv.slice(2));
    const name = laneDbName(process.env.DATABASE_URL);
    db = createDb(/** @type {string} */ (process.env.DATABASE_URL), { max: 1 });
    const out = await approve(db, args);
    process.stdout.write(
      `${JSON.stringify({ db: name, email: args.email, app: args.app, ...out })}\n`,
    );
  } catch (e) {
    // Never echo driver errors verbatim: they can carry the connection string.
    const msg =
      e instanceof Error && !/postgres(ql)?:\/\//.test(e.message)
        ? e.message
        : "failed";
    process.stderr.write(`${JSON.stringify({ error: msg })}\n`);
    process.exitCode = 1;
  } finally {
    await db?.close();
  }
}
