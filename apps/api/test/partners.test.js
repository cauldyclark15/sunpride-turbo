import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  startHarness,
  createUser,
  deviceKey,
  registerDevice,
  nativeSignIn,
  bind,
  signedPost,
} from "./harness.js";
import { install as org } from "../src/domains/org/index.js";
import { install as visits } from "../src/domains/visits/index.js";
import { install as fieldsync } from "../src/domains/fieldsync/index.js";
import { install as partners } from "../src/domains/partners/index.js";
import { install as callflow } from "../src/domains/callflow/index.js";
import { ensureRoot } from "../src/domains/org/identity.js";
import { ensureCallflowSamples } from "../../../packages/db/seed/callflow.js";
import { today } from "../src/domains/partners/model.js";
import {
  partnerContext,
  partnerTopicAllowed,
} from "../src/domains/partners/boundary.js";
import { actorFor } from "../src/core/context.js";
import { scopeOf } from "../src/core/scope.js";
import { ensurePartnerSamples } from "../../../packages/db/seed/partners.js";
import { BATCH } from "../../../packages/db/seed/store.js";
import { stat } from "node:fs/promises";
import { publish } from "../src/core/realtime.js";
import {
  configuration,
  PROFILE_FIELD,
} from "../src/domains/callflow/engine.js";
/** @type {import('./harness.js').Harness} */ let h;
/** @type {any} */ let office;
/** @type {any} */ let reviewer;
let unit = "";
const password = "partner-test-only-password";
const early = new Date(Date.now() - 30 * 86400000);
beforeAll(async () => {
  h = await startHarness({
    listen: true,
    installers: [org, visits, fieldsync, partners, callflow],
  });
  unit = await ensureRoot(h.db);
  await ensureCallflowSamples(h.db, Date.now() - 86400000);
  office = await person("super_admin");
  reviewer = await person("admin");
}, 60000);
afterAll(async () => {
  await h?.close();
});
/** @param {string} role */
async function person(role) {
  const email = `${crypto.randomUUID()}@partner.test`,
    userId = await createUser(h, email, password);
  const [p] =
    await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id,employment_type) values(${userId},${userId},${role === "sales" ? "Sample merchandiser" : "Sample colleague"},${email},${role},'active',${unit},'third_party') returning *`;
  if (role === "sales")
    await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},'sales',${early},${userId},'F-322 fixture')`;
  const login = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(login.status).toBe(200);
  return {
    ...p,
    userId,
    email,
    cookie: login.headers.get("set-cookie")?.split(";")[0],
  };
}
/** @param {any} who @param {string} path @param {any} [body] */
async function request(who, path, body) {
  const res = await h.fetch(`/api/v1/partners${path}`, {
    method: body ? "POST" : "GET",
    headers: { cookie: who.cookie, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { res, body: /** @type {any} */ (await res.json()) };
}
async function fixture() {
  const portal = await person("agency"),
    staff = await person("sales");
  const [p] =
    await h.db`insert into distributors(code,name,org_unit_id,status,source,partner_kind,effective_from) values(${crypto.randomUUID()},'Sample agency',${unit},'accredited','sample','agency',${early}) returning *`;
  for (const [who, grants] of [
    [portal, ["portal", "billing"]],
    [staff, ["field"]],
  ])
    await h.db`insert into distributor_users(distributor_id,profile_id,grants,effective_from) values(${p.id},${who.id},${h.db.array(grants, "TEXT")},${early})`;
  const [outlet] =
    await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,created_by) values('sunpride',${crypto.randomUUID()},'Sample supermarket','active',${unit},${office.userId}) returning *`;
  const [territory] =
    await h.db`insert into territories(organization_id,code,name,status,effective_from,created_by) values('sunpride',${crypto.randomUUID()},'Sample territory','active',${early},${office.userId}) returning id`;
  await h.db`insert into territory_ownerships(territory_id,org_unit_id,effective_from,actor_subject,reason) values(${territory.id},${unit},${early},${office.userId},'Fixture')`;
  await h.db`insert into territory_salespeople(territory_id,profile_id,effective_from,actor_subject,reason) values(${territory.id},${staff.id},${early},${office.userId},'Fixture')`;
  await h.db`insert into outlet_assignments(outlet_id,territory_id,effective_from,actor_subject,reason) values(${outlet.id},${territory.id},${early},${office.userId},'Fixture')`;
  await h.db`insert into outlet_pins(outlet_id,latitude,longitude,radius_meters,source,status,effective_from,proposed_by,proposed_at,verified_by,verified_at) values(${outlet.id},10.33,123.94,100,'sample','verified',${early},'first',${early},'second',${early})`;
  await h.db`insert into partner_outlet_assignments(distributor_id,outlet_id,effective_from) values(${p.id},${outlet.id},${early})`;
  await h.db`insert into partner_contracts(distributor_id,version,source_ref,sample,rate_centavos,minimum_calls,minimum_dwell_ms,required_kinds,effective_from,created_by) values(${p.id},1,'SAMPLE not commercial policy',true,65000,1,180000,array['merchandising'],${early},${office.id})`;
  const key = await deviceKey(),
    deviceId = await registerDevice(h, {
      profileId: staff.id,
      orgUnitId: unit,
      key,
    });
  const login = await nativeSignIn(h, staff.email, password, "field-android", {
    keyId: key.keyId,
    publicKeySpki: key.publicKeySpki,
  });
  const who = { access: login.body.accessToken, deviceId, key };
  expect((await bind(h, who.access, deviceId, key)).res.status).toBe(200);
  return { p, portal, staff, outlet, who };
}
/** @param {string} type @param {any} payload */
const op = (type, payload) => ({
  clientOpId: crypto.randomUUID(),
  opType: type,
  clientTime: payload.deviceTime,
  dependsOn: [],
  payload,
});
/** @param {any} f @param {any[]} operations */
const push = (f, operations) =>
  signedPost(h, f.who, "/api/sync/push", {
    version: 2,
    scopeId: unit,
    operations,
  });
/** @param {any} f @param {string} [kind] */
async function complete(f, kind = "merchandising") {
  const at = Date.now() - 600000;
  const config = await configuration(h.db, PROFILE_FIELD, f.outlet, at);
  if (!config) throw new Error("Missing call configuration");
  const fix = {
    latitude: 10.33,
    longitude: 123.94,
    accuracyMeters: 5,
    fixTime: at,
    provider: "gps",
    mockSignal: false,
  };
  const start = op("visit.checkIn", {
    clientVisitId: crypto.randomUUID(),
    outletId: f.outlet.id,
    serviceDate: today(at),
    intents: ["merchandise"],
    unplannedReason: "Sample agency visit",
    deviceTime: at,
    location: fix,
    flowDefinitionId: config.definition.id,
  });
  const s = await push(f, [start]);
  expect(s.res.status).toBe(200);
  expect(s.body.results[0].status).toBe("applied");
  const visitId = s.body.results[0].ack.entityId;
  const activity = op("visit.activity", {
    visitId,
    deviceTime: at + 1,
    activity:
      kind === "note"
        ? { kind, text: "Only a note" }
        : { kind: "merchandising", displayCondition: "compliant" },
  });
  expect((await push(f, [activity])).body.results[0].status).toBe("applied");
  const end = op("visit.checkOut", {
    visitId,
    deviceTime: at + 300000,
    outcome: kind === "note" ? "nonproductive" : "completed",
    zeroSaleReason: "no_demand",
    reasonCode: "no_demand",
    location: { ...fix, fixTime: at + 300000 },
  });
  expect((await push(f, [end])).body.results[0].status).toBe("applied");
  const reviews =
    await h.db`select r.id from call_flow_reviews r join call_executions x on x.id=r.call_id where x.visit_id=${visitId}`;
  for (const review of reviews) {
    const decision = await h.fetch("/api/v1/callflow/reviews/decide", {
      method: "POST",
      headers: { cookie: office.cookie, "content-type": "application/json" },
      body: JSON.stringify({
        reviewId: review.id,
        decision: "approve",
        reason: "Sample agency assignment verified independently",
      }),
    });
    expect(decision.status).toBe(200);
  }
  const [visit] =
    await h.db`select late_review_status from visit_executions where id=${visitId}`;
  if (visit.late_review_status === "pending_review") {
    const late = await h.fetch("/api/v1/visits/late-sync/decide", {
      method: "POST",
      headers: { cookie: office.cookie, "content-type": "application/json" },
      body: JSON.stringify({
        visitId,
        decision: "accept",
        reason: "sample_verified",
      }),
    });
    expect(late.status).toBe(200);
  }
  return { visitId, start, activity, end };
}
/** @param {any} f */
const evidenceOf = (f) =>
  request(
    f.portal,
    `/evidence?partnerId=${f.p.id}&from=${today()}&to=${today()}`,
  );

test("F-322 canonical distributor model isolates two agencies and distributors on every ordinary route", async () => {
  const a = await fixture(),
    b = await fixture();
  expect(
    (await request(a.portal, "")).body.rows.map((/** @type {any} */ r) => r.id),
  ).toEqual([a.p.id]);
  expect(
    (await request(a.portal, `/setup?partnerId=${b.p.id}`)).res.status,
  ).toBe(403);
  for (const path of [
    "/api/v1/people/list",
    "/api/v1/analytics/today",
    "/api/v1/visits/list",
    "/api/v1/orders/list",
    "/api/v1/catalog/products",
    "/api/v1/fieldreports/team",
    "/api/v1/callflow/admin",
  ]) {
    // The facade refuses existing and future route families, regardless of employee role.
    const res = await h.fetch(path, { headers: { cookie: a.staff.cookie } });
    expect([403, 404]).toContain(res.status);
  }
  const dist = await person("distributor");
  const [d] =
    await h.db`insert into distributors(code,name,org_unit_id,status,source) values(${crypto.randomUUID()},'Sample distributor',${unit},'accredited','sample') returning id`;
  await h.db`insert into distributor_users(distributor_id,profile_id,grants,effective_from) values(${d.id},${dist.id},array['read'],${early})`;
  expect(
    (
      await request(
        dist,
        `/evidence?partnerId=${a.p.id}&from=${today()}&to=${today()}`,
      )
    ).res.status,
  ).toBe(403);
});
test("F-322 agency staff execute the existing configured call engine and exact replay", async () => {
  const f = await fixture(),
    c = await complete(f);
  const replay = await push(f, [c.start, c.activity, c.end]);
  expect(replay.body.results.map((/** @type {any} */ r) => r.status)).toEqual([
    "duplicate",
    "duplicate",
    "duplicate",
  ]);
  const [call] =
    await h.db`select * from call_executions where visit_id=${c.visitId}`;
  expect(call.state).toBe("closed");
  expect(call.definition_snapshot.channelProfile).toBe("field_selling");
});
test("F-319 billing uses attendance location, completed visits and governed activity evidence", async () => {
  const f = await fixture();
  await complete(f);
  const e = await evidenceOf(f);
  expect(e.res.status).toBe(200);
  expect(e.body.summary).toMatchObject({
    staff: 1,
    attended: 1,
    completed: 1,
    compliant: 1,
    eligibleDays: 1,
    amountCentavos: 65000,
  });
  expect(e.body.visits[0].sources.activities[0].kind).toBe("merchandising");
});
test("F-319 a completed note-only call is not compliant or billable", async () => {
  const f = await fixture();
  await complete(f, "note");
  const e = await evidenceOf(f);
  expect(e.body.summary.completed).toBe(1);
  expect(e.body.summary.compliant).toBe(0);
  expect(e.body.summary.amountCentavos).toBe(0);
  expect(e.body.visits[0].issues).toContain(
    "Required activity evidence is missing",
  );
});
test("F-322 foreign store and foreign visit operations fail before writes", async () => {
  const a = await fixture(),
    b = await fixture(),
    c = await complete(b);
  const r = await push(a, [
    op("visit.activity", {
      visitId: c.visitId,
      deviceTime: Date.now(),
      activity: { kind: "note", text: "Forbidden" },
    }),
  ]);
  expect(r.res.status).toBe(403);
  const s = await push(a, [
    op("visit.checkIn", {
      clientVisitId: crypto.randomUUID(),
      outletId: b.outlet.id,
      serviceDate: today(),
      intents: ["merchandise"],
      deviceTime: Date.now(),
    }),
  ]);
  expect(s.res.status).toBe(403);
  const [{ n }] =
    await h.db`select count(*)::int n from visit_executions where assignee_profile_id=${a.staff.id}`;
  expect(n).toBe(0);
});
test("F-322 commercial writes and unsupported sync projections are refused", async () => {
  const f = await fixture();
  expect(
    (
      await push(f, [
        op("collection.record", {
          visitId: crypto.randomUUID(),
          deviceTime: Date.now(),
        }),
      ])
    ).res.status,
  ).toBe(403);
  const r = await signedPost(h, f.who, "/api/sync/pull", {
    version: 2,
    scopes: [
      {
        scopeId: unit,
        projection: "suggested-order",
        params: { outletId: f.outlet.id, asOfDate: today() },
      },
    ],
  });
  expect(r.res.status).toBe(403);
});
test("F-322 snapshot includes assigned outlets only and excludes commercial and depot facts", async () => {
  const f = await fixture();
  const r = await signedPost(h, f.who, "/api/sync/pull", {
    version: 2,
    scopes: [
      {
        scopeId: unit,
        projection: "field.bundle",
        params: { dayFrom: today() },
      },
    ],
  });
  expect(r.res.status).toBe(200);
  const data = r.body.bundles[0].data;
  expect(data.outlets.map((/** @type {any} */ o) => o.id)).toEqual([
    f.outlet.id,
  ]);
  for (const key of [
    "inventoryAvailability",
    "localCustomers",
    "accountSummaries",
    "orderTerms",
  ])
    expect(data[key]).toEqual([]);
  expect(data.permissions).not.toContain("order.create");
  const delta = await signedPost(h, f.who, "/api/sync/pull", {
    version: 2,
    since: r.body.nextCursor,
    scopes: [
      {
        scopeId: unit,
        projection: "field.bundle",
        params: { dayFrom: today() },
      },
    ],
  });
  expect(delta.res.status).toBe(403);
  expect(delta.body.error.code).toBe("rebootstrap_required");
});
test("F-322 withdrawal denies existing sessions and even accepted operation replay", async () => {
  const f = await fixture(),
    c = await complete(f);
  await h.db`update distributor_users set effective_to=now() where distributor_id=${f.p.id} and profile_id=${f.staff.id}`;
  expect((await push(f, [c.start])).res.status).toBe(403);
  expect(
    (await h.fetch("/api/me", { headers: { cookie: f.staff.cookie } })).status,
  ).toBe(403);
});
test("F-322 native authorization fingerprint and leases change at membership and assignment boundaries", async () => {
  const f = await fixture(),
    actor = await actorFor(h.db, f.staff.userId);
  if (!actor) throw new Error("No actor");
  const old = await scopeOf(h.db, actor),
    until = new Date(Date.now() + 60000);
  await h.db`update distributor_users set effective_to=${until} where distributor_id=${f.p.id} and profile_id=${f.staff.id}`;
  const current = await scopeOf(h.db, actor);
  expect(current.fingerprint).not.toBe(old.fingerprint);
  const r = await signedPost(h, f.who, "/api/sync/pull", {
    version: 2,
    scopes: [
      {
        scopeId: unit,
        projection: "field.bundle",
        params: { dayFrom: today() },
      },
    ],
  });
  expect(r.res.status).toBe(200);
  expect(r.body.bundles[0].offlineLease.expiresAt).toBeLessThanOrEqual(
    until.getTime(),
  );
});
test("F-319 immutable billing export reauthorizes, replays and requires independent exact-hash approval", async () => {
  const f = await fixture();
  await complete(f);
  const b = {
    partnerId: f.p.id,
    requestKey: crypto.randomUUID(),
    from: today(),
    to: today(),
  };
  const saved = await request(f.portal, "/billing/build", b);
  expect(saved.res.status).toBe(200);
  const replay = await request(f.portal, "/billing/build", b);
  expect(replay.body.id).toBe(saved.body.id);
  expect(replay.body.duplicate).toBe(true);
  const pack = await request(
    f.portal,
    `/billing?partnerId=${f.p.id}&periodId=${saved.body.id}`,
  );
  expect(pack.body.stale).toBe(false);
  const exportResponse = await request(
    f.portal,
    `/billing/export?partnerId=${f.p.id}&periodId=${saved.body.id}`,
  );
  expect(exportResponse.body.lines[0].amountCentavos).toBe(65000);
  const approved = await request(office, "/billing/decide", {
    partnerId: f.p.id,
    periodId: saved.body.id,
    evidenceHash: saved.body.evidenceHash,
    decision: "approved",
    reason: "Checked against system evidence",
    requestKey: crypto.randomUUID(),
  });
  expect(approved.res.status).toBe(200);
  expect(
    (
      await request(
        f.portal,
        `/billing?partnerId=${f.p.id}&periodId=${saved.body.id}`,
      )
    ).body.decision.decision,
  ).toBe("approved");
  const other = await fixture();
  expect(
    (
      await request(
        other.portal,
        `/billing/export?partnerId=${other.p.id}&periodId=${saved.body.id}`,
      )
    ).res.status,
  ).toBe(403);
  await expect(
    (async () => {
      await h.db`update partner_billing_lines set amount_centavos=1 where period_id=${saved.body.id}`;
    })(),
  ).rejects.toThrow("immutable");
});
test("F-319 office cannot approve its own billing package and evidence changes invalidate approval", async () => {
  const f = await fixture(),
    v = await complete(f);
  const b = await request(office, "/billing/build", {
    partnerId: f.p.id,
    requestKey: crypto.randomUUID(),
    from: today(),
    to: today(),
  });
  const input = {
    partnerId: f.p.id,
    periodId: b.body.id,
    evidenceHash: b.body.evidenceHash,
    decision: "approved",
    reason: "Check",
    requestKey: crypto.randomUUID(),
  };
  expect((await request(office, "/billing/decide", input)).res.status).toBe(
    403,
  );
  await h.db`update visit_executions set late_review_status='pending_review' where id=${v.visitId}`;
  const r = await request(reviewer, "/billing/decide", {
    ...input,
    requestKey: crypto.randomUUID(),
  });
  expect(r.res.status).toBe(409);
  expect(r.body.error.code).toBe("stale_evidence");
});
test("F-322 membership expiry and suspension cannot fall back to employee capabilities", async () => {
  const f = await fixture();
  await h.db`update distributors set status='suspended' where id=${f.p.id}`;
  expect((await evidenceOf(f)).res.status).toBe(403);
  expect(
    (
      await h.fetch("/api/v1/visits/list", {
        headers: { cookie: f.staff.cookie },
      })
    ).status,
  ).toBe(403);
});
test("F-322 media claims refuse another agency visit, including shared Sunpride unit", async () => {
  const a = await fixture(),
    b = await fixture(),
    c = await complete(b);
  const r = await signedPost(h, a.who, "/api/media/claims", {
    version: 2,
    purpose: "visit-photo",
    ownerId: c.visitId,
    mime: "image/jpeg",
    size: 3,
    sha256: "a".repeat(64),
  });
  expect(r.res.status).toBe(403);
});
test("F-322 topic authorization is partner-exact and withdrawn subscriptions cannot renew", async () => {
  const f = await fixture(),
    actor = await actorFor(h.db, f.portal.userId);
  expect(await partnerTopicAllowed(h.db, actor, `partner:${f.p.id}`)).toBe(
    true,
  );
  expect(await partnerTopicAllowed(h.db, actor, "visits")).toBe(false);
  expect(
    await partnerTopicAllowed(h.db, actor, `partner:${crypto.randomUUID()}`),
  ).toBe(false);
  await h.db`update distributor_users set effective_to=now() where distributor_id=${f.p.id} and profile_id=${f.portal.id}`;
  await expect(partnerContext(h.db, actor)).rejects.toThrow("ended");
});
test("F-322 office invitations use existing signup identities, forbid employee adoption and read back membership", async () => {
  const f = await fixture(),
    email = `${crypto.randomUUID()}@sample-agency.test`;
  const r = await request(office, "/invite", {
    partnerId: f.p.id,
    name: "New merchandiser",
    email,
    access: "field",
    requestKey: crypto.randomUUID(),
  });
  expect(r.res.status).toBe(200);
  const [p] = await h.db`select * from profiles where id=${r.body.profileId}`;
  expect(p.role).toBe("sales");
  expect(p.employment_type).toBe("third_party");
  expect(
    (await request(office, `/setup?partnerId=${f.p.id}`)).body.staff.some(
      (/** @type {any} */ m) => m.profile_id === p.id,
    ),
  ).toBe(true);
  expect(
    (
      await request(office, "/invite", {
        partnerId: f.p.id,
        name: "Hijack office",
        email: office.email,
        access: "portal",
        requestKey: crypto.randomUUID(),
      })
    ).res.status,
  ).toBe(409);
});

test("F-319 F-322 sample agency seed is additive, idempotent and keeps working logins in a 0600 record", async () => {
  const f = await fixture();
  const source = await person("sales");
  const [position] =
    await h.db`insert into positions(organization_id,code,label,category,active) values('sunpride',${crypto.randomUUID()},'Sample merchandiser','field',true) returning id`;
  await h.db`update profiles set position_id=${position.id} where id=${source.id}`;
  await h.db`insert into territory_salespeople(territory_id,profile_id,effective_from,actor_subject,reason) select territory_id,${source.id},effective_from,actor_subject,reason from territory_salespeople where profile_id=${f.staff.id}`;
  for (const p of [office, source])
    await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values(${BATCH},'profiles',${p.id},${`partner-fixture:${p.id}`})`;
  const credentialsPath = `${h.filesDir}/sample-agency-credentials.json`;
  const first = await ensurePartnerSamples(h.db, { credentialsPath });
  expect(first.status).toBe("ready");
  expect(first.accounts).toBe(3);
  const [{ n: before }] =
    await h.db`select count(*)::int n from sample_data_rows where key like 'agency:%'`;
  await ensurePartnerSamples(h.db, { credentialsPath });
  const [{ n: after }] =
    await h.db`select count(*)::int n from sample_data_rows where key like 'agency:%'`;
  expect(after).toBe(before);
  expect((await stat(credentialsPath)).mode & 0o777).toBe(0o600);
  const [database] = await h.db`select current_database() as name`;
  const record = await Bun.file(credentialsPath).json();
  const account = record[database.name].portal;
  const res = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  expect(res.status).toBe(200);
  const me = await h.fetch("/api/me", {
    headers: { cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" },
  });
  expect((await me.json()).partner.kind).toBe("agency");
}, 30000);

test("F-322 withdrawing staff blocks frozen export and billing command replay, not just fresh queries", async () => {
  const f = await fixture();
  await complete(f);
  const body = {
    partnerId: f.p.id,
    from: today(),
    to: today(),
    requestKey: crypto.randomUUID(),
  };
  const built = await request(f.portal, "/billing/build", body);
  expect(built.res.status).toBe(200);
  const [m] =
    await h.db`select id from distributor_users where distributor_id=${f.p.id} and profile_id=${f.staff.id} and effective_to is null`;
  expect(
    (
      await request(office, "/revoke", {
        partnerId: f.p.id,
        membershipId: m.id,
        requestKey: crypto.randomUUID(),
      })
    ).res.status,
  ).toBe(200);
  expect(
    (
      await request(
        f.portal,
        `/billing/export?partnerId=${f.p.id}&periodId=${built.body.id}`,
      )
    ).res.status,
  ).toBe(403);
  expect((await request(f.portal, "/billing/build", body)).res.status).toBe(
    403,
  );
});

test("F-322 a previously issued media upload token cannot bypass device or membership withdrawal", async () => {
  const f = await fixture(),
    v = await complete(f),
    bytes = new Uint8Array([255, 216, 255, 217]);
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const claim = await signedPost(h, f.who, "/api/media/claims", {
    version: 2,
    purpose: "visit-photo",
    ownerId: v.visitId,
    mime: "image/jpeg",
    size: bytes.length,
    sha256: hash,
  });
  expect(claim.res.status).toBe(200);
  await h.db`update registered_devices set status='revoked' where id=${f.who.deviceId}`;
  const upload = await h.fetch(`/api/media/uploads/${claim.body.uploadId}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${claim.body.uploadToken}`,
      "content-type": "image/jpeg",
    },
    body: bytes,
  });
  expect(upload.status).toBe(403);
  const [file] =
    await h.db`select status from files where id=${claim.body.uploadId}`;
  expect(file.status).not.toBe("stored");
});

