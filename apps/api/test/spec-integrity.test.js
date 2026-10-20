import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  startHarness,
  deviceKey,
  nativeSignIn,
  bind,
  signedPost,
} from "./harness.js";
import { install as org } from "../src/domains/org/index.js";
import { install as integrity } from "../src/domains/integrity/index.js";
import { install as visits } from "../src/domains/visits/index.js";
import {
  detect,
  hamming,
  travel,
  evaluateCheckInIntegrity,
} from "../src/domains/integrity/detectors.js";
import { collectCommercialSignals } from "../src/domains/integrity/commercial.js";
import { inspectJpeg, photoChecks } from "../src/domains/integrity/photos.js";
import { canonicalJson, sha256Hex } from "../src/core/util.js";

/** @type {import('./harness.js').Harness} */ let h;
/** @type {any} */ let boss;
/** @type {string} */ let root;
const password = "test-only-integrity-password";
/** @param {string} path @param {any} [body] @param {string} [cookie] */
async function api(path, body, cookie = boss.cookie) {
  const r = await h.fetch(
    path.startsWith("/api/") ? path : "/api/v1/integrity/" + path,
    {
      method: body ? "POST" : "GET",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  return { status: r.status, body: /** @type {any} */ (await r.json()) };
}
/** @param {string} role @param {string} [unit] */
async function person(role = "sales", unit = root) {
  const email = `${crypto.randomUUID()}@example.com`;
  const [u] =
    await h.db`insert into users(email,password_hash) values (${email},${await Bun.password.hash(password)}) returning id`;
  const [p] =
    await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id,effective_from) values (${u.id},${u.id},'Integrity sample',${email},${role},'active',${unit},now()-interval '1 day') returning *`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values (${p.id},${unit},${role},now()-interval '1 day',${u.id},'test')`;
  await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values ('integrity-test','profiles',${p.id},${p.id})`;
  return { userId: u.id, profile: p, email };
}
/** @param {any} p @param {string} [app] */
async function phone(p, app = "field-android") {
  const key = await deviceKey(),
    tokens = await nativeSignIn(h, p.email, password, app, key);
  expect(tokens.res.status).toBe(200);
  const [d] =
    await h.db`select * from registered_devices where profile_id=${p.profile.id} and key_id=${key.keyId}`;
  expect(
    (await bind(h, tokens.body.accessToken, d.id, key)).body.bindingStatus,
  ).toBe("bound");
  return {
    key,
    deviceId: d.id,
    access: tokens.body.accessToken,
    session: tokens.body.sessionToken,
    app,
  };
}
beforeAll(async () => {
  h = await startHarness({
    installers: [org, visits, integrity],
    env: {
      SP_MOCK_IDP: "1",
      DEVICE_RECOVERY_SECRET: "test-only-sealed-recovery-key-0123456789",
    },
  });
  const [u] =
    await h.db`insert into users(email,password_hash) values ('boss@example.com',${await Bun.password.hash(password)}) returning id`;
  const r = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "boss@example.com", password }),
  });
  boss = { cookie: r.headers.get("set-cookie")?.split(";")[0], userId: u.id };
  const me = await api("/api/me");
  root = me.body.profile.orgUnitId;
});
afterAll(async () => {
  await h?.close();
});

test("F-007 one ACTIVE phone per user across apps, concurrent sample sign-ins cannot bypass", async () => {
  const p = await person(),
    d = await phone(p),
    keys = await Promise.all([deviceKey(), deviceKey()]);
  const attempts = await Promise.all(
    keys.map((key) => nativeSignIn(h, p.email, password, "van-android", key)),
  );
  for (const a of attempts) {
    const r = await h.fetch("/api/me", {
      headers: {
        authorization: `Bearer ${a.body.accessToken}`,
        "x-app": "van-android",
        "x-device-key-id": keys[attempts.indexOf(a)].keyId,
      },
    });
    const me = /** @type {any} */ (await r.json());
    expect(me.device).toBeNull();
    expect(me.handoverRequired).toBe(true);
  }
  expect(
    await h.db`select * from registered_devices where profile_id=${p.profile.id} and status='active'`,
  ).toHaveLength(1);
  await expect(
    Promise.resolve(
      h.db`insert into registered_devices(profile_id,app,platform,inventory_tag,public_key_spki,key_id,org_unit_id) values (${p.profile.id},'van-android','android',${crypto.randomUUID()},${keys[0].publicKeySpki},${keys[0].keyId},${root})`,
    ),
  ).rejects.toThrow();
  expect(d.deviceId).toBeTruthy();
});

test("F-007 legacy revoke/register and reinstate routes cannot bypass held-work reconciliation", async () => {
  const p = await person(),
    old = await phone(p),
    key = await deviceKey();
  expect(
    (
      await api("/api/v1/people/devices/revoke", {
        deviceId: old.deviceId,
        reason: "replacement",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await api("/api/v1/people/devices/register", {
        profileId: p.profile.id,
        app: "van-android",
        inventoryTag: "SAMPLE replacement",
        publicKeySpki: key.publicKeySpki,
      })
    ).status,
  ).toBe(422);
  const attempt = await nativeSignIn(h, p.email, password, "van-android", key);
  const me = await h.fetch("/api/me", {
    headers: {
      authorization: `Bearer ${attempt.body.accessToken}`,
      "x-app": "van-android",
      "x-device-key-id": key.keyId,
    },
  });
  expect((await me.json()).handoverRequired).toBe(true);
  const request = await api("devices/handover", {
    deviceId: old.deviceId,
    app: "van-android",
    inventoryTag: "SAMPLE controlled replacement",
    publicKeySpki: key.publicKeySpki,
    reasonCode: "replacement",
  });
  expect(request.status).toBe(200);
  expect(
    (
      await h.db`select status from registered_devices where id=${old.deviceId}`
    )[0].status,
  ).toBe("revoked");
  expect(
    (
      await api("devices/complete-handover", {
        handoverId: request.body.handoverId,
        reconciliation: "lost_phone_work_unrecoverable",
      })
    ).status,
  ).toBe(200);
  const other = await person(),
    held = await phone(other);
  expect(
    (
      await api("devices/wipe", {
        deviceId: held.deviceId,
        reasonCode: "sample_erasure",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await api("/api/v1/people/devices/reinstate", {
        deviceId: held.deviceId,
        reason: "found",
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await h.db`select status from registered_devices where id=${held.deviceId}`
    )[0].status,
  ).toBe("suspended");
});

test("F-007 handover refuses premature completion; lost-phone reconciliation is explicit and audited", async () => {
  const p = await person(),
    old = await phone(p),
    key = await deviceKey();
  const request = await api("devices/handover", {
    deviceId: old.deviceId,
    app: "van-android",
    inventoryTag: "Replacement test",
    publicKeySpki: key.publicKeySpki,
    reasonCode: "replacement",
  });
  expect(request.status).toBe(200);
  const early = await api("devices/complete-handover", {
    handoverId: request.body.handoverId,
    reconciliation: "recovered",
  });
  expect(early.status).toBe(409);
  const done = await api("devices/complete-handover", {
    handoverId: request.body.handoverId,
    reconciliation: "lost_phone_work_unrecoverable",
  });
  expect(done.status).toBe(200);
  expect(
    (
      await h.db`select status from registered_devices where id=${old.deviceId}`
    )[0].status,
  ).toBe("revoked");
  expect(
    (
      await h.db`select status,app from registered_devices where id=${done.body.deviceId}`
    )[0],
  ).toMatchObject({ status: "active", app: "van-android" });
  expect(
    await h.db`select 1 from audit_logs where action='device.handover_completed' and entity_id=${done.body.deviceId}`,
  ).toHaveLength(1);
});

test("F-007 remote wipe seals queued work before erasure ack; mismatched recovery cannot overwrite", async () => {
  const p = await person(),
    d = await phone(p, "van-android");
  const w = await api("devices/wipe", {
    deviceId: d.deviceId,
    reasonCode: "sample_wipe",
  });
  expect(w.status).toBe(200);
  const controlId = w.body.controlId;
  const me = await h.fetch("/api/me", {
    headers: {
      authorization: `Bearer ${d.access}`,
      "x-app": "van-android",
      "x-device-key-id": d.key.keyId,
    },
  });
  expect(/** @type {any} */ (await me.json()).deviceControl.id).toBe(controlId);
  const bundle = {
    tables: [
      {
        table: "outbox",
        rows: [{ clientOpId: crypto.randomUUID(), payload: "saved sale" }],
      },
    ],
    queuedCount: 1,
  };
  /** @param {'recover'|'ack'} stage @param {any} value */
  async function contact(stage, value) {
    const timestamp = Date.now(),
      digest = sha256Hex(
        canonicalJson(stage === "recover" ? value : { digest: value }),
      );
    const signature = await d.key.sign(
      `CONTROL|${stage}|${controlId}|${digest}|${timestamp}`,
    );
    const res = await h.fetch("/api/devices/control/" + stage, {
      method: "POST",
      headers: {
        authorization: `Bearer ${d.access}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        controlId,
        timestamp,
        signature,
        ...(stage === "recover" ? { bundle: value } : { digest: value }),
      }),
    });
    return { status: res.status, body: /** @type {any} */ (await res.json()) };
  }
  expect((await contact("ack", "missing")).status).toBe(409);
  const recovered = await contact("recover", bundle);
  expect(recovered.status).toBe(200);
  expect(recovered.body.held).toBe(true);
  expect((await contact("recover", { ...bundle, queuedCount: 0 })).status).toBe(
    409,
  );
  const [sealed] =
    await h.db`select * from device_recovery_bundles where control_id=${controlId}`;
  expect(sealed.ciphertext).not.toContain("saved sale");
  expect(sealed.queued_count).toBe(1);
  expect((await contact("ack", recovered.body.digest)).body.acknowledged).toBe(
    true,
  );
  expect(
    (
      await h.db`select status,queued_count from device_controls where id=${controlId}`
    )[0],
  ).toMatchObject({ status: "acknowledged", queued_count: 1 });
  expect(
    (
      await h.db`select status from registered_devices where id=${d.deviceId}`
    )[0].status,
  ).toBe("revoked");
});

