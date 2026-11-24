import { beforeAll, afterAll, test, expect } from "bun:test";
import { startHarness, deviceKey } from "./harness.js";
import { install as org } from "../src/domains/org/index.js";
import { install as integrity } from "../src/domains/integrity/index.js";
/** @type {any} */ let h;
/** @type {any} */ let profile;
/** @type {string} */ let cookie;
/** @type {string} */ let provider;
/** @type {string} */ let issuer;
const password = "test-only-company-sign-in";
/** @param {string} path @param {any} [body] @param {string} [auth] */
async function api(path, body, auth = cookie) {
  const r = await h.fetch(path, {
    method: body ? "POST" : "GET",
    headers: { cookie: auth ?? "", "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json() };
}
beforeAll(async () => {
  h = await startHarness({
    installers: [org, integrity],
    env: { SP_MOCK_IDP: "1" },
  });
  const [user] =
    await h.db`insert into users(email,password_hash) values('boss@example.com',${await Bun.password.hash(password)}) returning id`;
  const login = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "boss@example.com", password }),
  });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  profile = (await api("/api/me")).body.profile;
  await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values('finish-a-test','profiles',${profile.id},'boss')`;
  issuer = h.origin + "/api/mock-idp";
  provider = (
    await api("/api/v1/integrity/identity/provider", {
      code: "sample_company",
      label: "SAMPLE company",
      issuer,
      clientId: "sample-client",
      redirectUri: h.origin + "/api/auth/oidc/callback",
      sourceRef: "SAMPLE test provider",
    })
  ).body.id;
  const linked = await api("/api/v1/integrity/identity/link", {
    issuer,
    subject: "sample-boss",
    profileId: profile.id,
    sourceRef: "SAMPLE mapping",
  });
  expect(linked.status).toBe(200);
  expect(user.id).toBeTruthy();
});
afterAll(async () => await h?.close());
/** @param {any} start */
async function browser(start) {
  const r = await fetch(start.authorizationUrl, { redirect: "manual" });
  expect(r.status).toBe(302);
  const authz = await fetch(r.headers.get("location") ?? "", {
    redirect: "manual",
  });
  const callback = await fetch(authz.headers.get("location") ?? "", {
    redirect: "manual",
    headers: { cookie: (r.headers.get("set-cookie") ?? "").split(";")[0] },
  });
  expect(callback.status).toBe(200);
  expect(await callback.text()).toContain("Return to the Sunpride app");
  expect(callback.headers.get("set-cookie")).toBeNull();
}
for (const app of ["field-android", "van-android"])
  test(`F-007 ${app} company SSO uses browser PKCE and single-use install-bound redemption`, async () => {
    const key = await deviceKey();
    const start = await api(
      "/api/auth/oidc/native/start",
      {
        version: 2,
        app,
        provider: "sample_company",
        deviceKey: { keyId: key.keyId, publicKeySpki: key.publicKeySpki },
        integrity: { rooted: false, tampered: false },
      },
      "",
    );
    expect(start.status).toBe(200);
    const data = start.body;
    const poll = {
      requestId: data.requestId,
      pollSecret: data.pollSecret,
      signature: await key.sign(`SSO|${data.requestId}|${data.pollSecret}`),
    };
    expect(
      (await api("/api/auth/oidc/native/poll", poll, "")).body.status,
    ).toBe("waiting");
    await browser(data);
    const wrong = await deviceKey();
    expect(
      (
        await api(
          "/api/auth/oidc/native/poll",
          {
            ...poll,
            signature: await wrong.sign(
              `SSO|${data.requestId}|${data.pollSecret}`,
            ),
          },
          "",
        )
      ).status,
    ).toBe(403);
    const redeemed = await api("/api/auth/oidc/native/poll", poll, "");
    expect(redeemed.status).toBe(200);
    expect(redeemed.body.sessionToken.startsWith("sps_")).toBe(true);
    const [session] =
      await h.db`select app,device_key_id from sessions where token_hash=${new Bun.CryptoHasher("sha256").update(redeemed.body.sessionToken).digest("hex")}`;
    expect(session.app).toBe(app);
    expect(session.device_key_id).toBe(key.keyId);
    expect((await api("/api/auth/oidc/native/poll", poll, "")).status).toBe(
      403,
    );
  });
for (const app of ["field-android", "van-android"]) {
  test(`SP-0248 ${app} company sign-in records a normal employee's waiting phone`, async () => {
    const [user] =
      await h.db`insert into users(email,password_hash) values(${`${app}@company-waiting.test`},${await Bun.password.hash(password)}) returning id`;
    const [seller] =
      await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id)
      values(${user.id},${user.id},'SAMPLE company employee',${`${app}@company-waiting.test`},'sales','active',${profile.orgUnitId}) returning id`;
    await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason)
      values(${seller.id},${profile.orgUnitId},'sales',now()-interval '1 day','TEST','TEST')`;
    const linked = await api("/api/v1/integrity/identity/link", {
      issuer,
      subject: `test-${app}`,
      profileId: seller.id,
      sourceRef: "TEST waiting-phone identity",
    });
    expect(linked.status).toBe(200);
    const key = await deviceKey();
    const started = await api(
      "/api/auth/oidc/native/start",
      {
        version: 2,
        app,
        provider: "sample_company",
        deviceKey: key,
        integrity: { rooted: false, tampered: false },
      },
      "",
    );
    expect(started.status).toBe(200);
    const start = started.body;
    // Substitute only the successful provider callback; redemption/session/request writes are real.
    await h.db`update native_oidc_requests set user_id=${user.id},identity_id=${linked.body.id} where id=${start.requestId}`;
    const redeemed = await api(
      "/api/auth/oidc/native/poll",
      {
        requestId: start.requestId,
        pollSecret: start.pollSecret,
        signature: await key.sign(`SSO|${start.requestId}|${start.pollSecret}`),
      },
      "",
    );
    expect(redeemed.status).toBe(200);
    expect(redeemed.body.status).toBe("signed_in");
    const fleet = await api("/api/v1/integrity/fleet");
    expect(
      fleet.body.waiting.find(
        (/** @type {any} */ r) => r.personId === seller.id,
      ),
    ).toMatchObject({
      app,
      phoneCode: (
        key.keyId.slice(0, 16).toUpperCase().match(/.{4}/g) ?? []
      ).join(" "),
    });
    expect(
      await h.db`select id from registered_devices where profile_id=${seller.id}`,
    ).toHaveLength(0);
  });
}