test("F-322 real WebSocket fanout reauthorizes after partner access is withdrawn", async () => {
  const f = await fixture(),
    topic = `partner:${f.p.id}`;
  const ws = new WebSocket(
    h.origin.replace("http", "ws") + "/ws",
    /** @type {any} */ ({ headers: { cookie: f.portal.cookie } }),
  );
  /** @type {any[]} */ const messages = [];
  ws.addEventListener("message", (e) =>
    messages.push(JSON.parse(String(e.data))),
  );
  const next = async (/** @type {(m:any)=>boolean} */ pred) => {
    for (let n = 0; n < 200; n++) {
      const i = messages.findIndex(pred);
      if (i >= 0) return messages.splice(i, 1)[0];
      await Bun.sleep(10);
    }
    throw new Error("Socket event not received");
  };
  try {
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(undefined));
      ws.addEventListener("error", () => reject(new Error("Socket refused")));
    });
    ws.send(
      JSON.stringify({
        type: "subscribe",
        topics: [topic, "visits", `partner:${crypto.randomUUID()}`],
      }),
    );
    expect((await next((m) => m.type === "subscribed")).topics).toEqual([
      topic,
    ]);
    await publish(h.db, topic);
    expect((await next((m) => m.type === "invalidate")).topic).toBe(topic);
    await h.db`update distributor_users set effective_to=now() where profile_id=${f.portal.id} and distributor_id=${f.p.id}`;
    await publish(h.db, topic);
    await Bun.sleep(300);
    expect(messages.filter((m) => m.type === "invalidate")).toEqual([]);
  } finally {
    ws.close();
  }
});