test("F-024 rooted assessment blocks refresh, enrollment challenge and push; audited time-limited exception", async () => {
  const p = await person(),
    d = await phone(p);
  expect(
    (
      await api("devices/assessment", {
        deviceId: d.deviceId,
        rooted: true,
        tampered: false,
        source: "SAMPLE test MDM",
      })
    ).status,
  ).toBe(200);
  const r = await h.fetch("/api/auth/refresh", {
    method: "POST",
    headers: {
      authorization: `Bearer ${d.session}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ version: 2, app: d.app, deviceKeyId: d.key.keyId }),
  });
  expect(r.status).toBe(403);
  const ch = await h.fetch("/api/devices/challenge", {
    method: "POST",
    headers: {
      authorization: `Bearer ${d.access}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ version: 2, deviceId: d.deviceId }),
  });
  expect(ch.status).toBe(403);
  const push = await h.fetch("/api/sync/push", {
    method: "POST",
    headers: {
      authorization: `Bearer ${d.access}`,
      "content-type": "application/json",
      "x-device-id": d.deviceId,
      "x-device-nonce": crypto.randomUUID(),
      "x-device-timestamp": String(Date.now()),
      "x-device-signature": "invalid",
    },
    body: JSON.stringify({
      version: 2,
      app: d.app,
      deviceId: d.deviceId,
      scopeId: root,
      operations: [
        {
          clientOpId: crypto.randomUUID(),
          opType: "visit.checkIn",
          clientTime: Date.now(),
          dependsOn: [],
          payload: {},
        },
      ],
    }),
  });
  expect(push.status).toBe(403);
  expect(
    (
      await api("devices/exception", {
        deviceId: d.deviceId,
        reasonCode: "supervised_recovery",
        expiresAt: Date.now() + 60_000,
      })
    ).status,
  ).toBe(200);
  const ch2 = await h.fetch("/api/devices/challenge", {
    method: "POST",
    headers: {
      authorization: `Bearer ${d.access}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ version: 2, deviceId: d.deviceId }),
  });
  expect(ch2.status).toBe(200);
  expect(
    await h.db`select 1 from audit_logs where action='device.integrity_exception' and entity_id=${d.deviceId}`,
  ).toHaveLength(1);
});

test("F-024 F-221 mock check-in is refused and remains in the signed-attempt denominator", async () => {
  const p = await person(),
    d = await phone(p);
  const [o] =
    await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,created_by) values ('sunpride',${crypto.randomUUID()},'Test integrity store','active',${root},${p.userId}) returning id`;
  const now = Date.now(),
    operation = {
      clientOpId: crypto.randomUUID(),
      opType: "visit.checkIn",
      clientTime: now,
      dependsOn: [],
      payload: {
        clientVisitId: crypto.randomUUID(),
        outletId: o.id,
        serviceDate: new Date(now + 8 * 3600_000).toISOString().slice(0, 10),
        deviceTime: now,
        intents: ["merchandise"],
        unplannedReason: "test",
        location: {
          latitude: 10.3,
          longitude: 123.9,
          accuracyMeters: 5,
          fixTime: now,
          provider: "gps",
          mockSignal: true,
        },
      },
    };
  const r = await signedPost(h, d, "/api/sync/push", {
    version: 2,
    app: d.app,
    deviceId: d.deviceId,
    scopeId: root,
    operations: [operation],
  });
  expect(r.res.status).toBe(200);
  expect(r.body.results[0].code).toBe("mock_location_refused");
  // Malformed clean requests must not dilute the incident rate.
  const malformed = await signedPost(h, d, "/api/sync/push", {
    version: 2,
    app: d.app,
    deviceId: d.deviceId,
    scopeId: root,
    operations: [
      {
        ...operation,
        clientOpId: crypto.randomUUID(),
        payload: {
          ...operation.payload,
          clientVisitId: "invalid",
          location: { ...operation.payload.location, mockSignal: false },
        },
      },
    ],
  });
  expect(malformed.body.results[0].status).toBe("rejected");
  const [{ attempts }] =
    await h.db`select count(*)::int attempts from integrity_observations where kind='check_in' and device_id=${d.deviceId}`;
  expect(attempts).toBe(1);
  expect(
    await h.db`select * from visit_executions where recording_device_id=${d.deviceId}`,
  ).toHaveLength(0);
  await detect(h.db);
  const queue = await api("queue");
  expect(queue.status).toBe(200);
  expect(queue.body.mockRate.incidents).toBeGreaterThan(0);
  expect(queue.body.mockRate.targetBelowPct).toBe(0.5);
  expect(
    await h.db`select * from integrity_findings where device_id=${d.deviceId} and rule='mock_location'`,
  ).toHaveLength(1);
});

test("F-221 F-606 replay-safe jobs detect travel, exact/perceptual photos, EXIF, batch, orders, discounts, returns and cash", async () => {
  const p = await person(),
    at = Date.now() - 600_000;
  /** @param {string} kind @param {any} facts @param {number} [offset] */
  const observe = async (kind, facts, offset = 0) => {
    await h.db`insert into integrity_observations(source_key,kind,profile_id,org_unit_id,occurred_at,facts) values (${crypto.randomUUID()},${kind},${p.profile.id},${root},${new Date(at + offset)},${facts})`;
  };
  for (let n = 0; n < 6; n++)
    await observe(
      "check_in",
      {
        latitude: n % 2 ? 14.5 : 10.3,
        longitude: n % 2 ? 121 : 123.9,
        accuracyMeters: 5,
      },
      n * 1000,
    );
  await observe("photo", {
    checksum: "a".repeat(64),
    perceptualHash: "0000000000000000",
  });
  await observe("photo", {
    checksum: "a".repeat(64),
    perceptualHash: "0000000000000001",
  });
  await observe("photo", {
    checksum: "b".repeat(64),
    perceptualHash: "0000000000000001",
    exifMismatch: true,
    exifReasons: ["exif_time_mismatch"],
  });
  for (let n = 0; n < 3; n++)
    await observe(
      "order",
      { customerCode: "SAMPLE", totalCentavos: "10000" },
      n * 1000,
    );
  await observe("discount", { ratePct: 80 });
  await observe("return", { returnRatioPct: 80 });
  await observe("settlement", { varianceCentavos: 99999 });
  const run = await detect(h.db);
  expect(run.findings).toBeGreaterThan(0);
  const rules = (
    await h.db`select distinct rule from integrity_findings where profile_id=${p.profile.id}`
  ).map((/** @type {any} */ r) => r.rule);
  for (const rule of [
    "impossible_travel",
    "batch_checkins",
    "duplicate_photo",
    "similar_photo",
    "exif_mismatch",
    "repeat_orders",
    "high_discount",
    "high_returns",
    "settlement_variance",
  ])
    expect(rules).toContain(rule);
  const next = await detect(h.db);
  expect(next.scanned).toBe(0);
  expect(next.findings).toBe(0);
  const replay = await detect(h.db, { reset: true });
  expect(replay.findings).toBe(0);
  const [f] =
    await h.db`select id from integrity_findings where profile_id=${p.profile.id} limit 1`;
  expect(
    (
      await api("dispose", {
        findingId: f.id,
        outcome: "false_positive",
        reasonCode: "verified_sample",
      })
    ).status,
  ).toBe(200);
  await expect(
    Promise.resolve(
      h.db`update integrity_findings set evidence='{}' where id=${f.id}`,
    ),
  ).rejects.toThrow();
  await expect(
    Promise.resolve(
      h.db`delete from integrity_dispositions where finding_id=${f.id}`,
    ),
  ).rejects.toThrow();
});

test("F-606 commercial scanner executes against canonical tables without writing business facts", async () => {
  const r = await collectCommercialSignals(h.db);
  expect(r.collected).toBe(0);
  expect(r.hasMore).toBe(false);
});

test("F-606 commercial scanner drains beyond 200 orders with native Postgres microsecond timestamps", async () => {
  const p = await person();
  await h.db`insert into orders(organization_id,client_request_id,order_number,customer_code,salesperson_subject,salesperson_profile_id,org_unit_id,status,subtotal,total,total_centavos,updated_at)
    select 'sunpride','SAMPLE-COMMERCIAL-'||${p.profile.id}||'-'||i,'SAMPLE-COMMERCIAL-'||${p.profile.id}||'-'||i,'SAMPLE-COMMERCIAL',${p.userId},${p.profile.id},${root},'submitted',50,50,5000,'2026-10-01T00:00:00.123456Z'::timestamptz from generate_series(1,203) i`;
  expect((await collectCommercialSignals(h.db)).collected).toBe(200);
  expect((await collectCommercialSignals(h.db)).collected).toBe(3);
  expect((await collectCommercialSignals(h.db)).collected).toBe(0);
  const [{ n }] =
    await h.db`select count(*)::int n from integrity_observations where kind='order' and profile_id=${p.profile.id}`;
  expect(n).toBe(203);
}, 30_000);

test("F-021 effective fleet, MDM import, peripherals, spare and repair data have real web API writes", async () => {
  const base = {
    assetTag: "SAMPLE-SPARE-1",
    orgUnitId: root,
    model: "Sample Redmi",
    state: "spare",
    peripherals: [{ kind: "printer", tag: "SAMPLE-PRINTER" }],
    mdmStatus: "unknown",
    mdmSource: "SAMPLE MDM",
    dataPlan: "SAMPLE 5 GB",
    sourceRef: "SAMPLE procurement assumption",
  };
  expect((await api("fleet/save", base)).status).toBe(200);
  const mdm = await api("fleet/import-mdm", {
    rows: [
      {
        ...base,
        mdmStatus: "compliant",
        state: "repair",
        effectiveFrom: Date.now() + 1000,
      },
    ],
  });
  expect(mdm.status).toBe(200);
  expect(mdm.body.imported).toBe(1);
  const fleet = await api("fleet");
  expect(
    fleet.body.assets.some(
      (/** @type {any} */ a) => a.asset_tag === base.assetTag,
    ),
  ).toBe(true);
});

test("F-021 fleet assignments do not expose a person's new area after transfer", async () => {
  const a = crypto.randomUUID(),
    b = crypto.randomUUID();
  for (const id of [a, b])
    await h.db`insert into org_units(id,organization_id,code,name,type_code,status,parent_id,effective_from) values (${id},'sunpride',${id},'SAMPLE fleet area','region','active',${root},now()-interval '1 day')`;
  const office = await person("admin", a),
    worker = await person("sales", a);
  const workerPhone = await phone(worker);
  const saved = await api("fleet/save", {
    assetTag: "SAMPLE-FLEET-TRANSFER-" + worker.profile.id,
    orgUnitId: a,
    assignedProfileId: worker.profile.id,
    model: "SAMPLE phone",
    state: "assigned",
    peripherals: [],
    mdmStatus: "unknown",
    mdmSource: "SAMPLE import",
    dataPlan: "SAMPLE plan",
    sourceRef: "SAMPLE scope regression",
  });
  expect(saved.status).toBe(200);
  const login = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: office.email, password }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const before = await api("fleet", undefined, cookie);
  expect(
    before.body.assets.find((/** @type {any} */ x) => x.id === saved.body.id)
      .assigned_name,
  ).toBe(worker.profile.name);
  await h.db`update employee_assignments set effective_to=now() where profile_id=${worker.profile.id} and effective_to is null`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values (${worker.profile.id},${b},'sales',now(),${boss.userId},'SAMPLE transfer')`;
  await h.db`update profiles set org_unit_id=${b} where id=${worker.profile.id}`;
  const after = await api("fleet", undefined, cookie);
  const asset = after.body.assets.find(
    (/** @type {any} */ x) => x.id === saved.body.id,
  );
  expect(asset.assigned_name).toBeNull();
  expect(asset.assignment_needs_review).toBe(true);
  expect(
    (
      await api(
        "devices/wipe",
        { deviceId: workerPhone.deviceId, reasonCode: "sample_transfer_check" },
        cookie,
      )
    ).status,
  ).toBe(403);
  expect(
    await h.db`select 1 from device_controls where device_id=${workerPhone.deviceId}`,
  ).toHaveLength(0);
});

test("F-007 OIDC mock uses real signed token, code/PKCE/nonce, single-use browser state and explicit user link", async () => {
  const p = await person("manager"),
    issuer = h.origin + "/api/mock-idp";
  expect(
    (
      await api("identity/provider", {
        code: "local_mock",
        label: "Local sample identity",
        issuer,
        clientId: "sunpride-local",
        redirectUri: h.origin + "/api/auth/oidc/callback",
        sourceRef: "SAMPLE local IdP",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await api("identity/link", {
        profileId: p.profile.id,
        issuer,
        subject: "sample-manager",
      })
    ).status,
  ).toBe(200);
  const start = await h.fetch("/api/auth/oidc/start?provider=local_mock", {
    redirect: "manual",
  });
  expect(start.status).toBe(302);
  const oidcCookie = start.headers.get("set-cookie")?.split(";")[0] ?? "";
  const authz = await fetch(start.headers.get("location") ?? "", {
    redirect: "manual",
  });
  expect(authz.status).toBe(302);
  const callback = authz.headers.get("location") ?? "";
  const noCookie = await fetch(callback, { redirect: "manual" });
  expect(noCookie.status).toBe(403);
  const finish = await fetch(callback, {
    redirect: "manual",
    headers: { cookie: oidcCookie },
  });
  expect(finish.status).toBe(302);
  expect(finish.headers.get("location")).toBe("/today");
  const sessionCookie = finish.headers.get("set-cookie")?.split(";")[0] ?? "";
  const me = await api("/api/me", undefined, sessionCookie);
  expect(me.body.profile.role).toBe("manager");
  expect(me.body.user.id).toBe(p.userId);
  expect(
    (
      await fetch(callback, {
        redirect: "manual",
        headers: { cookie: oidcCookie },
      })
    ).status,
  ).toBe(403);
});

test("F-007 recovery conserves native scientific notation and 64-bit integer bytes", async () => {
  const p = await person(),
    d = await phone(p);
  const marked = await api("devices/wipe", {
    deviceId: d.deviceId,
    reasonCode: "sample_exact_recovery",
  });
  const controlId = marked.body.controlId;
  const bundleJson =
    '{"tables":[{"table":"SAMPLE evidence","rows":[{"tiny":1.0E-7,"large":9223372036854775807}]}],"queuedCount":1}';
  const digest = sha256Hex(bundleJson),
    timestamp = Date.now();
  const response = await h.fetch("/api/devices/control/recover", {
    method: "POST",
    headers: {
      authorization: `Bearer ${d.access}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      controlId,
      timestamp,
      bundleJson,
      signature: await d.key.sign(
        `CONTROL|recover|${controlId}|${digest}|${timestamp}`,
      ),
    }),
  });
  expect(response.status).toBe(200);
  expect((await response.json()).digest).toBe(digest);
  const exported = await api("recovery/export", {
    controlId,
    reasonCode: "sample_supervised_review",
  });
  expect(exported.status).toBe(200);
  expect(exported.body.bundleJson).toBe(bundleJson);
  expect(exported.body.bundleJson).toContain("9223372036854775807");
});