test("F-007 office identity history, exact-subject conflict and retired-link denial", async () => {
  const history = await api("/api/v1/integrity/identity");
  expect(history.status).toBe(200);
  expect(
    history.body.providers.find((/** @type {any} */ p) => p.id === provider)
      .label,
  ).toBe("SAMPLE company");
  expect(
    (
      await api("/api/v1/integrity/identity/link", {
        issuer,
        subject: "sample-boss",
        profileId: profile.id,
      })
    ).status,
  ).toBe(409);
  const key = await deviceKey();
  const start = (
    await api(
      "/api/auth/oidc/native/start",
      {
        version: 2,
        app: "field-android",
        provider: "sample_company",
        deviceKey: key,
        integrity: { rooted: false, tampered: false },
      },
      "",
    )
  ).body;
  await browser(start);
  const id = history.body.links.find(
    (/** @type {any} */ l) => l.subject === "sample-boss",
  ).id;
  expect(
    (
      await api("/api/v1/integrity/identity/unlink", {
        id,
        reason: "SAMPLE access retirement",
      })
    ).status,
  ).toBe(200);
  const poll = {
    requestId: start.requestId,
    pollSecret: start.pollSecret,
    signature: await key.sign(`SSO|${start.requestId}|${start.pollSecret}`),
  };
  expect((await api("/api/auth/oidc/native/poll", poll, "")).status).toBe(403);
  const read = await api("/api/v1/integrity/identity");
  expect(
    read.body.links.find((/** @type {any} */ l) => l.id === id).effective_to,
  ).toBeTruthy();
  expect(
    await h.db`select * from audit_logs where action='identity.unlinked' and entity_id=${id}`,
  ).toHaveLength(1);
});
