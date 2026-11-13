import { tx } from "@sunpride/db/client";
import { createAccess, createSession } from "../../core/auth.js";
import { verifySignature } from "../../core/devices.js";
import { forbidden, invalid } from "../../core/errors.js";
import { loadProfile } from "../../core/hooks.js";
import { takeOrThrow } from "../../core/rate.js";
import { registerSamplePhone } from "../../core/sample-devices.js";
import { randomToken, sha256Hex, isUuid } from "../../core/util.js";
import {
  recordDeviceAssessment,
  requireDeviceIntegrity,
  nativeControl,
} from "./governance.js";

/** F-007: native-held secret + install signature, browser tokens never leave the server.
 * @param {any} router */
export function installNativeOidc(router) {
  router.post(
    "/api/auth/oidc/native/start",
    async (/** @type {any} */ c) => {
      const b = c.body;
      if (b.version !== 2 || !["field-android", "van-android"].includes(b.app))
        throw invalid();
      const spki = b.deviceKey?.publicKeySpki;
      if (typeof spki !== "string" || spki.length > 512) throw invalid();
      const bytes = Buffer.from(spki, "base64");
      if (
        bytes.toString("base64") !== spki ||
        sha256Hex(bytes) !== b.deviceKey.keyId
      )
        throw invalid();
      try {
        await crypto.subtle.importKey(
          "spki",
          bytes,
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["verify"],
        );
      } catch {
        throw invalid("Invalid phone key");
      }
      if (
        typeof b.integrity?.rooted !== "boolean" ||
        typeof b.integrity?.tampered !== "boolean"
      )
        throw invalid();
      await takeOrThrow(c.db, `sso-start:${b.deviceKey.keyId}`, {
        limit: 5,
        windowMs: 300_000,
      });
      const [provider] =
        await c.db`select id,code,label,redirect_uri from identity_providers where code=${b.provider} and effective_from<=now() and (effective_to is null or effective_to>now())`;
      if (!provider)
        throw invalid("Choose a configured company sign-in provider");
      const secret = randomToken("");
      const [r] =
        await c.db`insert into native_oidc_requests(secret_hash,app,key_id,public_key_spki,integrity,provider_id,expires_at) values(${sha256Hex(secret)},${b.app},${b.deviceKey.keyId},${spki},${{ rooted: b.integrity.rooted, tampered: b.integrity.tampered }},${provider.id},now()+interval '5 minutes') returning id,expires_at`;
      // Use the administrator-configured public origin, never a Host-header-derived redirect.
      const url = new URL("/api/auth/oidc/start", provider.redirect_uri);
      url.searchParams.set("provider", provider.code);
      url.searchParams.set("native", secret);
      return {
        version: 2,
        requestId: r.id,
        pollSecret: secret,
        authorizationUrl: url.toString(),
        expiresAt: new Date(r.expires_at).getTime(),
      };
    },
    { v2: true },
  );
  router.post(
    "/api/auth/oidc/native/poll",
    async (/** @type {any} */ c) => {
      const b = c.body;
      if (
        !isUuid(b.requestId) ||
        typeof b.pollSecret !== "string" ||
        b.pollSecret.length > 256 ||
        typeof b.signature !== "string"
      )
        throw invalid();
      await takeOrThrow(c.db, `sso-poll:${b.requestId}`, {
        limit: 110,
        windowMs: 300_000,
      });
      return tx(c.db, async (t) => {
        const [r] =
          await t`select * from native_oidc_requests where id=${b.requestId} and secret_hash=${sha256Hex(b.pollSecret)} and consumed_at is null and expires_at>now() for update`;
        if (
          !r ||
          !(await verifySignature(
            r.public_key_spki,
            b.signature,
            `SSO|${r.id}|${b.pollSecret}`,
          ))
        )
          throw forbidden("Company sign-in expired. Start again.");
        if (!r.user_id) return { version: 2, status: "waiting" };
        const [link] =
          await t`select f.id from federated_identities f join identity_providers p on p.id=${r.provider_id} where f.id=${r.identity_id} and f.user_id=${r.user_id} and f.issuer=p.issuer and f.effective_from<=now() and (f.effective_to is null or f.effective_to>now()) and p.effective_from<=now() and (p.effective_to is null or p.effective_to>now()) for share of f,p`;
        if (!link)
          throw forbidden("Company access changed. Start sign-in again.");
        const [user] =
          await t`select id from users where id=${r.user_id} and disabled_at is null for update`;
        const profile = user ? await loadProfile(t, user.id) : null;
        if (!profile || profile.status !== "active") throw forbidden();
        await registerSamplePhone(t, user.id, r.app, {
          keyId: r.key_id,
          publicKeySpki: r.public_key_spki,
        });
        const [device] =
          await t`select * from registered_devices where profile_id=${profile.id} and key_id=${r.key_id} and app=${r.app} and status<>'revoked' order by created_at desc limit 1`;
        if (device) {
          await recordDeviceAssessment(t, device, r.integrity);
          if (!(await nativeControl(t, profile.id, r.key_id, r.app)))
            await requireDeviceIntegrity(t, device);
        }
        const session = await createSession(t, user.id, r.app, r.key_id);
        const access = await createAccess(t, session.id);
        await t`update native_oidc_requests set consumed_at=now() where id=${r.id}`;
        await t`insert into audit_logs(subject,action,entity_type,entity_id,details) values(${user.id},'auth.native_oidc_signed_in','user',${user.id},${JSON.stringify({ app: r.app })})`;
        return {
          version: 2,
          status: "signed_in",
          serverTime: Date.now(),
          sessionToken: session.token,
          sessionExpiresAt: session.expiresAt,
          accessToken: access.token,
          accessExpiresAt: access.expiresAt,
        };
      });
    },
    { v2: true },
  );
}
