import { tx } from "@sunpride/db/client";
import {
  createSession,
  setSessionCookie,
  SESSION_TTL_MS,
} from "../../core/auth.js";
import { ApiError, forbidden, invalid } from "../../core/errors.js";
import { randomToken, sha256Hex } from "../../core/util.js";
import { loadProfile } from "../../core/hooks.js";

/** F-007: OIDC authorization code + S256 PKCE + nonce; no implicit email linking. */
const b64 = (/** @type {string|Uint8Array} */ s) =>
  Buffer.from(s).toString("base64url");
/** @param {string} to */
const redirect = (to) =>
  new Response(null, {
    status: 302,
    headers: { location: to, "cache-control": "no-store" },
  });
/** @param {any} c @param {string} url */
function allowedUrl(c, url) {
  const u = new URL(url);
  const mock =
    c.env.SP_MOCK_IDP === "1" &&
    u.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(u.hostname);
  if ((u.protocol !== "https:" && !mock) || u.username || u.password || u.hash)
    throw invalid("Use a secure identity provider");
  return u;
}
/** @param {any} c @param {string} url @param {RequestInit} [init] */
async function fetchJson(c, url, init = {}) {
  allowedUrl(c, url);
  const res = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok)
    throw new ApiError(
      "identity_unavailable",
      502,
      "Identity provider unavailable",
    );
  const text = await res.text();
  if (text.length > 128_000) throw invalid("Identity response is too large");
  return JSON.parse(text);
}
/** @param {any} c @param {any} p */
async function discovery(c, p) {
  const d = await fetchJson(
    c,
    p.issuer.replace(/\/$/, "") + "/.well-known/openid-configuration",
  );
  if (
    d.issuer !== p.issuer ||
    !d.code_challenge_methods_supported?.includes("S256")
  )
    throw invalid("Identity provider configuration mismatch");
  for (const endpoint of [
    d.authorization_endpoint,
    d.token_endpoint,
    d.jwks_uri,
  ]) {
    if (
      typeof endpoint !== "string" ||
      allowedUrl(c, endpoint).origin !== new URL(p.issuer).origin
    )
      throw invalid("Identity endpoint origin mismatch");
  }
  return d;
}
/** @param {any} c @param {any} p @param {string} token @param {string} nonce @param {any} d */
export async function validateIdToken(c, p, token, nonce, d) {
  if (typeof token !== "string" || token.length > 16_384)
    throw forbidden("Invalid identity token");
  const parts = token.split(".");
  if (
    parts.length !== 3 ||
    parts.some(
      (s) =>
        !/^[A-Za-z0-9_-]+$/.test(s) ||
        Buffer.from(s, "base64url").toString("base64url") !== s,
    )
  )
    throw forbidden("Invalid identity token");
  const head = JSON.parse(Buffer.from(parts[0], "base64url").toString()),
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  if (head.alg !== "RS256" || typeof head.kid !== "string")
    throw forbidden("Unsupported identity signature");
  const jwks = await fetchJson(c, d.jwks_uri);
  const matches = jwks.keys?.filter(
    (/** @type {any} */ k) =>
      k.kid === head.kid &&
      k.kty === "RSA" &&
      (!k.use || k.use === "sig") &&
      (!k.alg || k.alg === "RS256"),
  );
  if (matches?.length !== 1) throw forbidden("Unknown identity signing key");
  const key = await crypto.subtle.importKey(
    "jwk",
    matches[0],
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  if (
    !(await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      Buffer.from(parts[2], "base64url"),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    ))
  )
    throw forbidden("Invalid identity signature");
  const now = Math.floor(Date.now() / 1000),
    aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    claims.iss !== p.issuer ||
    !aud.includes(p.client_id) ||
    (aud.length > 1 && claims.azp !== p.client_id) ||
    claims.nonce !== nonce ||
    typeof claims.sub !== "string" ||
    !claims.sub ||
    claims.sub.length > 512 ||
    !Number.isSafeInteger(claims.exp) ||
    claims.exp <= now ||
    !Number.isSafeInteger(claims.iat) ||
    claims.iat > now + 30 ||
    (claims.nbf && claims.nbf > now + 30)
  )
    throw forbidden("Identity token expired or not intended for this app");
  return claims;
}
/** @param {any} router */
export function installOidc(router) {
  router.get("/api/auth/oidc/providers", async (/** @type {any} */ c) => ({
    providers:
      await c.db`select code,label from identity_providers where effective_from<=now() and (effective_to is null or effective_to>now()) order by label`,
  }));
  router.get("/api/auth/oidc/start", async (/** @type {any} */ c) => {
    const rows =
      await c.db`select * from identity_providers where code=${c.url.searchParams.get("provider")} and effective_from<=now() and (effective_to is null or effective_to>now())`;
    if (rows.length !== 1)
      throw invalid("Choose a configured identity provider");
    const p = rows[0],
      d = await discovery(c, p),
      state = randomToken(""),
      nonce = randomToken(""),
      verifier = randomToken("");
    await c.db`insert into oidc_requests(state_hash,provider_id,nonce,verifier,expires_at) values (${sha256Hex(state)},${p.id},${nonce},${verifier},now()+interval '5 minutes')`;
    const secure =
      new URL(p.redirect_uri).protocol === "https:" ? "; Secure" : "";
    c.cookies.push(
      `sp_oidc=${state}; Path=/api/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=300${secure}`,
    );
    const url = new URL(d.authorization_endpoint);
    for (const [k, v] of Object.entries({
      response_type: "code",
      client_id: p.client_id,
      redirect_uri: p.redirect_uri,
      scope: "openid profile email",
      state,
      nonce,
      code_challenge: b64(Buffer.from(sha256Hex(verifier), "hex")),
      code_challenge_method: "S256",
    }))
      url.searchParams.set(k, v);
    return redirect(url.toString());
  });
  router.get("/api/auth/oidc/callback", async (/** @type {any} */ c) => {
    const state = c.url.searchParams.get("state"),
      code = c.url.searchParams.get("code");
    const cookie = c.req.headers
      .get("cookie")
      ?.split(";")
      .map((/** @type {string} */ s) => s.trim())
      .find((/** @type {string} */ s) => s.startsWith("sp_oidc="))
      ?.slice(8);
    if (
      !state ||
      state.length > 256 ||
      state !== cookie ||
      !code ||
      code.length > 2048
    )
      throw forbidden("Sign-in request expired");
    // Burn before exchanging: retries cannot re-use the same browser authorization request.
    const [r] =
      await c.db`update oidc_requests set consumed_at=now() where state_hash=${sha256Hex(state)} and consumed_at is null and expires_at>now() returning *`;
    if (!r) throw forbidden("Sign-in request expired");
    const [p] =
      await c.db`select * from identity_providers where id=${r.provider_id} and effective_from<=now() and (effective_to is null or effective_to>now())`;
    if (!p) throw forbidden("Identity provider disabled");
    const d = await discovery(c, p);
    const tokens = await fetchJson(c, d.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: p.client_id,
        redirect_uri: p.redirect_uri,
        code_verifier: r.verifier,
      }),
    });
    const claims = await validateIdToken(c, p, tokens.id_token, r.nonce, d);
    const session = await tx(c.db, async (t) => {
      const [identity] =
        await t`select u.id from federated_identities f join users u on u.id=f.user_id where f.issuer=${p.issuer} and f.subject=${claims.sub} and u.disabled_at is null for update of u`;
      if (!identity || (await loadProfile(t, identity.id))?.status !== "active")
        throw forbidden("This identity has not been assigned access");
      const s = await createSession(t, identity.id, "web", null);
      await t`insert into audit_logs(subject,action,entity_type,entity_id,details) values (${identity.id},'auth.oidc_signed_in','user',${identity.id},${{ provider: p.code }})`;
      return s;
    });
    setSessionCookie(c, session.token, SESSION_TTL_MS);
    c.cookies.push(
      "sp_oidc=; Path=/api/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=0",
    );
    return redirect("/today");
  });
}

