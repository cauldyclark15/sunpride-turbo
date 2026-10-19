import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createUser,
  nativeSignIn,
  profileStore,
  startHarness,
} from "./harness.js";
import { SIGNIN_POLICY } from "../src/core/rate.js";

/** @type {import('./harness.js').Harness} */
let h;
/** @type {ReturnType<typeof profileStore>} */
let profiles;
beforeAll(async () => {
  h = await startHarness({ installers: [] });
  profiles = profileStore(h);
});
afterAll(async () => {
  await h?.close();
});

const oldPassword = "initial-test-secret";
const newPassword = "replacement-test-secret";
/** @param {string} path @param {any} body @param {Record<string,string>} [headers] */
const post = (path, body, headers = {}) =>
  h.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
/** @param {Response} res */
const cookieOf = (res) => (res.headers.get("set-cookie") ?? "").split(";")[0];
async function fixture() {
  const email = `${crypto.randomUUID()}@example.test`;
  const userId = await createUser(h, email, oldPassword);
  profiles.set(userId, { role: "viewer" });
  const signIn = await post("/api/auth/sign-in", {
    email,
    password: oldPassword,
  });
  return { email, userId, cookie: cookieOf(signIn) };
}
/** @param {string} cookie @param {any} [body] */
const change = (cookie, body = { currentPassword: oldPassword, newPassword }) =>
  post("/api/auth/change-password", body, { cookie });

test("changes the hash, rejects old sign-in, accepts new sign-in and audits without secrets", async () => {
  const f = await fixture();
  const res = await change(f.cookie);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(
    (await post("/api/auth/sign-in", { email: f.email, password: oldPassword }))
      .status,
  ).toBe(401);
  expect(
    (await post("/api/auth/sign-in", { email: f.email, password: newPassword }))
      .status,
  ).toBe(200);
  const [stored] =
    await h.db`select password_hash from users where id=${f.userId}`;
  expect(String(stored.password_hash).startsWith("$argon2id$")).toBe(true);
  const rows =
    await h.db`select * from audit_logs where subject=${f.userId} and action='auth.password_changed'`;
  expect(rows.length).toBe(1);
  expect(JSON.stringify(rows).includes(newPassword)).toBe(false);
});

test("revokes other web sessions, native access and refresh; keeps current and other users", async () => {
  const f = await fixture();
  const other = cookieOf(
    await post("/api/auth/sign-in", { email: f.email, password: oldPassword }),
  );
  const native = await nativeSignIn(h, f.email, oldPassword);
  const unrelated = await fixture();
  expect((await change(f.cookie)).status).toBe(200);
  expect(
    (await h.fetch("/api/me", { headers: { cookie: f.cookie } })).status,
  ).toBe(200);
  expect(
    (await h.fetch("/api/me", { headers: { cookie: other } })).status,
  ).toBe(401);
  expect(
    (
      await h.fetch("/api/me", {
        headers: { authorization: `Bearer ${native.body.accessToken}` },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await post(
        "/api/auth/refresh",
        { version: 2, app: "field-android" },
        { authorization: `Bearer ${native.body.sessionToken}` },
      )
    ).status,
  ).toBe(401);
  expect(
    (await h.fetch("/api/me", { headers: { cookie: unrelated.cookie } }))
      .status,
  ).toBe(200);
  const [tokens] =
    await h.db`select count(*)::int n from access_tokens a join sessions s on s.id=a.session_id where s.user_id=${f.userId}`;
  expect(tokens.n).toBe(0);
});

for (const [label, body, code] of [
  [
    "wrong current password",
    { currentPassword: "incorrect", newPassword },
    "wrong_password",
  ],
  [
    "weak password",
    { currentPassword: oldPassword, newPassword: "short" },
    "weak_password",
  ],
  [
    "overlong password",
    { currentPassword: oldPassword, newPassword: "a".repeat(129) },
    "weak_password",
  ],
  [
    "same password",
    { currentPassword: oldPassword, newPassword: oldPassword },
    "same_password",
  ],
  ["missing password", { currentPassword: oldPassword }, "weak_password"],
])
  test(String(label), async () => {
    const f = await fixture();
    const res = await change(f.cookie, body);
    expect(res.status).toBe(422);
    const data = /** @type {any} */ (await res.json());
    expect(data.error.code).toBe(code);
    expect(data.error.retryable).toBe(false);
    expect(
      (
        await post("/api/auth/sign-in", {
          email: f.email,
          password: oldPassword,
        })
      ).status,
    ).toBe(200);
  });

test("not signed in", async () => {
  const res = await change("");
  expect(res.status).toBe(401);
  expect(/** @type {any} */ (await res.json()).error.code).toBe(
    "unauthenticated",
  );
});

test("native access bearer keeps its access and refresh session while revoking the web session", async () => {
  const f = await fixture();
  const { body } = await nativeSignIn(h, f.email, oldPassword);
  const res = await post(
    "/api/auth/change-password",
    { currentPassword: oldPassword, newPassword },
    { authorization: `Bearer ${body.accessToken}` },
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(
    (
      await h.fetch("/api/me", {
        headers: { authorization: `Bearer ${body.accessToken}` },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await post(
        "/api/auth/refresh",
        { version: 2, app: "field-android" },
        { authorization: `Bearer ${body.sessionToken}` },
      )
    ).status,
  ).toBe(200);
  expect(
    (await h.fetch("/api/me", { headers: { cookie: f.cookie } })).status,
  ).toBe(401);
});

test("rate limit reserves attempts before verification and persists refused attempts", async () => {
  const f = await fixture();
  await h.db`insert into rate_limits(bucket_key,window_start,count) values (${`change-password:${f.userId}`},now(),${SIGNIN_POLICY.limit})`;
  const res = await change(f.cookie);
  expect(res.status).toBe(429);
  expect(/** @type {any} */ (await res.json()).error.code).toBe("rate_limited");
  const [row] =
    await h.db`select count from rate_limits where bucket_key=${`change-password:${f.userId}`}`;
  expect(row.count).toBe(SIGNIN_POLICY.limit + 1);
});

test("concurrent changes with the old password allow only one success", async () => {
  const f = await fixture();
  const res = await Promise.all([change(f.cookie), change(f.cookie)]);
  expect(res.map((r) => r.status).sort()).toEqual([200, 422]);
});
