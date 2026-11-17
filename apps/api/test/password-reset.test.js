import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  createUser,
  nativeSignIn,
  profileStore,
  startHarness,
} from "./harness.js";
import { setAuthMailSender } from "../src/core/auth-email.js";
import { temporaryPassword } from "../src/core/password-reset.js";

/** SP-0185: forgot password, reset by link, admin reset with a temporary password, forced change. */

/** @type {import('./harness.js').Harness} */
let h;
/** @type {ReturnType<typeof profileStore>} */
let profiles;
/** @type {any[]} */
let sent = [];
let failMail = false;
const UNIT = crypto.randomUUID();
beforeAll(async () => {
  h = await startHarness({
    installers: [],
    env: { PUBLIC_WEB_URL: "https://web.example.test" },
  });
  profiles = profileStore(h);
  setAuthMailSender(async (mail) => {
    if (failMail) throw new Error("provider down");
    sent.push(mail);
    return { providerId: "test-id" };
  });
});
afterAll(async () => {
  setAuthMailSender(null);
  await h?.close();
});
beforeEach(() => {
  sent = [];
  failMail = false;
});

const PASSWORD = "initial-test-secret";
/** @param {string} path @param {any} body @param {Record<string,string>} [headers] */
const post = (path, body, headers = {}) =>
  h.fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Each test acts from its own client address so per-client budgets do not interfere.
      "x-forwarded-for": headers["x-forwarded-for"] ?? crypto.randomUUID(),
      ...headers,
    },
    body: JSON.stringify(body),
  });
/** @param {Response} res */
const cookieOf = (res) => (res.headers.get("set-cookie") ?? "").split(";")[0];
/** @param {Response} res */
const codeOf = async (res) => /** @type {any} */ (await res.json()).error?.code;
const waitFor = async (/** @type {() => boolean} */ ok) => {
  for (let i = 0; i < 100 && !ok(); i++) await Bun.sleep(20);
};

/** @param {{ role?: string, orgUnitId?: string|null, status?: string, email?: string }} [o] */
async function person(o = {}) {
  const email = o.email ?? `${crypto.randomUUID()}@example.test`;
  const userId = await createUser(h, email, PASSWORD);
  profiles.set(userId, {
    role: o.role ?? "sales",
    orgUnitId: o.orgUnitId === undefined ? UNIT : o.orgUnitId,
    status: o.status,
  });
  return { email, userId };
}
/** @param {string} email @param {string} [password] */
async function webSignIn(email, password = PASSWORD) {
  const res = await post("/api/auth/sign-in", { email, password });
  return { res, cookie: cookieOf(res) };
}
/** @param {string} role */
async function admin(role = "admin") {
  const a = await person({ role });
  return { ...a, cookie: (await webSignIn(a.email)).cookie };
}
/** @param {string} cookie @param {any} body */
const adminReset = (cookie, body) =>
  post("/api/v1/people/reset-password", body, { cookie });

async function allSecretFreeRows() {
  const rows = [
    ...(await h.db`select * from auth_email_deliveries`),
    ...(await h.db`select * from audit_logs`),
    ...(await h.db`select * from password_reset_tokens`),
  ];
  return JSON.stringify(rows);
}

test("temporary password: 10 unambiguous characters, grouped, random", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const p = temporaryPassword();
    expect(p).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{2}$/);
    expect(p).not.toMatch(/[0O1lI]/);
    seen.add(p);
  }
  expect(seen.size).toBe(200);
});

test("forgot-password never reveals whether an account exists", async () => {
  const p = await person();
  const known = await post("/api/auth/forgot-password", { email: p.email });
  const unknown = await post("/api/auth/forgot-password", {
    email: `nobody-${crypto.randomUUID()}@example.test`,
  });
  const disabled = await person();
  await h.db`update users set disabled_at=now() where id=${disabled.userId}`;
  const off = await post("/api/auth/forgot-password", {
    email: disabled.email,
  });
  for (const res of [known, unknown, off]) {
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  }
  await waitFor(() => sent.length > 0);
  await Bun.sleep(100);
  expect(sent.map((m) => m.to)).toEqual([p.email]);
  expect(sent[0].kind).toBe("reset_link");
  expect(sent[0].text).toContain(
    "https://web.example.test/reset-password?token=",
  );
});

test("forgot-password is rate limited per email without changing the answer", async () => {
  const p = await person();
  for (let i = 0; i < 5; i++)
    expect(
      (await post("/api/auth/forgot-password", { email: p.email })).status,
    ).toBe(200);
  await Bun.sleep(200);
  expect(sent.length).toBe(3);
});

