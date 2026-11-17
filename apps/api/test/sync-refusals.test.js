// SP-0188: every op the server permanently refuses is kept for the office (op_refusals) before the
// phone is answered, and the result says `kept: true`; a resend never duplicates the row; temporary
// refusals keep nothing. The office list ("Phone saves for the office") is admin-only.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { OpRejected, registerOp } from "../src/core/sync.js";
import {
  boundDevice,
  profileStore,
  signedPost,
  startHarness,
} from "./harness.js";

/** @type {import('./harness.js').Harness} */
let h;
/** @type {ReturnType<typeof profileStore>} */
let profiles;

beforeAll(async () => {
  h = await startHarness({ port: Number(process.env.SP_TEST_PORT) || 5053 });
  profiles = profileStore(h);
  registerOp("test.keep", async (ctx) => {
    if (ctx.payload.refuse) ctx.reject(String(ctx.payload.refuse));
    if (ctx.payload.later) throw new OpRejected("places_unavailable", true);
    return { entityId: null };
  });
});
afterAll(async () => {
  await h?.close();
});

/** @param {any} d @param {any[]} operations */
const push = (d, operations) =>
  signedPost(
    h,
    { access: d.access, deviceId: d.deviceId, key: d.key },
    "/api/sync/push",
    {
      version: 2,
      app: d.app,
      deviceId: d.deviceId,
      scopeId: d.profile.orgUnitId,
      operations,
    },
  );
/** @param {Record<string, unknown>} payload @param {string} [clientOpId] */
const op = (payload, clientOpId = crypto.randomUUID()) => ({
  clientOpId,
  opType: "test.keep",
  clientTime: 1792368000000,
  dependsOn: [],
  payload,
});
/** @param {string} id */
const rows = async (id) =>
  await h.db`select * from op_refusals where client_op_id=${id}`;

test("a permanent OpRejected is kept once with kept:true; a resend does not duplicate it", async () => {
  const d = await boundDevice(h, profiles);
  const o = op({ refuse: "out_of_scope", customerName: "Aling Nena" });
  const r1 = await push(d, [o]);
  expect(r1.res.status).toBe(200);
  expect(r1.body.results[0]).toMatchObject({
    status: "rejected",
    code: "out_of_scope",
    retryable: false,
    kept: true,
  });
  const r2 = await push(d, [o]);
  expect(r2.body.results[0]).toMatchObject({ status: "rejected", kept: true });
  const kept = await rows(o.clientOpId);
  expect(kept.length).toBe(1);
  expect(kept[0]).toMatchObject({
    subject: d.userId,
    profile_id: d.profile.id,
    device_id: d.deviceId,
    app: "field-android",
    op_type: "test.keep",
    code: "out_of_scope",
    resolved_at: null,
  });
  const payload =
    typeof kept[0].payload === "string"
      ? JSON.parse(kept[0].payload)
      : kept[0].payload;
  expect(payload).toEqual(o);
});

test("a malformed op (validOperation failure) and an unknown op type are kept", async () => {
  const d = await boundDevice(h, profiles);
  const bad = { ...op({ a: 1 }), clientTime: -1 };
  const unknown = { ...op({ a: 2 }), opType: "nothing.here" };
  const r = await push(d, [bad, unknown]);
  expect(r.body.results[0]).toMatchObject({
    status: "rejected",
    code: "invalid_request",
    kept: true,
  });
  expect(r.body.results[1]).toMatchObject({
    status: "rejected",
    code: "unsupported_operation",
    kept: true,
  });
  await push(d, [bad]);
  expect((await rows(bad.clientOpId)).length).toBe(1);
  expect((await rows(unknown.clientOpId)).length).toBe(1);
});

test("applied ops and temporary (retryable) refusals keep nothing and carry no kept flag", async () => {
  const d = await boundDevice(h, profiles);
  const ok = op({});
  const later = op({ later: true });
  const r = await push(d, [ok, later]);
  expect(r.body.results[0]).toMatchObject({ status: "applied" });
  expect(r.body.results[0].kept).toBeUndefined();
  expect(r.body.results[1]).toMatchObject({
    status: "rejected",
    code: "places_unavailable",
    retryable: true,
  });
  expect(r.body.results[1].kept).toBeUndefined();
  expect((await rows(ok.clientOpId)).length).toBe(0);
  expect((await rows(later.clientOpId)).length).toBe(0);
});

/** @param {string} role */
async function office(role) {
  const email = `o${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "correct horse battery";
  const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
  const [u] =
    await h.db`insert into users (email, password_hash) values (${email}, ${hash}) returning id`;
  profiles.set(u.id, { role, orgUnitId: null, name: `Office ${role}` });
  const res = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  /** @param {string} path @param {any} [body] */
  return async (path, body) => {
    const r = await h.fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: /** @type {any} */ (await r.json()) };
  };
}

test("office list: admins see plain words and mark Done; salesmen cannot", async () => {
  const d = await boundDevice(h, profiles);
  const o = {
    ...op({ refuse: "stock_conflict", note: "kept" }),
    opType: "census.capture",
  };
  registerOp("census.capture", (ctx) => ctx.reject("out_of_scope"));
  const r = await push(d, [o]);
  expect(r.body.results[0]).toMatchObject({ status: "rejected", kept: true });

  const sales = await office("sales");
  expect((await sales("/api/v1/phone-saves")).status).toBe(403);

  const admin = await office("super_admin");
  const list = await admin("/api/v1/phone-saves");
  expect(list.status).toBe(200);
  const mine = list.body.rows.find(
    (/** @type {any} */ x) => x.opType === "census.capture",
  );
  expect(mine).toMatchObject({
    what: "New customer",
    why: "This store or work is not assigned to this salesman",
    app: "Field app",
    resolvedAt: null,
  });
  const detail = await admin(`/api/v1/phone-saves/${mine.id}`);
  expect(detail.status).toBe(200);
  expect(detail.body.values).toEqual(o.payload);
  expect(
    (await sales(`/api/v1/phone-saves/${mine.id}/done`, {})).status,
  ).toBe(403);
  const done = await admin(`/api/v1/phone-saves/${mine.id}/done`, {
    note: "Added by the office",
  });
  expect(done.status).toBe(200);
  expect(done.body.resolvedAt).toEqual(expect.any(Number));
  expect(done.body.note).toBe("Added by the office");
  const open = await admin("/api/v1/phone-saves");
  expect(
    open.body.rows.some((/** @type {any} */ x) => x.id === mine.id),
  ).toBe(false);
  const all = await admin("/api/v1/phone-saves?show=all");
  expect(all.body.rows.some((/** @type {any} */ x) => x.id === mine.id)).toBe(
    true,
  );
});
