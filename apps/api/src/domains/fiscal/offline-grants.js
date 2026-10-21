import {
  createECDH,
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { sha256Hex } from "../../core/util.js";
import { ApiError } from "../../core/errors.js";

/** F-110/F-124: domain-separated server signing key. Only its SPKI ever reaches a phone.
 * The phone's own Keystore key is unrelated and never exported.
 * @param {Record<string,string|undefined>} env */
function signingKey(env) {
  const secret = env.SYNC_CURSOR_SECRET;
  if (!secret || secret.length < 32)
    throw new ApiError(
      "approval_unavailable",
      503,
      "Offline approvals need server setup",
    );
  for (let attempt = 0; attempt < 10; attempt++) {
    const d = createHmac("sha256", secret)
      .update(`sunpride/fiscal-offline-grant/v1/${attempt}`)
      .digest();
    const curve = createECDH("prime256v1");
    try {
      curve.setPrivateKey(d);
    } catch {
      continue;
    }
    const point = curve.getPublicKey(undefined, "uncompressed");
    return createPrivateKey({
      format: "jwk",
      key: {
        kty: "EC",
        crv: "P-256",
        d: d.toString("base64url"),
        x: point.subarray(1, 33).toString("base64url"),
        y: point.subarray(33, 65).toString("base64url"),
      },
    });
  }
  throw new ApiError(
    "approval_unavailable",
    503,
    "Offline approvals need server setup",
  );
}
/** @param {Record<string,string|undefined>} env */
export function offlineApprovalKey(env) {
  const spki = createPublicKey(signingKey(env))
    .export({ type: "spki", format: "der" })
    .toString("base64");
  return { algorithm: "ES256", keyId: sha256Hex(spki), publicKeySpki: spki };
}
/** A portable approval is still reauthorized by the canonical business writer on upload.
 * It is not a login, bearer session, price or stock authority of its own.
 * @param {Record<string,string|undefined>} env @param {any} request @param {string} approverId @param {'offline'|'live'} [mode] */
export function offlineApprovalGrant(
  env,
  request,
  approverId,
  mode = "offline",
) {
  const key = signingKey(env),
    verification = offlineApprovalKey(env);
  const at = Date.now();
  const facts = {
    version: 1,
    mode,
    keyId: verification.keyId,
    requestId: request.id,
    ruleId: request.rule_id,
    requesterId: request.requester_id,
    approverId,
    orgUnitId: request.org_unit_id,
    kind: request.kind,
    channel: request.channel,
    amountCentavos: String(request.amount_centavos),
    factsHash: request.facts_hash,
    reasonHash: sha256Hex(request.reason),
    issuedAt: at,
    expiresAt: Math.min(
      new Date(request.expires_at).getTime(),
      at + (mode === "live" ? 60000 : 86400000),
    ),
  };
  const body = Buffer.from(JSON.stringify(facts)).toString("base64url");
  const signature = sign("sha256", Buffer.from(body), {
    key,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `SP-APPROVAL1.${body}.${signature}`;
}
/** @param {Record<string,string|undefined>} env @param {string} token */
export function verifyOfflineApprovalGrant(env, token) {
  try {
    if (token.length > 6000) throw new Error("size");
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "SP-APPROVAL1")
      throw new Error("version");
    const body = Buffer.from(parts[1], "base64url"),
      signature = Buffer.from(parts[2], "base64url");
    if (
      body.toString("base64url") !== parts[1] ||
      signature.toString("base64url") !== parts[2] ||
      signature.length !== 64
    )
      throw new Error("encoding");
    if (
      !verify(
        "sha256",
        Buffer.from(parts[1]),
        { key: createPublicKey(signingKey(env)), dsaEncoding: "ieee-p1363" },
        signature,
      )
    )
      throw new Error("signature");
    const payload = JSON.parse(body.toString("utf8"));
    if (
      payload.version !== 1 ||
      !["live", "offline"].includes(payload.mode) ||
      payload.keyId !== offlineApprovalKey(env).keyId ||
      !Number.isSafeInteger(payload.expiresAt) ||
      !Number.isSafeInteger(payload.issuedAt) ||
      payload.issuedAt >= payload.expiresAt ||
      payload.expiresAt - payload.issuedAt >
        (payload.mode === "live" ? 60000 : 86400000) ||
      payload.expiresAt <= Date.now()
    )
      throw new Error("claims");
    return payload;
  } catch {
    throw new ApiError(
      "invalid_input",
      400,
      "Offline approval is invalid or belongs to another server",
    );
  }
}