test("F-322 agency field staff retain their own consent commands but never the team location feed", async () => {
  const f = await fixture();
  const headers = {
    authorization: `Bearer ${f.who.access}`,
    "content-type": "application/json",
  };
  const changed = await h.fetch("/api/v1/location/consent", {
    method: "POST",
    headers,
    body: JSON.stringify({ enabled: true }),
  });
  expect(changed.status).toBe(200);
  const current = await h.fetch("/api/v1/location/consent", { headers });
  expect((await current.json()).enabled).toBe(true);
  expect((await h.fetch("/api/v1/location/live", { headers })).status).toBe(
    403,
  );
  await h.db`update distributor_users set effective_to=now() where profile_id=${f.staff.id} and distributor_id=${f.p.id}`;
  expect(
    (
      await h.fetch("/api/v1/location/consent", {
        method: "POST",
        headers,
        body: JSON.stringify({ enabled: false }),
      })
    ).status,
  ).toBe(403);
});

test("F-319 daily billing follows the actual mid-day contract version, not the earlier midnight rate", async () => {
  const f = await fixture();
  await complete(f);
  const beginning = new Date(Date.now() - 660000);
  await h.db`update partner_contracts set effective_to=${beginning} where distributor_id=${f.p.id}`;
  await h.db`insert into partner_contracts(distributor_id,version,source_ref,sample,rate_centavos,minimum_calls,minimum_dwell_ms,required_kinds,effective_from,created_by) values(${f.p.id},2,'SAMPLE mid-day contract',true,70000,1,180000,array['merchandising'],${beginning},${office.id})`;
  const e = await evidenceOf(f);
  expect(e.body.rows[0].contractVersion).toBe(2);
  expect(e.body.summary.amountCentavos).toBe(70000);
});

