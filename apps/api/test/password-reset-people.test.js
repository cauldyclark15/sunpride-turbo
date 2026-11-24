import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { startHarness, createUser } from "./harness.js";
import { install } from "../src/domains/org/index.js";
import { setAuthMailSender } from "../src/core/auth-email.js";
import { sha256Hex } from "../src/core/util.js";

// Real Postgres + HTTP + production People/identity hooks; mail is captured, not sent.
/** @type {import('./harness.js').Harness} */ let h;
/** @type {any[]} */ let sent = [];
/** @type {any} */ let administrator;
const password = "SP247-test-only-starting-password";
const chosenPassword = "SP247-test-only-chosen-password";

/** @param {string} path @param {any} body @param {string} [cookie] */
const post = (path, body, cookie = "") =>
  h.fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      "x-forwarded-for": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
/** @param {string} email @param {string} [secret] */
async function signIn(email, secret = password) {
  const res = await post("/api/auth/sign-in", { email, password: secret });
  return { res, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] };
}
/** @param {{ role?: string, status?: string, email?: string, login?: boolean }} [opts] */
async function person(opts = {}) {
  const email = opts.email ?? `${crypto.randomUUID()}@example.test`;
  const userId =
    opts.login === false ? null : await createUser(h, email, password);
  const [p] =
    await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,effective_from)
    values (${userId},${userId},'SP247 fixture',${email},${opts.role ?? "sales"},${opts.status ?? "active"},now()-interval '1 day') returning *`;
  await h.db`insert into employee_assignments(profile_id,role,effective_from,actor_subject,reason)
    values (${p.id},${p.role},${p.effective_from},'system:test','fixture')`;
  return { ...p, userId };
}
/** @param {any} target @param {string} [cookie] */
async function reset(target, cookie = administrator.cookie) {
  const res = await post("/api/v1/people/reset-password", target, cookie);
  expect(res.status).toBe(200);
  return /** @type {any} */ (await res.json());
}
/** @param {any} result */
async function useLink(result) {
  const token = new URL(result.resetUrl).searchParams.get("token") ?? "";
  const res = await post("/api/auth/reset-password", {
    token,
    newPassword: chosenPassword,
  });
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  h = await startHarness({
    installers: [install],
    env: { PUBLIC_WEB_URL: "http://127.0.0.1:5031" },
  });
  administrator = await person({ role: "admin" });
  administrator.cookie = (await signIn(administrator.email)).cookie;
  setAuthMailSender(async (mail) => {
    sent.push(mail);
    return { providerId: "SP247-test" };
  });
}, 60_000);
beforeEach(() => {
  sent = [];
});
afterAll(async () => {
  setAuthMailSender(null);
  await h?.close();
});

test("SP-0247 pre-provisioned invited person: create login, preserve assignment, email and copy the same usable link", async () => {
  const p = await person({ login: false });
  const [inv] =
    await h.db`insert into access_invitations(email,name,role,status,profile_id,invited_by,invited_at)
    values (${p.email},${p.name},'sales','pending',${p.id},'system:test',now()) returning id`;
  const result = await reset({ profileId: p.id });
  expect(result.emailed).toBe(true);
  expect(sent.length).toBe(1);
  expect(sent[0].text.includes(result.resetUrl)).toBe(true);
  const [linked] = await h.db`select * from profiles where id=${p.id}`;
  expect(Boolean(linked.user_id)).toBe(true);
  expect(linked.auth_subject).toBe(linked.user_id);
  expect(linked.role).toBe(p.role);
  expect(linked.status).toBe("active");
  expect(
    (
      await h.db`select count(*)::int n from employee_assignments where profile_id=${p.id}`
    )[0].n,
  ).toBe(1);
  expect(
    (await h.db`select status from access_invitations where id=${inv.id}`)[0]
      .status,
  ).toBe("accepted");
  const token = new URL(result.resetUrl).searchParams.get("token") ?? "";
  expect(
    (
      await h.db`select token_hash from password_reset_tokens where user_id=${linked.user_id}`
    )[0].token_hash === sha256Hex(token),
  ).toBe(true);
  expect(result.resetExpiresAt - Date.now()).toBeLessThanOrEqual(3_600_000);
  expect(result.resetExpiresAt - Date.now()).toBeGreaterThan(3_500_000);
  await useLink(result);
  const signed = await signIn(p.email, chosenPassword);
  expect(signed.res.status).toBe(200);
  const me = await h.fetch("/api/me", { headers: { cookie: signed.cookie } });
  expect(me.status).toBe(200);
  const body = /** @type {any} */ (await me.json());
  expect(body.profile.id).toBe(p.id);
  expect(body.mustChangePassword).toBe(false);
  const rows = JSON.stringify([
    ...(await h.db`select * from audit_logs`),
    ...(await h.db`select * from auth_email_deliveries`),
    ...(await h.db`select * from password_reset_tokens`),
  ]);
  expect(rows.includes(token)).toBe(false);
  expect(rows.includes(result.temporaryPassword)).toBe(false);
  expect(rows.includes(chosenPassword)).toBe(false);
  expect(
    (
      await post("/api/auth/reset-password", {
        token,
        newPassword: chosenPassword,
      })
    ).status,
  ).toBe(400);
});

test("SP-0247 invitation-only row creates one profile and login, including concurrent reset requests", async () => {
  const email = `${crypto.randomUUID()}@example.test`;
  const [inv] =
    await h.db`insert into access_invitations(email,name,role,status,invited_by,invited_at)
    values (${email},'Not signed up','manager','pending','system:test',now()) returning id`;
  const results = await Promise.all([
    reset({ invitationId: inv.id }),
    reset({ invitationId: inv.id }),
  ]);
  const [p] = await h.db`select * from profiles where email=${email}`;
  expect(p.role).toBe("manager");
  expect(p.status).toBe("active");
  expect(
    (await h.db`select count(*)::int n from users where email=${email}`)[0].n,
  ).toBe(1);
  expect(
    (
      await h.db`select count(*)::int n from employee_assignments where profile_id=${p.id}`
    )[0].n,
  ).toBe(1);
  const [token] =
    await h.db`select token_hash from password_reset_tokens where user_id=${p.user_id} and used_at is null`;
  const latest = results.find(
    (r) =>
      sha256Hex(new URL(r.resetUrl).searchParams.get("token") ?? "") ===
      token.token_hash,
  );
  expect(Boolean(latest)).toBe(true);
  await useLink(latest);
  const signed = await signIn(email, chosenPassword);
  expect(signed.res.status).toBe(200);
  expect(
    (await h.fetch("/api/me", { headers: { cookie: signed.cookie } })).status,
  ).toBe(200);
});

test("SP-0247 admin can reset a super admin without changing their role", async () => {
  const p = await person({ role: "super_admin" });
  const result = await reset({ profileId: p.id });
  await useLink(result);
  expect((await signIn(p.email, chosenPassword)).res.status).toBe(200);
  expect((await h.db`select role from profiles where id=${p.id}`)[0].role).toBe(
    "super_admin",
  );
});

test("SP-0247 chat and internal addresses get a usable copyable link without attempting email", async () => {
  for (const domain of ["chat-agents.sunpride.invalid", "demo.local"]) {
    const p = await person({ email: `${crypto.randomUUID()}@${domain}` });
    if (domain.startsWith("chat"))
      await h.db`insert into chat_agents(user_id,handle,display_name,created_by,token_hash)
        values (${p.userId},${crypto.randomUUID()},'SP247 chat fixture',${administrator.userId},${sha256Hex(crypto.randomUUID())})`;
    const result = await reset({ profileId: p.id });
    expect(result.emailed).toBe(false);
    expect(sent.length).toBe(0);
    await useLink(result);
    const signed = await signIn(p.email, chosenPassword);
    expect(signed.res.status).toBe(200);
    expect(
      (await h.fetch("/api/me", { headers: { cookie: signed.cookie } })).status,
    ).toBe(200);
    expect(
      (
        await h.db`select count(*)::int n from auth_email_deliveries where recipient=${p.email}`
      )[0].n,
    ).toBe(0);
  }
});

test("SP-0247 disabled profiles and disabled users can reset, but neither reset nor the link restores access", async () => {
  for (const disabled of ["profile", "user", "unlinked"]) {
    const p = await person({
      status: disabled === "user" ? "active" : "disabled",
      login: disabled !== "unlinked",
    });
    if (disabled === "user")
      await h.db`update users set disabled_at=now() where id=${p.userId}`;
    const result = await reset({ profileId: p.id });
    expect(result.accessDisabled).toBe(true);
    await useLink(result);
    const [after] =
      await h.db`select p.status,u.disabled_at from profiles p join users u on u.id=p.user_id where p.id=${p.id}`;
    expect(after.status).toBe(p.status);
    if (disabled !== "profile") expect(after.disabled_at).not.toBeNull();
    const signed = await signIn(p.email, chosenPassword);
    if (disabled === "profile") {
      expect(signed.res.status).toBe(200);
      const me = await h.fetch("/api/me", {
        headers: { cookie: signed.cookie },
      });
      expect(me.status).toBe(200);
      const body = /** @type {any} */ (await me.json());
      expect(body.profile).toBeNull();
      expect(body.capabilities).toEqual([]);
      expect(body.access).toBe("turned_off");
    } else expect(signed.res.status).toBe(401);
  }
});

test("SP-0247 revoked invitations remain revoked and any created login stays disabled", async () => {
  const email = `${crypto.randomUUID()}@example.test`;
  const [inv] =
    await h.db`insert into access_invitations(email,role,status,invited_by,invited_at)
    values (${email},'sales','revoked','system:test',now()) returning id`;
  const result = await reset({ invitationId: inv.id });
  expect(result.accessDisabled).toBe(true);
  await useLink(result);
  expect((await signIn(email, chosenPassword)).res.status).toBe(401);
  expect(
    (await h.db`select status from access_invitations where id=${inv.id}`)[0]
      .status,
  ).toBe("revoked");
});

test("SP-0247 own row returns a usable link and revokes the previous session", async () => {
  const a = await person({ role: "admin" });
  const { cookie } = await signIn(a.email);
  const result = await reset({ profileId: a.id }, cookie);
  expect(result.selfReset).toBe(true);
  expect((await h.fetch("/api/me", { headers: { cookie } })).status).toBe(401);
  await useLink(result);
  expect((await signIn(a.email, chosenPassword)).res.status).toBe(200);
});

test("SP-0247 manager refusal and missing/invalid selections leave no credentials or login", async () => {
  const p = await person({ login: false });
  const manager = await person({ role: "manager" });
  const { cookie } = await signIn(manager.email);
  expect(
    (await post("/api/v1/people/reset-password", { profileId: p.id }, cookie))
      .status,
  ).toBe(403);
  for (const target of [
    {},
    { profileId: "bad" },
    { invitationId: "bad" },
    { profileId: p.id, userId: manager.userId },
  ]) {
    expect(
      (
        await post(
          "/api/v1/people/reset-password",
          target,
          administrator.cookie,
        )
      ).status,
    ).toBe(400);
  }
  expect(
    (
      await post(
        "/api/v1/people/reset-password",
        { profileId: crypto.randomUUID() },
        administrator.cookie,
      )
    ).status,
  ).toBe(404);
  expect(
    (await h.db`select count(*)::int n from users where email=${p.email}`)[0].n,
  ).toBe(0);
  expect(sent.length).toBe(0);
});
