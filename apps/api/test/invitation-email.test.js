import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createDb } from "@sunpride/db/client";
import { startHarness } from "./harness.js";
import { install } from "../src/domains/org/index.js";
import { setAuthMailSender } from "../src/core/auth-email.js";
import { invitationMail } from "../src/domains/org/invitation-email.js";

/** SP-0206: real HTTP handlers and PostgreSQL; only the email transport is captured.
 * No email is sent to a real person and no Google Play membership is changed. */
/** @type {import('./harness.js').Harness} */ let h;
/** @type {import('@sunpride/db/client').Db} */ let reader;
/** @type {string} */ let boss;
/** @type {string} */ let nationalAdmin;
/** @type {string} */ let scopedAdmin;
/** @type {string} */ let salesperson;
/** @type {import('../src/core/auth-email.js').AuthMail[]} */ let sent = [];
let failMail = false;
const password = "invitation-test-only-password";
/** @param {Response} r */
const cookieOf = (r) => (r.headers.get("set-cookie") ?? "").split(";")[0];
/** @param {string} path @param {any} body @param {string} [cookie] @param {string} [key] */
async function post(path, body, cookie = boss, key) {
  const res = await h.fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: cookie ?? "",
      ...(key ? { "idempotency-key": key } : {}),
    },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: /** @type {any} */ (await res.json()),
    cookie: cookieOf(res),
  };
}
/** @param {string} role @param {string} unit */
async function person(role, unit) {
  const email = `${crypto.randomUUID()}@example.test`;
  const [user] =
    await h.db`insert into users(email,password_hash) values(${email},${await Bun.password.hash(password)}) returning id`;
  const [p] =
    await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id,effective_from) values(${user.id},${user.id},'Fixture',${email},${role},'active',${unit},now()-interval '1 day') returning id`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},${role},now()-interval '1 day','test','fixture')`;
  return (await post("/api/auth/sign-in", { email, password }, "")).cookie;
}
/** @param {string} email @param {any} [extra] @param {string} [key] */
const invite = (email, extra = {}, key) =>
  post(
    "/api/v1/people/invite",
    { email, name: "Sample person", role: "sales", ...extra },
    boss,
    key,
  );
/** @param {string} id @param {string} [cookie] */
const resend = (id, cookie = boss) =>
  post("/api/v1/people/resend-invitation", { invitationId: id }, cookie);
/** @param {string} id */
async function age(id) {
  await h.db`update access_invitations set email_attempted_at=now()-interval '2 minutes' where id=${id}`;
}
function capture() {
  setAuthMailSender(async (mail) => {
    // A separate connection sees the invitation: its creation really committed before transport.
    const [persisted] =
      await reader`select id from access_invitations where email=${mail.to}`;
    expect(persisted).toBeDefined();
    if (failMail) throw new Error("test provider unavailable");
    sent.push(mail);
    return { providerId: "captured-not-real-delivery" };
  });
}
beforeAll(async () => {
  h = await startHarness({
    installers: [install],
    env: {
      PUBLIC_WEB_URL: "https://invitation.example.test",
      AUTH_EMAIL_PROVIDER: "dev_sink",
    },
  });
  reader = createDb(h.dbUrl, { max: 1 });
  await h.db`insert into users(email,password_hash) values('boss@example.com',${await Bun.password.hash(password)})`;
  boss = (
    await post("/api/auth/sign-in", { email: "boss@example.com", password }, "")
  ).cookie;
  const me = /** @type {any} */ (
    await (await h.fetch("/api/me", { headers: { cookie: boss } })).json()
  );
  const root = me.profile.orgUnitId;
  await h.db`update org_units set effective_from=now()-interval '2 days' where id=${root}`;
  const [region] =
    await h.db`insert into org_units(organization_id,code,name,type_code,parent_id,status,effective_from) values('sunpride','INVITE-REGION','Fixture region','REGION',${root},'active',now()-interval '1 day') returning id`;
  nationalAdmin = await person("admin", root);
  scopedAdmin = await person("admin", region.id);
  salesperson = await person("sales", region.id);
}, 30000);
beforeEach(() => {
  sent = [];
  failMail = false;
  capture();
});
afterAll(async () => {
  setAuthMailSender(null);
  await reader?.close();
  await h?.close();
});