test("F-322 ending store access also cancels pending grants without reactivation or deleted history", async () => {
  const f = await fixture(),
    future = new Date(Date.now() + 3600000);
  const scheduled = await request(office, "/outlet/set", {
    partnerId: f.p.id,
    outletId: f.outlet.id,
    allowed: true,
    effectiveFrom: future.toISOString(),
    requestKey: crypto.randomUUID(),
  });
  expect(scheduled.res.status).toBe(200);
  const ended = await request(office, "/outlet/set", {
    partnerId: f.p.id,
    outletId: f.outlet.id,
    allowed: false,
    requestKey: crypto.randomUUID(),
  });
  expect(ended.res.status).toBe(200);
  const [count] =
    await h.db`select count(*)::int total,count(*) filter(where effective_from<=${future} and (effective_to is null or effective_to>${future}))::int future_active,count(*) filter(where effective_from=effective_to)::int cancelled from partner_outlet_assignments where distributor_id=${f.p.id} and outlet_id=${f.outlet.id}`;
  expect(count).toEqual({ total: 2, future_active: 0, cancelled: 1 });
});

test("F-319 non-sample billing requires the operational incident evidence feed", async () => {
  const f = await fixture();
  await complete(f);
  const e = await evidenceOf(f);
  expect(typeof e.body.retailIssueFeedAvailable).toBe("boolean");
  await h.db`update distributors set source='office' where id=${f.p.id}`;
  const built = await request(f.portal, "/billing/build", {
    partnerId: f.p.id,
    from: today(),
    to: today(),
    requestKey: crypto.randomUUID(),
  });
  expect(built.res.status).toBe(e.body.retailIssueFeedAvailable ? 200 : 422);
  if (!e.body.retailIssueFeedAvailable)
    expect(built.body.error.code).toBe("needs_setup");
});