test("forgot-password is rate limited per client", async () => {
  const ip = crypto.randomUUID();
  /** @type {number[]} */
  const statuses = [];
  for (let i = 0; i < 22; i++)
    statuses.push(
      (
        await post(
          "/api/auth/forgot-password",
          { email: `x${i}-${crypto.randomUUID()}@example.test` },
          { "x-forwarded-for": ip },
        )
      ).status,
    );
  expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
  expect(statuses.at(-1)).toBe(429);
});

/** @param {string} email */
async function linkFor(email) {
  sent = [];
  await post("/api/auth/forgot-password", { email });
  await waitFor(() => sent.length > 0);
  const m = /token=([A-Za-z0-9_-]+)/.exec(sent[0].text);
  return /** @type {string} */ (m?.[1]);
}

test("reset link: sha256-only storage, single use, revokes every session, audits", async () => {
  const p = await person();
  const web = await webSignIn(p.email);
  const native = await nativeSignIn(h, p.email, PASSWORD);
  const token = await linkFor(p.email);
  const [row] =
    await h.db`select token_hash from password_reset_tokens where user_id=${p.userId} and used_at is null`;
  expect(row.token_hash).toBe(new Bun.CryptoHasher("sha256").update(token).digest("hex"));
  const res = await post("/api/auth/reset-password", {
    token,
    newPassword: "chosen-by-link-1",
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(
    (await h.fetch("/api/me", { headers: { cookie: web.cookie } })).status,
  ).toBe(401);
  expect(
    (
      await h.fetch("/api/me", {
        headers: { authorization: `Bearer ${native.body.accessToken}` },
      })
    ).status,
  ).toBe(401);
  expect((await webSignIn(p.email)).res.status).toBe(401);
  expect((await webSignIn(p.email, "chosen-by-link-1")).res.status).toBe(200);
  const again = await post("/api/auth/reset-password", {
    token,
    newPassword: "chosen-by-link-2",
  });
  expect(again.status).toBe(400);
  const body = /** @type {any} */ (await again.json());
  expect(body.error.code).toBe("reset_link_invalid");
  expect(body.error.message).toBe(
    "This link is no longer valid. Ask for a new one.",
  );
  const audits =
    await h.db`select * from audit_logs where entity_id=${p.userId} and action='auth.password_reset_by_link'`;
  expect(audits.length).toBe(1);
  const dump = await allSecretFreeRows();
  expect(dump.includes(token)).toBe(false);
  expect(dump.includes("chosen-by-link")).toBe(false);
});

test("reset link: expired and older links are refused; weak passwords keep the link", async () => {
  const p = await person();
  const first = await linkFor(p.email);
  const second = await linkFor(p.email);
  expect(
    await codeOf(
      await post("/api/auth/reset-password", {
        token: first,
        newPassword: "another-secret-1",
      }),
    ),
  ).toBe("reset_link_invalid");
  const weak = await post("/api/auth/reset-password", {
    token: second,
    newPassword: "short",
  });
  expect(weak.status).toBe(422);
  const wb = /** @type {any} */ (await weak.json());
  expect(wb.error.code).toBe("weak_password");
  expect(wb.error.message).toBe(
    "Choose a password between 8 and 128 characters.",
  );
  await h.db`update password_reset_tokens set expires_at=now() - interval '1 minute' where user_id=${p.userId}`;
  expect(
    await codeOf(
      await post("/api/auth/reset-password", {
        token: second,
        newPassword: "another-secret-1",
      }),
    ),
  ).toBe("reset_link_invalid");
  expect(
    await codeOf(
      await post("/api/auth/reset-password", {
        token: "not-a-real-token-at-all-xyz",
        newPassword: "another-secret-1",
      }),
    ),
  ).toBe("reset_link_invalid");
});

test("admin reset: temporary password once, emailed, sessions revoked, flag set, audit has no secret", async () => {
  const a = await admin();
  const p = await person();
  const web = await webSignIn(p.email);
  const res = await adminReset(a.cookie, { userId: p.userId });
  expect(res.status).toBe(200);
  const body = /** @type {any} */ (await res.json());
  expect(body.emailed).toBe(true);
  expect(body.email).toBe(p.email);
  expect(body.temporaryPassword).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{2}$/);
  const hours = (body.expiresAt - Date.now()) / 3_600_000;
  expect(hours).toBeGreaterThan(71.9);
  expect(hours).toBeLessThanOrEqual(72);
  expect(sent.length).toBe(1);
  expect(sent[0].kind).toBe("temporary_password");
  expect(sent[0].to).toBe(p.email);
  expect(sent[0].text).toContain(body.temporaryPassword);
  expect(
    (await h.fetch("/api/me", { headers: { cookie: web.cookie } })).status,
  ).toBe(401);
  const [u] =
    await h.db`select must_change_password, temp_password_expires_at from users where id=${p.userId}`;
  expect(u.must_change_password).toBe(true);
  const audits =
    await h.db`select * from audit_logs where entity_id=${p.userId} and action='auth.password_reset_by_admin'`;
  expect(audits.length).toBe(1);
  expect(audits[0].subject).toBe(a.userId);
  const deliveries =
    await h.db`select * from auth_email_deliveries where recipient=${p.email}`;
  expect(deliveries.map((/** @type {any} */ d) => d.state)).toEqual(["accepted"]);
  expect((await allSecretFreeRows()).includes(body.temporaryPassword)).toBe(
    false,
  );
  // The old password no longer works.
  expect((await webSignIn(p.email)).res.status).toBe(401);
});

test("admin reset permission matrix", async () => {
  const a = await admin();
  const sa = await admin("super_admin");
  const manager = await admin("manager");
  const superTarget = await person({ role: "super_admin" });
  const otherUnit = await person({ orgUnitId: crypto.randomUUID() });
  const disabledProfile = await person({ status: "disabled" });
  const disabledUser = await person();
  await h.db`update users set disabled_at=now() where id=${disabledUser.userId}`;
  const agent = await person({
    email: `${crypto.randomUUID()}@chat-agents.sunpride.invalid`,
  });
  const local = await person({ email: `${crypto.randomUUID()}@demo.local` });
  const plain = await person();
  /** @type {Array<[string, string, string, number, string|null]>} */
  const cases = [
    ["self", a.cookie, a.userId, 403, "reset_self"],
    ["admin -> super admin", a.cookie, superTarget.userId, 403, "reset_not_allowed"],
    ["manager has no admin.manage", manager.cookie, plain.userId, 403, null],
    ["admin outside scope", a.cookie, otherUnit.userId, 403, "out_of_scope"],
    ["disabled profile", a.cookie, disabledProfile.userId, 403, "reset_not_allowed"],
    ["disabled user", a.cookie, disabledUser.userId, 403, "reset_not_allowed"],
    ["agent user", a.cookie, agent.userId, 403, "reset_not_allowed"],
    ["local system user", a.cookie, local.userId, 403, "reset_not_allowed"],
    ["super admin -> super admin", sa.cookie, superTarget.userId, 200, null],
    ["super admin -> other unit", sa.cookie, otherUnit.userId, 200, null],
    ["admin -> same unit", a.cookie, plain.userId, 200, null],
  ];
  for (const [label, cookie, userId, status, code] of cases) {
    const res = await adminReset(cookie, { userId });
    expect(`${label}: ${res.status}`).toBe(`${label}: ${status}`);
    if (code) expect(`${label}: ${await codeOf(res)}`).toBe(`${label}: ${code}`);
  }
  // Refused resets changed nothing.
  const [still] =
    await h.db`select must_change_password from users where id=${agent.userId}`;
  expect(still.must_change_password).toBe(false);
  expect(
    (await post("/api/v1/people/reset-password", { userId: plain.userId }))
      .status,
  ).toBe(401);
});

test("email failure still applies the reset and reports emailed:false", async () => {
  const a = await admin();
  const p = await person();
  failMail = true;
  const res = await adminReset(a.cookie, { userId: p.userId });
  expect(res.status).toBe(200);
  const body = /** @type {any} */ (await res.json());
  expect(body.emailed).toBe(false);
  expect((await webSignIn(p.email, body.temporaryPassword)).res.status).toBe(
    200,
  );
  const deliveries =
    await h.db`select state from auth_email_deliveries where recipient=${p.email}`;
  expect(deliveries.map((/** @type {any} */ d) => d.state)).toEqual(["failed"]);
});

/** @param {string} [role] */
async function resetPerson(role) {
  const a = await admin();
  const p = await person({ role });
  const body = /** @type {any} */ (
    await (await adminReset(a.cookie, { userId: p.userId })).json()
  );
  return { ...p, temp: /** @type {string} */ (body.temporaryPassword) };
}

test("expired temporary password is refused at sign-in", async () => {
  const p = await resetPerson();
  await h.db`update users set temp_password_expires_at=now() - interval '1 minute' where id=${p.userId}`;
  const res = (await webSignIn(p.email, p.temp)).res;
  expect(res.status).toBe(401);
  const body = /** @type {any} */ (await res.json());
  expect(body.error.code).toBe("temporary_password_expired");
  expect(body.error.message).toBe(
    "This temporary password has expired. Ask your admin for a new one.",
  );
});

test("native sign-in: old builds are refused without a session; new builds get mustChangePassword", async () => {
  const p = await resetPerson();
  const before = Number(
    (await h.db`select count(*)::int as n from sessions where user_id=${p.userId}`)[0].n,
  );
  for (let i = 0; i < 12; i++) {
    const old = await nativeSignIn(h, p.email, p.temp);
    expect(old.res.status).toBe(403);
    expect(old.body.error.code).toBe("password_change_required");
  }
  // 12 refusals did not count as failed attempts (the budget is 10).
  const after = Number(
    (await h.db`select count(*)::int as n from sessions where user_id=${p.userId}`)[0].n,
  );
  expect(after).toBe(before);
  const res = await post("/api/auth/sign-in", {
    version: 2,
    app: "field-android",
    email: p.email,
    password: p.temp,
    passwordChange: "supported",
    integrity: { rooted: false, tampered: false, source: "TEST fixture" },
  });
  expect(res.status).toBe(200);
  const body = /** @type {any} */ (await res.json());
  expect(body.mustChangePassword).toBe(true);
  const me = await h.fetch("/api/me", {
    headers: { authorization: `Bearer ${body.accessToken}` },
  });
  expect(me.status).toBe(200);
  expect(/** @type {any} */ (await me.json()).mustChangePassword).toBe(true);
  // Other routes are blocked for the native session too.
  const blocked = await h.fetch("/api/v1/people/reset-password", {
    method: "POST",
    headers: {
      authorization: `Bearer ${body.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ userId: p.userId }),
  });
  expect(blocked.status).toBe(403);
  expect(await codeOf(blocked)).toBe("password_change_required");
  // Refresh still works.
  const refresh = await h.fetch("/api/auth/refresh", {
    method: "POST",
    headers: {
      authorization: `Bearer ${body.sessionToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ version: 2, app: "field-android" }),
  });
  expect(refresh.status).toBe(200);
});

test("web: forced change blocks other routes, allows me/change-password/sign-out, and clears the flag", async () => {
  const p = await resetPerson("admin");
  const { res, cookie } = await webSignIn(p.email, p.temp);
  expect(res.status).toBe(200);
  expect(/** @type {any} */ (await res.json()).mustChangePassword).toBe(true);
  const me = await h.fetch("/api/me", { headers: { cookie } });
  expect(me.status).toBe(200);
  expect(/** @type {any} */ (await me.json()).mustChangePassword).toBe(true);
  const blocked = await adminReset(cookie, { userId: crypto.randomUUID() });
  expect(blocked.status).toBe(403);
  expect(await codeOf(blocked)).toBe("password_change_required");
  const changed = await post(
    "/api/auth/change-password",
    { currentPassword: p.temp, newPassword: "my-own-new-secret" },
    { cookie },
  );
  expect(changed.status).toBe(200);
  const [u] =
    await h.db`select must_change_password, temp_password_expires_at from users where id=${p.userId}`;
  expect(u.must_change_password).toBe(false);
  expect(u.temp_password_expires_at).toBeNull();
  const after = await h.fetch("/api/me", { headers: { cookie } });
  expect(/** @type {any} */ (await after.json()).mustChangePassword).toBe(
    false,
  );
  // No longer blocked (now a normal not-found answer instead of password_change_required).
  const open = await adminReset(cookie, { userId: crypto.randomUUID() });
  expect(await codeOf(open)).not.toBe("password_change_required");
  expect(
    (await post("/api/auth/sign-out", {}, { cookie })).status,
  ).toBe(200);
  expect((await webSignIn(p.email, "my-own-new-secret")).res.status).toBe(200);
});

test("sign-out is allowed while a new password is required", async () => {
  const p = await resetPerson();
  const { cookie } = await webSignIn(p.email, p.temp);
  expect((await post("/api/auth/sign-out", {}, { cookie })).status).toBe(200);
  expect(
    (await h.fetch("/api/me", { headers: { cookie } })).status,
  ).toBe(401);
});

test("reset by link clears a pending temporary password", async () => {
  const p = await resetPerson();
  const token = await linkFor(p.email);
  expect(
    (
      await post("/api/auth/reset-password", {
        token,
        newPassword: "from-the-link-99",
      })
    ).status,
  ).toBe(200);
  const [u] =
    await h.db`select must_change_password from users where id=${p.userId}`;
  expect(u.must_change_password).toBe(false);
  expect((await webSignIn(p.email, p.temp)).res.status).toBe(401);
});
