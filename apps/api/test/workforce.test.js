import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import {
  boundDevice,
  profileStore,
  signedPost,
  startHarness,
} from "./harness.js";
// Fixture scope adapter reads actual persisted owners; no domain/query responses are invented.
mock.module("../src/domains/org/scope.js", () => ({
  scopeFilterForActor: async (
    /** @type {any} */ _db,
    /** @type {any} */ a,
  ) => ({ unitIds: a.role === "super_admin" ? null : [a.orgUnitId] }),
  outletOwnerUnit: async (
    /** @type {any} */ db,
    /** @type {any} */ id,
    /** @type {any} */ at,
  ) => {
    const [r] =
      await db`select coalesce((select own.org_unit_id from outlet_assignments x join territory_ownerships own on own.territory_id=x.territory_id where x.outlet_id=o.id and x.deleted_at is null and own.deleted_at is null and x.effective_from<=${new Date(at)} and (x.effective_to is null or x.effective_to>${new Date(at)}) and own.effective_from<=${new Date(at)} and (own.effective_to is null or own.effective_to>${new Date(at)})),o.custodian_org_unit_id) owner from outlets o where o.id=${id}`;
    return r?.owner ?? null;
  },
}));
const { install: visits } = await import("../src/domains/visits/index.js");
const { installWorkforce } =
  await import("../src/domains/coverage/workforce.js");
const { formConfiguration, formPolicyHash, formPolicyAt } =
  await import("../src/domains/coverage/workforce-policies.js");