test("F-319 MERCH canonical operational cases are read through the staff-and-visit seam, never the QA tracker", async () => {
  const f = await fixture(),
    v = await complete(f);
  await retailTables();
  const [audit] =
    await h.db`insert into retail_execution_audits(visit_id,outlet_id,profile_id,org_unit_id,kind,request_key,payload_hash,captured_at,facts,actor_subject) values(${v.visitId},${f.outlet.id},${f.staff.id},${unit},'issue_log',${crypto.randomUUID()},'fixture',now(),${{ source: "sample" }},${f.staff.userId}) returning id`;
  await h.db`insert into retail_action_cases(audit_id,outlet_id,kind,status,due_at,facts) values(${audit.id},${f.outlet.id},'incident','open',now(),${{ source: "sample" }})`;
  const e = await evidenceOf(f);
  expect(e.res.status).toBe(200);
  expect(e.body.retailIssueFeedAvailable).toBe(true);
  expect(e.body.visits[0].issues).toContain("Field incident needs action");
  expect(e.body.summary.amountCentavos).toBe(0);
  await h.db`update retail_action_cases set status='resolved' where audit_id=${audit.id}`;
  const resolved = await evidenceOf(f);
  expect(resolved.body.summary.amountCentavos).toBe(65000);
  expect(resolved.body.evidenceHash).not.toBe(e.body.evidenceHash);
});