test("corrected email gets its own invitation and instructions after commit; request replay sends once", async () => {
  const wrong = await invite("wrong-address@example.test");
  expect(wrong.status).toBe(200);
  const right = await invite(
    "  CORRECTED-ADDRESS@example.test  ",
    {},
    "corrected-request",
  );
  expect(right.status).toBe(200);
  expect(right.body.emailState).toBe("accepted");
  expect(right.body.invitationId).not.toBe(wrong.body.invitationId);
  expect(sent.map((m) => m.to)).toEqual([
    "wrong-address@example.test",
    "corrected-address@example.test",
  ]);
  const mail = sent[1];
  expect(mail.kind).toBe("invitation");
  expect(mail.text).toContain("https://invitation.example.test/login");
  expect(mail.text).toContain("Create account");
  expect(mail.text).toContain("at least 8 characters");
  expect(mail.text).toContain("Google Play testing access is separate");
  expect(mail.text).toContain("Never uninstall first");
  const replay = await invite(
    "  CORRECTED-ADDRESS@example.test  ",
    {},
    "corrected-request",
  );
  expect(replay.body).toEqual(right.body);
  expect(sent).toHaveLength(2);
  const [delivery] =
    await h.db`select kind,state,provider_id from auth_email_deliveries where recipient='corrected-address@example.test'`;
  expect(delivery).toEqual({
    kind: "invitation",
    state: "accepted",
    provider_id: "captured-not-real-delivery",
  });
  const list = /** @type {any} */ (
    await (
      await h.fetch("/api/v1/people/invitations/list?q=corrected-address", {
        headers: { cookie: boss },
      })
    ).json()
  );
  expect(list.page[0].emailState).toBe("accepted");
  expect(list.page[0].status).toBe("pending");
  const signup = await post(
    "/api/auth/sign-up",
    { email: "corrected-address@example.test", password },
    "",
  );
  expect(signup.status).toBe(201);
  const me = await h.fetch("/api/me", { headers: { cookie: signup.cookie } });
  expect(me.status).toBe(200);
  const [accepted] =
    await h.db`select status from access_invitations where id=${right.body.invitationId}`;
  expect(accepted.status).toBe("accepted");
  expect((await resend(right.body.invitationId)).status).toBe(422);
});

test("provider failure keeps the person, records failure, and allows a bounded explicit retry", async () => {
  failMail = true;
  const result = await invite("failed-send@example.test");
  expect(result.status).toBe(200);
  expect(result.body.emailState).toBe("failed");
  const [saved] =
    await h.db`select status,email_state from access_invitations where id=${result.body.invitationId}`;
  expect(saved).toEqual({ status: "pending", email_state: "failed" });
  expect((await resend(result.body.invitationId)).status).toBe(429);
  await age(result.body.invitationId);
  failMail = false;
  const results = await Promise.all([
    resend(result.body.invitationId),
    resend(result.body.invitationId),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 429]);
  expect(sent).toHaveLength(1);
  const [delivery] =
    await h.db`select email_state from access_invitations where id=${result.body.invitationId}`;
  expect(delivery.email_state).toBe("accepted");
  const attempts =
    await h.db`select state from auth_email_deliveries where recipient='failed-send@example.test' order by created_at`;
  expect(attempts.map((/** @type {any} */ r) => r.state)).toEqual([
    "failed",
    "accepted",
  ]);
});

test("pre-existing waiting invitations can be resent without changing their email, role or unit", async () => {
  const [old] =
    await h.db`insert into access_invitations(email,name,role,status,invited_by,invited_at) values('old-invitation@example.test','Old person','manager','pending','fixture',now()-interval '1 day') returning id`;
  const result = await post(
    "/api/v1/people/resend-invitation",
    { invitationId: old.id, email: "other@example.test", role: "admin" },
    nationalAdmin,
  );
  expect(result.status).toBe(200);
  expect(sent[0].to).toBe("old-invitation@example.test");
  const [same] =
    await h.db`select email,role,org_unit_id from access_invitations where id=${old.id}`;
  expect(same).toEqual({
    email: "old-invitation@example.test",
    role: "manager",
    org_unit_id: null,
  });
});

test("resend denies scoped admins, salespeople, anonymous callers and protected administrator invitations", async () => {
  const result = await invite("protected-send@example.test");
  await age(result.body.invitationId);
  for (const cookie of [scopedAdmin, salesperson, ""])
    expect([401, 403]).toContain(
      (await resend(result.body.invitationId, cookie)).status,
    );
  const adminInvite = await invite("new-admin@example.test", { role: "admin" });
  await age(adminInvite.body.invitationId);
  expect(
    (await resend(adminInvite.body.invitationId, nationalAdmin)).status,
  ).toBe(403);
  expect(sent).toHaveLength(2);
});

test("revoked invitation and rejected Add person never send mail", async () => {
  const result = await invite("revoked-send@example.test");
  expect(
    (
      await post("/api/v1/people/revoke", {
        invitationId: result.body.invitationId,
      })
    ).status,
  ).toBe(200);
  expect((await resend(result.body.invitationId)).status).toBe(422);
  expect(
    (await invite("bad-unit@example.test", { orgUnitId: crypto.randomUUID() }))
      .status,
  ).not.toBe(200);
  expect(sent).toHaveLength(1);
});

test("dev sink and missing provider key never masquerade as a sent invitation", async () => {
  setAuthMailSender(null);
  const local = await invite("local-preview@example.test");
  expect(local.body.emailState).toBe("dev_sink");
  h.env.AUTH_EMAIL_PROVIDER = "resend";
  const missing = await invite("missing-provider-key@example.test");
  expect(missing.body.emailState).toBe("failed");
  h.env.AUTH_EMAIL_PROVIDER = "dev_sink";
});

test("existing logins receive sign-in instructions; office-only roles get no Field app requirement", () => {
  const existing = invitationMail(
    { email: "existing@example.test", role: "sales" },
    "https://web.example.test",
    true,
  );
  expect(existing.text).toContain("existing password");
  expect(existing.text).not.toContain("choose Create account");
  const office = invitationMail(
    { email: "office@example.test", role: "viewer" },
    "https://web.example.test",
    false,
  );
  expect(office.text).toContain("Create account");
  expect(office.text).not.toContain("play.google.com");
});