const { manilaDate } = await import("../src/domains/coverage/model.js");
/** @type {any} */ let h;
/** @type {ReturnType<typeof profileStore>} */ let profiles;
beforeAll(async () => {
  h = await startHarness({ installers: [visits, installWorkforce] });
  profiles = profileStore(h);
});
afterAll(async () => {
  await h?.close();
});
const configuration = {
  fields: [
    {
      key: "address",
      label: "Address",
      type: "text",
      required: true,
      maxLength: 500,
    },
    {
      key: "channel",
      label: "Proposed channel",
      type: "text",
      required: true,
      maxLength: 100,
    },
    {
      key: "contactName",
      label: "Contact person",
      type: "text",
      required: true,
      maxLength: 100,
    },
    {
      key: "accountReference",
      label: "KYC reference",
      type: "text",
      required: false,
      maxLength: 30,
    },
  ],
  dayStartMinutes: 0,
  dayEndMinutes: 1440,
  maxAccuracyMeters: 250,
  maxFixAgeSeconds: 300,
  maxShiftHours: 18,
  dedupeRadiusMeters: 50,
};
/** @param {any} d @param {string} path @param {any} [body] */
async function web(d, path, body) {
  const r = await h.fetch(path, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${d.access}`,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json() };
}
/** @param {string} unit @param {string} role */
async function person(unit, role) {
  const d = await boundDevice(h, profiles, { role, orgUnitId: unit });
  await h.db`insert into profiles(id,user_id,name,email,role,status,org_unit_id)values(${d.profile.id},${d.userId},${role + " fixture"},${d.email},${role},'active',${unit})`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason)values(${d.profile.id},${unit},${role},${new Date(Date.now() - 86400000)},${d.userId},'TEST')`;
  return d;
}
async function fixture() {
  const unit = crypto.randomUUID();
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from)values(${unit},'sunpride',${unit},'Field team','territory','active',${new Date(Date.now() - 86400000)})`;
  const d = await person(unit, "sales"),
    admin = await person(unit, "super_admin"),
    manager = await person(unit, "manager");
  const body = {
    orgUnitId: unit,
    label: "TEST provisional field policy",
    sourceRef: "TEST assumption",
    fromDate: manilaDate(Date.now()),
    configuration,
  };
  const saved = await web(admin, "/api/v1/coverage/workforce/policies", body);
  expect(saved.status).toBe(200);
  const [policy] =
    await h.db`select * from workforce_form_policies where id=${saved.body.id}`;
  return { unit, d, admin, manager, policy, body };
}
/** @param {any} f @param {string} kind @param {any} [change] */
async function capture(f, kind, change = {}) {
  const id = crypto.randomUUID(),
    at = Date.now(),
    bytes = Uint8Array.of(255, 216, 255, 224, 0, 0, 255, 217),
    sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const purpose =
    kind === "workforce.prospect" ? "prospect-photo" : "attendance-photo";
  const claim = await signedPost(h, f.d, "/api/media/claims", {
    version: 2,
    deviceId: f.d.deviceId,
    purpose,
    ownerId: id,
    mime: "image/jpeg",
    size: bytes.length,
    sha256: sha,
  });
  expect(claim.res.status).toBe(200);
  const upload = await fetch(claim.body.uploadUrl, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${claim.body.uploadToken}`,
      "content-type": "image/jpeg",
    },
    body: bytes,
  });
  expect(upload.status).toBe(200);
  const stored = await upload.json();
  return {
    clientOpId: id,
    opType: kind,
    clientTime: at,
    dependsOn: [],
    payload: {
      policyId: f.policy.id,
      policyVersion: f.policy.version,
      policyHash: f.policy.content_hash,
      capturedAt: at,
      geo: {
        latitude: 10.33,
        longitude: 123.94,
        accuracyMeters: 5,
        takenAt: at,
        mockSignal: false,
        provider: "gps",
      },
      photo: {
        blobId: stored.blobId,
        mime: "image/jpeg",
        size: bytes.length,
        checksum: sha,
        capturedAt: at,
      },
      name: "TEST prospect",
      kyc: {
        address: "TEST address",
        channel: "GT",
        contactName: "TEST contact",
        accountReference: "0005",
      },
      ...change,
    },
  };
}
/** @param {any} f @param {any[]} operations */
async function push(f, operations) {
  const r = await signedPost(h, f.d, "/api/sync/push", {
    version: 2,
    app: f.d.app,
    deviceId: f.d.deviceId,
    scopeId: f.unit,
    operations,
  });
  expect(r.res.status).toBe(200);
  return r.body.results;
}
test("F-209 configured KYC, real signed claim/PUT and canonical proposal preserve evidence and exact replay", async () => {
  const f = await fixture(),
    op = await capture(f, "workforce.prospect"),
    [r] = await push(f, [op]);
  expect(r.status).toBe("applied");
  const id = r.ack.entityId;
  const [row] =
    await h.db`select e.*,o.enrolment_status from outlet_enrolments e join outlets o on o.id=e.outlet_id where e.id=${id}`;
  expect(row.enrolment_status).toBe("provisional");
  expect(row.capture_snapshot.answers.accountReference).toBe("0005");
  expect(row.capture_snapshot.photo.checksum).toBe(op.payload.photo.checksum);
  expect((await push(f, [op]))[0].status).toBe("duplicate");
  expect(
    (await push(f, [{ ...op, payload: { ...op.payload, name: "Changed" } }]))[0]
      .code,
  ).toBe("idempotency_conflict");
  const list = await web(f.manager, "/api/v1/coverage/workforce/prospects");
  expect(list.status).toBe(200);
  expect(list.body.rows.map((/** @type {any} */ x) => x.id)).toContain(id);
  const photo = await h.fetch(
    `/api/v1/coverage/workforce/photo/prospect/${id}`,
    { headers: { authorization: `Bearer ${f.manager.access}` } },
  );
  expect(photo.status).toBe(200);
  expect(photo.headers.get("cache-control")).toBe("private, no-store");
  expect((await photo.arrayBuffer()).byteLength).toBe(8);
  const review = await web(
    f.manager,
    `/api/v1/coverage/workforce/prospects/${id}`,
  );
  expect(review.status).toBe(200);
  const decision = {
    id,
    decision: "approve_distinct",
    dedupeToken: review.body.token,
    confirmDistinct: true,
    reason: "TEST reviewed against canonical masters",
  };
  expect(
    (await web(f.d, "/api/v1/coverage/workforce/prospects/decide", decision))
      .status,
  ).toBe(403);
  expect(
    (
      await web(
        f.manager,
        "/api/v1/coverage/workforce/prospects/decide",
        decision,
      )
    ).body.status,
  ).toBe("approved");
  expect(
    (
      await web(
        f.manager,
        "/api/v1/coverage/workforce/prospects/decide",
        decision,
      )
    ).body.status,
  ).toBe("approved");
});
test("F-209 unknown KYC, another capture photo and withdrawn persisted access leave no proposal", async () => {
  const f = await fixture(),
    bad = await capture(f, "workforce.prospect", {
      kyc: {
        address: "x",
        channel: "GT",
        contactName: "x",
        unknown: "not allowed",
      },
    });
  expect((await push(f, [bad]))[0].status).toBe("rejected");
  const valid = await capture(f, "workforce.prospect");
  const other = { ...valid, clientOpId: crypto.randomUUID() };
  expect((await push(f, [other]))[0].status).toBe("rejected");
  await h.db`update profiles set status='disabled' where id=${f.d.profile.id}`;
  const refused = await signedPost(h, f.d, "/api/sync/push", {
    version: 2,
    app: f.d.app,
    deviceId: f.d.deviceId,
    scopeId: f.unit,
    operations: [valid],
  });
  expect([200, 401, 403]).toContain(refused.res.status);
  if (refused.res.status === 200)
    expect(refused.body.results[0].status).toBe("rejected");
  const [{ n }] =
    await h.db`select count(*)::int n from outlet_enrolments where proposed_by_profile_id=${f.d.profile.id}`;
  expect(n).toBe(0);
});
test("F-222 geo/photo clock-in, clock-out and reports retain raw facts beside independently approved correction and HR leave", async () => {
  const f = await fixture(),
    op = await capture(f, "workforce.clockIn"),
    [start] = await push(f, [op]);
  expect(start.status).toBe("applied");
  expect((await push(f, [op]))[0].status).toBe("duplicate");
  const at = Date.now(),
    out = {
      clientOpId: crypto.randomUUID(),
      opType: "workforce.clockOut",
      clientTime: at,
      dependsOn: [op.clientOpId],
      payload: {
        policyId: f.policy.id,
        policyVersion: f.policy.version,
        policyHash: f.policy.content_hash,
        capturedAt: at,
        clockInRequestId: op.clientOpId,
      },
    };
  expect((await push(f, [out]))[0].status).toBe("applied");
  const day = manilaDate(at),
    draft = {
      profileId: f.d.profile.id,
      day,
      kind: "correction",
      start: at - 3600000,
      end: at,
      sourceRef: "TEST requested adjustment",
      reason: "TEST original retained",
      idempotencyKey: crypto.randomUUID(),
      replacesId: null,
    };
  const correction = await web(
    f.d,
    "/api/v1/coverage/workforce/corrections",
    draft,
  );
  expect(correction.status).toBe(200);
  expect(
    (await web(f.d, "/api/v1/coverage/workforce/corrections", draft)).body.id,
  ).toBe(correction.body.id);
  expect(
    (
      await web(f.d, "/api/v1/coverage/workforce/corrections/decide", {
        id: correction.body.id,
        decision: "approved",
        reason: "TEST",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await web(f.manager, "/api/v1/coverage/workforce/corrections/decide", {
        id: correction.body.id,
        decision: "approved",
        reason: "TEST reviewed",
      })
    ).status,
  ).toBe(200);
  const report = await web(
    f.manager,
    `/api/v1/coverage/workforce/day?day=${day}`,
  );
  expect(report.status).toBe(200);
  const row = report.body.people.find(
    (/** @type {any} */ p) => p.id === f.d.profile.id,
  );
  expect(row.hours).toBe(1);
  expect(row.clockIn).toBe(op.payload.capturedAt);
  expect(row.start).toBe(at - 3600000);
  expect(row.firstCall).toBeNull();
  const [raw] =
    await h.db`select * from attendance_sessions where id=${start.ack.entityId}`;
  expect(+new Date(raw.clock_in_at)).toBe(op.payload.capturedAt);
  expect(raw.clock_in_snapshot.photo.blobId).toBe(op.payload.photo.blobId);
  const imported = await web(
    f.admin,
    "/api/v1/coverage/workforce/absence-import",
    {
      sourceRef: "TEST HR adapter",
      idempotencyKey: "HR-1",
      rows: [
        {
          externalKey: "LEAVE-1",
          profileId: f.d.profile.id,
          day: manilaDate(at - 86400000),
          kind: "leave",
          reason: "TEST leave",
          start: null,
          end: null,
        },
      ],
    },
  );
  expect(imported.status).toBe(200);
  expect(imported.body.rows.length).toBe(1);
});
test("F-222 HR employee codes retain leading zeroes, replay across operators and whole-file rollback", async () => {
  const f = await fixture(),
    other = await person(f.unit, "super_admin"),
    code = "000" + crypto.randomUUID();
  await h.db`update profiles set employee_code=${code} where id=${f.d.profile.id}`;
  const row = {
    employeeCode: code,
    externalKey: "unique-row",
    day: manilaDate(Date.now()),
    kind: "leave",
    reason: "TEST HR",
  };
  const b = {
    sourceRef: "TEST HR " + crypto.randomUUID(),
    idempotencyKey: "first-upload",
    rows: [row],
  };
  const first = await web(
    f.admin,
    "/api/v1/coverage/workforce/absence-import",
    b,
  );
  expect(first.status).toBe(200);
  const replay = await web(other, "/api/v1/coverage/workforce/absence-import", {
    ...b,
    idempotencyKey: "another-upload",
  });
  expect(replay.status).toBe(200);
  expect(replay.body.rows).toEqual(first.body.rows);
  const changed = await web(
    f.admin,
    "/api/v1/coverage/workforce/absence-import",
    { ...b, rows: [{ ...row, reason: "Changed" }] },
  );
  expect(changed.status).toBe(409);
  const refused = await web(
    f.admin,
    "/api/v1/coverage/workforce/absence-import",
    {
      ...b,
      rows: [
        { ...row, externalKey: "must-roll-back" },
        { ...row, externalKey: "bad", employeeCode: "unknown-exact-code" },
      ],
    },
  );
  expect(refused.status).toBe(403);
  const [{ n }] =
    await h.db`select count(*)::int n from attendance_adjustments where source_ref=${b.sourceRef}`;
  expect(n).toBe(1);
  expect(
    (await web(f.d, "/api/v1/coverage/workforce/absence-import", b)).status,
  ).toBe(403);
});
test("F-209/F-222 effective immutable policy replacements and changed import replay fail closed", async () => {
  const f = await fixture();
  expect(formConfiguration(configuration).fields.length).toBe(4);
  expect(formPolicyHash(f.policy)).toBe(f.policy.content_hash);
  const replacement = await web(
    f.admin,
    "/api/v1/coverage/workforce/policies",
    {
      ...f.body,
      fromDate: manilaDate(Date.now() + 86400000),
      label: "TEST next definition",
    },
  );
  expect(replacement.status).toBe(200);
  expect((await formPolicyAt(h.db, f.unit, Date.now())).id).toBe(f.policy.id);
  expect((await formPolicyAt(h.db, f.unit, Date.now() + 86400000)).id).toBe(
    replacement.body.id,
  );
  const b = {
    sourceRef: "TEST HR",
    idempotencyKey: "HR-repeat",
    rows: [
      {
        externalKey: "X",
        profileId: f.d.profile.id,
        day: manilaDate(Date.now()),
        kind: "absence",
        reason: "TEST",
        start: null,
        end: null,
      },
    ],
  };
  expect(
    (await web(f.admin, "/api/v1/coverage/workforce/absence-import", b)).status,
  ).toBe(200);
  expect(
    (await web(f.admin, "/api/v1/coverage/workforce/absence-import", b)).status,
  ).toBe(200);
  expect(
    (
      await web(f.admin, "/api/v1/coverage/workforce/absence-import", {
        ...b,
        rows: [{ ...b.rows[0], reason: "Changed" }],
      })
    ).status,
  ).toBe(409);
});