test("F-319 a retail score follows the versioned billing threshold and freezes its policy, not a hard-coded perfect score", async () => {
  await retailTables();
  const f = await fixture(),
    v = await complete(f);
  await h.db`insert into retail_execution_audits(visit_id,outlet_id,profile_id,org_unit_id,kind,request_key,payload_hash,component_score,captured_at,facts,actor_subject) values(${v.visitId},${f.outlet.id},${f.staff.id},${unit},'planogram',${crypto.randomUUID()},'sample-score',80,${new Date(Date.now() - 540000)},${{ source: "sample" }},${f.staff.userId})`;
  expect((await evidenceOf(f)).body.summary.amountCentavos).toBe(0);
  const from = new Date(early.getTime() + 1);
  await h.db`update partner_contracts set effective_to=${from} where distributor_id=${f.p.id}`;
  await h.db`insert into partner_contracts(distributor_id,version,source_ref,sample,rate_centavos,minimum_calls,minimum_dwell_ms,minimum_retail_score,required_kinds,effective_from,created_by) values(${f.p.id},2,'SAMPLE billing threshold',true,65000,1,180000,75,array['merchandising'],${from},${office.id})`;
  const e = await evidenceOf(f);
  expect(e.body.summary.amountCentavos).toBe(65000);
  expect(e.body.visits[0].sources.contractPolicy.minimumRetailScore).toBe(75);
  const published = await request(office, "/contract/set", {
    partnerId: f.p.id,
    requestKey: crypto.randomUUID(),
    sourceRef: "SAMPLE next threshold",
    rateCentavos: 65000,
    minimumCalls: 1,
    minimumDwellMs: 180000,
    minimumRetailScore: 85,
    requiredKinds: ["merchandising"],
    effectiveFrom: new Date(Date.now() + 3600000).toISOString(),
  });
  expect(published.res.status).toBe(200);
  const setup = await request(office, "/setup?partnerId=" + f.p.id);
  expect(
    setup.body.contracts.find(
      (/** @type {any} */ k) => k.id === published.body.id,
    ).minimum_retail_score,
  ).toBe(85);
});

async function retailTables() {
  // Exact columns consumed from MERCH migration 0540; fixture tables only.
  await h.db`create table if not exists retail_execution_audits(id uuid primary key default gen_random_uuid(),organization_id text not null default 'sunpride',visit_id uuid not null,outlet_id uuid not null,profile_id uuid not null,org_unit_id uuid not null,kind text not null,request_key uuid not null,payload_hash text not null,master_version_id uuid,component_score numeric,captured_at timestamptz not null,facts jsonb not null,actor_subject text not null,created_at timestamptz default now(),updated_at timestamptz default now())`;
  await h.db`create table if not exists retail_action_cases(id uuid primary key default gen_random_uuid(),audit_id uuid not null,outlet_id uuid not null,kind text not null,status text not null default 'open',owner_profile_id uuid,due_at timestamptz not null,facts jsonb not null,created_at timestamptz default now(),updated_at timestamptz default now())`;
}
