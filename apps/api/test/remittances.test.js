// SP-0228: cash remittance from the Field app with a receipt photo; Finance confirms or rejects.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { encode } from "jpeg-js";
import {
  startHarness,
  createUser,
  deviceKey,
  registerDevice,
  nativeSignIn,
  bind,
  signedPost,
} from "./harness.js";
import { install as remittances } from "../src/domains/remittances/index.js";
import { identityHooks } from "../src/domains/org/identity.js";
import { setHooks } from "../src/core/hooks.js";
import { sha256Hex } from "../src/core/util.js";

/** @type {import("./harness.js").Harness} */ let h;
/** @type {any} */ let root;
/** @type {any} */ let north;
/** @type {any} */ let south;
/** @type {any} */ let finance;
/** @type {any} */ let managerNorth;
/** @type {any} */ let managerSouth;
/** @type {any} */ let sellerNorth;
/** @type {any} */ let sellerSouth;
/** @type {any} */ let noSell;
const password = "fixture-only-not-a-client-password";

function receipt(seed = 1) {
  const width = 64,
    height = 64,
    data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = (i * seed) % 255;
    data[i + 1] = 120;
    data[i + 2] = 200;
    data[i + 3] = 255;
  }
  const bytes = Buffer.from(encode({ data, width, height }, 80).data);
  return {
    mimeType: "image/jpeg",
    bytesBase64: bytes.toString("base64"),
    sha256: sha256Hex(bytes),
  };
}

/** @param {string} code @param {any} parent */
async function unit(code, parent) {
  const [u] =
    await h.db`insert into org_units(organization_id,code,name,type_code,parent_id,status,effective_from) values ('sunpride',${code},${`Sample ${code}`},${parent ? "branch" : "company"},${parent?.id ?? null},'active','2020-01-01') returning *`;
  return u;
}

/** @param {string} name @param {string} role @param {any} u @param {{selling?: boolean, device?: boolean}} [o] */
async function person(name, role, u, o = {}) {
  const email = `${name.toLowerCase()}-${crypto.randomUUID().slice(0, 6)}@example.test`;
  const userId = await createUser(h, email, password);
  const [p] =
    await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id,selling) values (${userId},${userId},${name},${email},${role},'active',${u.id},${o.selling ?? false}) returning *`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values (${p.id},${u.id},${role},'2020-01-01',${userId},'SP-0228 sample fixture')`;
  const token = `sps_${crypto.randomUUID().replaceAll("-", "")}`;
  await h.db`insert into sessions(token_hash,user_id,app,expires_at) values (${new Bun.CryptoHasher("sha256").update(token).digest("hex")},${userId},'web',${new Date(Date.now() + 86400000)})`;
  /** @type {any} */
  const who = { ...p, email, cookie: `sp_session=${token}`, unit: u };
  if (o.device) {
    const key = await deviceKey(),
      deviceId = await registerDevice(h, {
        profileId: p.id,
        orgUnitId: u.id,
        key,
        app: "field-android",
      });
    await h.db`insert into device_integrity_assessments(device_id,rooted,tampered,source,observed_at,expires_at,evidence) values (${deviceId},false,false,'android-self-report',now(),now()+interval '1 day',${{ verified: false }})`;
    const { body: tokens } = await nativeSignIn(
      h,
      email,
      password,
      "field-android",
      { keyId: key.keyId, publicKeySpki: key.publicKeySpki },
    );
    expect(typeof tokens.accessToken, JSON.stringify(tokens)).toBe("string");
    const b = await bind(h, tokens.accessToken, deviceId, key);
    expect(b.body.bindingStatus, JSON.stringify(b.body)).toBe("bound");
    who.native = { access: tokens.accessToken, deviceId, key };
  }
  return who;
}

/** @param {any} who @param {any} payload @param {string} [clientOpId] */
async function push(who, payload, clientOpId = crypto.randomUUID()) {
  const r = await signedPost(h, who.native, "/api/sync/push", {
    version: 2,
    app: "field-android",
    deviceId: who.native.deviceId,
    scopeId: who.unit.id,
    operations: [
      {
        clientOpId,
        opType: "remittance.submit",
        clientTime: payload.deviceTime,
        dependsOn: [],
        payload,
      },
    ],
  });
  expect(r.res.status, JSON.stringify(r.body)).toBe(200);
  return r.body.results[0];
}