test("F-024 missing or expired assessments fail closed until a fresh native refresh", async () => {
  const p = await person(),
    d = await phone(p);
  await h.db`delete from device_integrity_assessments where device_id=${d.deviceId}`;
  const challenge = (/** @type {string} */ token) =>
    h.fetch("/api/devices/challenge", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ version: 2, deviceId: d.deviceId }),
    });
  let response = await challenge(d.access);
  expect(response.status).toBe(403);
  expect((await response.json()).error.code).toBe("device_integrity_required");
  const refreshed = await h.fetch("/api/auth/refresh", {
    method: "POST",
    headers: {
      authorization: `Bearer ${d.session}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      version: 2,
      app: d.app,
      deviceKeyId: d.key.keyId,
      integrity: { rooted: false, tampered: false },
    }),
  });
  expect(refreshed.status).toBe(200);
  const tokens = await refreshed.json();
  response = await challenge(tokens.accessToken);
  expect(response.status).toBe(200);
  await h.db`update device_integrity_assessments set expires_at=now()-interval '1 second' where device_id=${d.deviceId}`;
  response = await challenge(tokens.accessToken);
  expect(response.status).toBe(403);
});

test("F-221 a transferred outlet withdraws both its finding and its contribution to the old area's rate", async () => {
  const [a, b] = [crypto.randomUUID(), crypto.randomUUID()];
  for (const unit of [a, b])
    await h.db`insert into org_units(id,organization_id,code,name,type_code,status,parent_id,effective_from) values (${unit},'sunpride',${unit},'SAMPLE integrity area','region','active',${root},now()-interval '1 day')`;
  const manager = await person("manager", a),
    worker = await person("sales", a);
  const login = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: manager.email, password }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const [outlet] =
    await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,created_by) values ('sunpride',${crypto.randomUUID()},'SAMPLE transferred store','active',${a},${boss.userId}) returning id`;
  await h.db`insert into integrity_observations(source_key,kind,profile_id,org_unit_id,outlet_id,occurred_at,facts) values (${`scope-proof:${outlet.id}`},'check_in',${worker.profile.id},${a},${outlet.id},now(),${{ mockSignal: true, latitude: 10, longitude: 123, accuracyMeters: 5 }})`;
  await detect(h.db);
  const before = await api("queue", undefined, cookie);
  expect(
    before.body.items.some(
      (/** @type {any} */ i) => i.rule === "mock_location",
    ),
  ).toBe(true);
  expect(before.body.mockRate.attempts).toBe(1);
  await h.db`update outlets set custodian_org_unit_id=${b} where id=${outlet.id}`;
  const after = await api("queue", undefined, cookie);
  expect(after.body.items).toEqual([]);
  expect(after.body.mockRate.attempts).toBe(0);
});

test("F-024 original camera EXIF is checked even when derivative metadata matches the watermark", () => {
  const now = Date.now();
  const manifest = {
    version: 1,
    latitude: 10,
    longitude: 123,
    accuracyMeters: 5,
    capturedAt: now,
    user: "SAMPLE user",
    profileId: "sample-person",
    outlet: "SAMPLE outlet",
    outletId: "sample-outlet",
    perceptualHash: "0000000000000000",
    sourceExif: {
      dateTimeOriginal: "2000:01:01 00:00:00",
      offsetTimeOriginal: "+08:00",
      latitude: 14,
      longitude: 121,
      orientation: 9,
    },
  };
  const derivativeTime = new Date(now + 8 * 3600_000)
    .toISOString()
    .slice(0, 19)
    .replaceAll("-", ":")
    .replace("T", " ");
  const flags = photoChecks(
    {
      manifest,
      exif: {
        dateTimeOriginal: derivativeTime,
        offsetTimeOriginal: "+08:00",
        latitude: 10,
        longitude: 123,
        orientation: 1,
      },
    },
    { profileId: "sample-person", outletId: "sample-outlet" },
    { photoTimeToleranceMs: 120_000, photoGpsToleranceMeters: 200 },
  );
  expect(flags).toEqual([
    "source_exif_time_mismatch",
    "source_exif_gps_mismatch",
    "source_exif_orientation_invalid",
  ]);
});

test("F-007 SSO trust cannot promote a national administrator or normalize opaque identities", async () => {
  const admin = await person("admin"),
    device = await phone(admin);
  const login = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: admin.email, password }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  expect((await api("fleet", undefined, cookie)).status).toBe(200);
  const config = {
    code: "exact_identity",
    label: "SAMPLE exact identity",
    issuer: h.origin + "/api/mock-idp/",
    clientId: " client exact ",
    redirectUri: h.origin + "/api/auth/oidc/callback",
    sourceRef: "SAMPLE literal preservation",
  };
  expect((await api("identity/provider", config, cookie)).status).toBe(403);
  const [rootPerson] =
    await h.db`select id from profiles where user_id=${boss.userId}`;
  expect(
    (
      await api(
        "identity/link",
        {
          profileId: rootPerson.id,
          issuer: config.issuer,
          subject: "attacker_subject",
        },
        cookie,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await api(
        "devices/assessment",
        {
          deviceId: device.deviceId,
          rooted: false,
          tampered: false,
          source: "mdm:manual",
        },
        cookie,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await api("devices/assessment", {
        deviceId: device.deviceId,
        rooted: false,
        tampered: false,
        source: "android-self-report",
      })
    ).status,
  ).toBe(400);
  const saved = await api("identity/provider", config);
  expect(saved.status).toBe(200);
  const [provider] =
    await h.db`select issuer,client_id,redirect_uri from identity_providers where id=${saved.body.id}`;
  expect(provider.issuer).toBe(config.issuer);
  expect(provider.client_id).toBe(config.clientId);
  expect(provider.redirect_uri).toBe(config.redirectUri);
  const subject = " Subject-Case ";
  const linked = await api("identity/link", {
    profileId: admin.profile.id,
    issuer: config.issuer,
    subject,
  });
  expect(linked.status).toBe(200);
  const [identity] =
    await h.db`select issuer,subject,user_id from federated_identities where id=${linked.body.id}`;
  expect(identity.subject).toBe(subject);
  expect(identity.issuer).toBe(config.issuer);
  expect(identity.user_id).toBe(admin.userId);
});

test("F-024 F-312 malformed EXIF and missing watermark are flagged; travel and perceptual limits are real", () => {
  expect(
    inspectJpeg(new Uint8Array([255, 216, 255, 225, 255, 255])).malformed,
  ).toBe(true);
  expect(
    photoChecks(inspectJpeg(new Uint8Array([255, 216, 255, 217])), {}, {}),
  ).toContain("watermark_manifest_missing");
  expect(hamming("0000000000000000", "000000000000000f")).toBe(4);
  expect(
    travel(
      { latitude: 10, longitude: 120, accuracyMeters: 5 },
      { latitude: 14, longitude: 121, accuracyMeters: 5 },
      60_000,
      { maxTravelKph: 160, travelToleranceMeters: 200 },
    ),
  ).not.toBeNull();
});