/** F-007: local-only mock IdP with REAL RS256/code/PKCE, explicitly sample-only. No network IdP or paid service. @param {any} router @param {any} platform */
export function installMockIdp(router, platform) {
  if (platform.env.SP_MOCK_IDP !== "1") return;
  const keys = crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  /** @type {Map<string,{client:string,redirect:string,challenge:string,nonce:string,subject:string,expires:number}>} */ const codes =
    new Map();
  /** @param {any} c */
  const issuer = (c) => {
    if (!["127.0.0.1", "localhost"].includes(c.url.hostname))
      throw forbidden("Mock identity is local only");
    return `${c.url.origin}/api/mock-idp`;
  };
  router.get(
    "/api/mock-idp/.well-known/openid-configuration",
    (/** @type {any} */ c) => {
      const i = issuer(c);
      return {
        issuer: i,
        authorization_endpoint: i + "/authorize",
        token_endpoint: i + "/token",
        jwks_uri: i + "/jwks",
        code_challenge_methods_supported: ["S256"],
        response_types_supported: ["code"],
        id_token_signing_alg_values_supported: ["RS256"],
        subject_types_supported: ["public"],
      };
    },
  );
  router.get("/api/mock-idp/jwks", async (/** @type {any} */ c) => {
    issuer(c);
    return {
      keys: [
        {
          ...(await crypto.subtle.exportKey("jwk", (await keys).publicKey)),
          kid: "local-mock-v1",
          alg: "RS256",
          use: "sig",
        },
      ],
    };
  });
  router.get("/api/mock-idp/authorize", async (/** @type {any} */ c) => {
    const i = issuer(c),
      q = c.url.searchParams;
    const [p] =
      await c.db`select * from identity_providers where issuer=${i} and client_id=${q.get("client_id")} and redirect_uri=${q.get("redirect_uri")} and effective_from<=now() and (effective_to is null or effective_to>now())`;
    const [sample] =
      await c.db`select f.subject from federated_identities f join profiles p on p.user_id=f.user_id join sample_data_rows s on s.row_id=p.id::text and s.table_name='profiles' where f.issuer=${i} order by f.created_at limit 1`;
    if (
      !p ||
      !sample ||
      q.get("response_type") !== "code" ||
      q.get("code_challenge_method") !== "S256" ||
      !q.get("nonce") ||
      !q.get("state") ||
      !/^[A-Za-z0-9_-]{43}$/.test(q.get("code_challenge") ?? "")
    )
      throw invalid("Mock identity is not configured");
    for (const [key, row] of codes)
      if (row.expires < Date.now()) codes.delete(key);
    if (codes.size >= 1000) throw invalid("Mock identity request limit");
    const code = randomToken("");
    codes.set(code, {
      client: p.client_id,
      redirect: p.redirect_uri,
      challenge: q.get("code_challenge"),
      nonce: q.get("nonce"),
      subject: sample.subject,
      expires: Date.now() + 60_000,
    });
    const url = new URL(p.redirect_uri);
    url.searchParams.set("code", code);
    url.searchParams.set("state", q.get("state"));
    return redirect(url.toString());
  });
  router.post(
    "/api/mock-idp/token",
    async (/** @type {any} */ c) => {
      const i = issuer(c),
        form = new URLSearchParams(await c.req.text()),
        code = form.get("code") ?? "",
        r = codes.get(code);
      codes.delete(code);
      if (
        !r ||
        r.expires < Date.now() ||
        form.get("grant_type") !== "authorization_code" ||
        r.client !== form.get("client_id") ||
        r.redirect !== form.get("redirect_uri") ||
        r.challenge !==
          b64(Buffer.from(sha256Hex(form.get("code_verifier") ?? ""), "hex"))
      )
        throw forbidden("Invalid mock authorization code");
      const now = Math.floor(Date.now() / 1000),
        payload = `${b64(JSON.stringify({ alg: "RS256", kid: "local-mock-v1" }))}.${b64(JSON.stringify({ iss: i, sub: r.subject, aud: r.client, nonce: r.nonce, iat: now, exp: now + 300 }))}`;
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        (await keys).privateKey,
        new TextEncoder().encode(payload),
      );
      return {
        id_token: `${payload}.${b64(new Uint8Array(signature))}`,
        token_type: "Bearer",
        expires_in: 300,
      };
    },
    { raw: true },
  );
}
