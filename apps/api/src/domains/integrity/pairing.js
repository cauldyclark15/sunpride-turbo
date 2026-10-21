import { tx } from "@sunpride/db/client";
import { verifySignature } from "../../core/devices.js";
import { forbidden, invalid } from "../../core/errors.js";
import { takeOrThrow } from "../../core/rate.js";
import { sha256Hex } from "../../core/util.js";
import { currentActor } from "../van/access.js";
import { audit } from "./governance.js";

/** F-007: only the signed-in candidate install can request its own replacement code.
 * @param {any} router */
export function installPairing(router) {
  router.post(
    "/api/v1/integrity/devices/pairing/start",
    async (/** @type {any} */ c) => {
      if (
        c.via !== "access" ||
        !c.session?.deviceKeyId ||
        !["field-android", "van-android"].includes(c.session.app)
      )
        throw forbidden();
      await takeOrThrow(c.db, `pairing-start:${c.session.id}`, {
        limit: 5,
        windowMs: 300_000,
      });
      const b = c.body,
        spki = b.publicKeySpki,
        key = c.session.deviceKeyId;
      if (
        typeof spki !== "string" ||
        spki.length > 512 ||
        Buffer.from(spki, "base64").toString("base64") !== spki ||
        sha256Hex(Buffer.from(spki, "base64")) !== key ||
        !Number.isSafeInteger(b.timestamp) ||
        Math.abs(Date.now() - b.timestamp) > 60_000 ||
        !(await verifySignature(
          spki,
          b.signature,
          `PAIR|${c.session.app}|${key}|${b.timestamp}`,
        ))
      )
        throw invalid("Use this phone's current sign-in to pair it");
      return tx(c.db, async (db) => {
        const actor = await currentActor(db, c.actor);
        await db`select pg_advisory_xact_lock(hashtext(${`pairing:${actor.profileId}:${key}`}))`;
        await db`update device_pairing_requests set consumed_at=now() where profile_id=${actor.profileId} and key_id=${key} and consumed_at is null`;
        // 40 random bits, short-lived, hashed at rest; redemption additionally requires a scoped admin.
        const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        const bytes = crypto.getRandomValues(new Uint8Array(8));
        const raw = Array.from(bytes, (n) => alphabet[n % 32]).join("");
        const code = `SP-${raw.slice(0, 4)}-${raw.slice(4)}`;
        const [r] =
          await db`insert into device_pairing_requests(profile_id,app,key_id,public_key_spki,code_hash,expires_at) values(${actor.profileId},${c.session.app},${key},${spki},${sha256Hex(code)},now()+interval '10 minutes') returning id,expires_at`;
        await audit(
          { ...c, db, actor },
          "device.replacement_code_requested",
          r.id,
          { app: c.session.app },
        );
        return { code, expiresAt: new Date(r.expires_at).getTime() };
      });
    },
  );
}

/** F-007: caller must lock and scope the OLD device before consuming the candidate.
 * This runs inside the existing handover transaction, so a refusal does not burn the code.
 * @param {any} c @param {any} device @param {string} code */
export async function consumePairing(c, device, code) {
  if (
    typeof code !== "string" ||
    !/^SP-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(code)
  )
    throw invalid("Enter the replacement phone's current code");
  const [r] =
    await c.db`select * from device_pairing_requests where code_hash=${sha256Hex(code)} and expires_at>now() and consumed_at is null for update`;
  if (
    !r ||
    r.profile_id !== device.profile_id ||
    r.app !== device.app ||
    r.key_id === device.key_id
  )
    throw invalid(
      "Code expired, belongs to another person/app, or is not a replacement phone",
    );
  await c.db`update device_pairing_requests set consumed_at=now() where id=${r.id}`;
  return { publicKeySpki: r.public_key_spki, app: r.app };
}