/** @param {any} over */
const remit = (over = {}) => ({
  remittanceId: crypto.randomUUID(),
  amountMinor: 5_000_000,
  channel: "palawan",
  referenceNumber: "007-123-456",
  remittedAt: Date.now() - 3600_000,
  note: "Tuesday sales",
  photo: receipt(),
  deviceTime: Date.now(),
  ...over,
});

/** @param {any} who @param {string} path @param {any} [body] */
async function web(who, path, body) {
  const res = await h.fetch(`/api/v1/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie: who.cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const type = res.headers.get("content-type") ?? "";
  return {
    status: res.status,
    type,
    data: type.includes("json") ? await res.json() : await res.arrayBuffer(),
  };
}

beforeAll(async () => {
  h = await startHarness({
    installers: [remittances, () => setHooks(identityHooks({}))],
  });
  root = await unit("SUNPRIDE", null);
  north = await unit("N228", root);
  south = await unit("S228", root);
  finance = await person("Finance228", "approver", root);
  managerNorth = await person("ManagerN228", "manager", north);
  managerSouth = await person("ManagerS228", "manager", south);
  sellerNorth = await person("SellerN228", "sales", north, {
    selling: true,
    device: true,
  });
  sellerSouth = await person("SellerS228", "sales", south, {
    selling: true,
    device: true,
  });
  noSell = await person("Mapper228", "sales", north, { device: true });
}, 60000);
afterAll(async () => {
  await h?.close();
});

/** @type {any} */ let first;

test("a salesman's remittance is stored with branch, photo and audit; a retry creates nothing new", async () => {
  first = remit();
  const opId = crypto.randomUUID();
  const r = await push(sellerNorth, first, opId);
  expect(r.status, JSON.stringify(r)).toBe("applied");
  expect(r.ack.entityId).toBe(first.remittanceId);
  const [row] =
    await h.db`select * from field_cash_remittances where id=${first.remittanceId}`;
  expect(row.org_unit_id).toBe(north.id);
  expect(row.salesman_profile_id).toBe(sellerNorth.id);
  expect(Number(row.amount_minor)).toBe(5_000_000);
  expect(row.reference_number).toBe("007-123-456");
  expect(row.status).toBe("submitted");
  const [file] = await h.db`select * from files where id=${row.photo_file_id}`;
  expect(file.status).toBe("stored");
  expect(file.purpose).toBe("remittance-receipt");
  const audit =
    await h.db`select action from audit_logs where entity_id=${first.remittanceId}`;
  expect(audit.map((/** @type {any} */ a) => a.action)).toEqual([
    "remittance.submitted",
  ]);
  // Same op again: duplicate. Same remittance under a new op id: same record.
  expect((await push(sellerNorth, first, opId)).status).toBe("duplicate");
  expect((await push(sellerNorth, first)).status).toBe("applied");
  const changed = await push(sellerNorth, { ...first, amountMinor: 1 });
  expect(changed.status).toBe("rejected");
  expect(changed.code).toBe("idempotency_conflict");
  const [{ n }] =
    await h.db`select count(*)::int n from field_cash_remittances where id=${first.remittanceId}`;
  expect(n).toBe(1);
});

test("missing photo, bad amount and 'other' without a name are refused; a salesman with Selling off can remit (loosened, jc)", async () => {
  for (const bad of [
    remit({ photo: null }),
    remit({ amountMinor: 0 }),
    remit({ amountMinor: 12.5 }),
    remit({ channel: "other" }),
    remit({ channel: "western" }),
    remit({ referenceNumber: " " }),
    remit({ photo: { ...receipt(), sha256: "0".repeat(64) } }),
  ]) {
    const r = await push(sellerNorth, bad);
    expect(r.status, JSON.stringify(bad.channel)).toBe("rejected");
    expect(r.code).toBe("invalid_request");
  }
  const other = await push(
    sellerNorth,
    remit({ channel: "other", channelOther: "M Lhuillier" }),
  );
  expect(other.status).toBe("applied");
  // Loosened (jc): Truck selling no longer gates cash remittance.
  const off = await push(noSell, remit());
  expect(off.status).toBe("applied");
});

test("scope (loosened, jc): managers and Finance see every branch; sales cannot open the list", async () => {
  const south1 = remit({ channel: "gcash", referenceNumber: "GC-1" });
  expect((await push(sellerSouth, south1)).status).toBe("applied");
  const all = await web(finance, "remittances");
  expect(all.status, JSON.stringify(all.data)).toBe(200);
  expect(all.data.canReview).toBe(true);
  expect(all.data.items.length).toBe(4);
  const n = await web(managerNorth, "remittances");
  expect(n.data.items.length).toBe(4);
  expect(n.data.canReview).toBe(false);
  const s = await web(managerSouth, "remittances");
  expect(s.data.items.map((/** @type {any} */ i) => i.id)).toContain(
    south1.remittanceId,
  );
  const northOnly = await web(managerSouth, `remittances?unit=${north.id}`);
  expect(northOnly.status).toBe(200);
  expect(
    northOnly.data.items.every((/** @type {any} */ i) => i.branch === "Sample N228"),
  ).toBe(true);
  // Filters.
  const filtered = await web(
    finance,
    `remittances?salesman=${sellerSouth.id}&status=submitted`,
  );
  expect(filtered.data.items.length).toBe(1);
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  expect(
    (await web(finance, `remittances?from=2020-01-01&to=2020-01-02`)).data
      .items.length,
  ).toBe(0);
  expect(
    (await web(finance, `remittances?from=${today}&to=${today}`)).data.items
      .length,
  ).toBeGreaterThan(0);
  // Receipt photo.
  const photo = await web(finance, `remittances/${first.remittanceId}/receipt`);
  expect(photo.status).toBe(200);
  expect(photo.type).toBe("image/jpeg");
  expect(
    (await web(managerSouth, `remittances/${first.remittanceId}/receipt`))
      .status,
  ).toBe(200);
  // Sales cannot open the Finance list.
  expect((await web(sellerNorth, "remittances")).status).toBe(403);
});

test("Finance confirms or rejects with a reason, once; managers and out-of-scope people cannot", async () => {
  expect(
    (await web(managerNorth, `remittances/${first.remittanceId}/confirm`, {}))
      .status,
  ).toBe(403);
  const ok = await web(finance, `remittances/${first.remittanceId}/confirm`, {});
  expect(ok.status, JSON.stringify(ok.data)).toBe(200);
  expect(ok.data.status).toBe("confirmed");
  // Repeat is a no-op; a different decision afterwards is refused.
  expect(
    (await web(finance, `remittances/${first.remittanceId}/confirm`, {})).data
      .status,
  ).toBe("confirmed");
  expect(
    (
      await web(finance, `remittances/${first.remittanceId}/reject`, {
        reason: "Wrong amount",
      })
    ).status,
  ).toBe(400);
  const [south1] =
    await h.db`select id from field_cash_remittances where org_unit_id=${south.id}`;
  // Loosened (jc): the reject reason is optional; a blank one is stored as "No reason given".
  const no = await web(finance, `remittances/${south1.id}/reject`, {});
  expect(no.status, JSON.stringify(no.data)).toBe(200);
  const list = await web(finance, `remittances?status=rejected`);
  expect(list.data.items[0].rejectReason).toBe("No reason given");
  expect(list.data.items[0].reviewedBy).toBe("Finance228");
  const audit =
    await h.db`select action from audit_logs where entity_id in (${first.remittanceId},${south1.id}) order by created_at`;
  expect(audit.map((/** @type {any} */ a) => a.action)).toEqual(
    expect.arrayContaining(["remittance.confirmed", "remittance.rejected"]),
  );
  // A changed remittance after review cannot slip in under the same id.
  expect((await push(sellerNorth, first)).status).toBe("applied");
  const [row] =
    await h.db`select status from field_cash_remittances where id=${first.remittanceId}`;
  expect(row.status).toBe("confirmed");
});

test("loosened (jc): a branch Administrator reviews any branch's remittance (no Finance test account)", async () => {
  const branchAdmin = await person("Admin228", "admin", north);
  const fresh = remit({ channel: "cebuana", referenceNumber: "CB-9" });
  expect((await push(sellerSouth, fresh)).status).toBe("applied");
  const list = await web(branchAdmin, "remittances");
  expect(list.status).toBe(200);
  expect(list.data.canReview).toBe(true);
  const ok = await web(branchAdmin, `remittances/${fresh.remittanceId}/confirm`, {});
  expect(ok.status, JSON.stringify(ok.data)).toBe(200);
  expect(ok.data.status).toBe("confirmed");
});
