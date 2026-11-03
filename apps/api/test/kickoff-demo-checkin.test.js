import { afterAll, beforeAll, expect, test } from "bun:test";
import { applyKickoffDemo, addDays, manilaDate } from "../../../packages/db/seed/kickoff-demo.js";
import { seedDemo } from "../../../packages/db/seed/index.js";
import { domainInstallers } from "../src/domains/index.js";
import { configuration, profileAt } from "../src/domains/callflow/engine.js";
import {
  bind,
  deviceKey,
  nativeSignIn,
  signedPost,
  startHarness,
} from "./harness.js";

/**
 * Proof that the plan `packages/db/seed/kickoff-demo.js` generates is accepted by the REAL `visit.checkIn` command
 * (full API composition, real identity hooks, real device sign-in/bind and signed `/api/sync/push`) - not merely that
 * SQL preconditions look right. Isolated throwaway database only; the only fixtures are the sample seed, a test
 * password on the sample agent's login in that throwaway database, and a locally generated P-256 phone key.
 */
/** @type {import('./harness.js').Harness} */ let h;
const PASSWORD = "kickoff-proof-password";
/** @type {any} */ let agent;
/** @type {any} */ let applied;
/** @type {any} */ let phone;
/** @type {any} */ let device;
const now = Date.now();
const today = manilaDate(now);

beforeAll(async () => {
  h = await startHarness({ installers: domainInstallers });
  // Seed far enough back that the seeded Oct/Nov-style sample plans do not cover today.
  await seedDemo(h.db, { anchorDate: addDays(today, -90), days: 7 });
  [agent] =
    await h.db`select id,user_id,email,org_unit_id from profiles where email='agent@sunpride.test'`;
  const hash = await Bun.password.hash(PASSWORD, { algorithm: "argon2id" });
  await h.db`update users set password_hash=${hash} where id=${agent.user_id}`;
  // The helper under test: real approval by the real supervisor, activated because the window starts today.
  applied = await applyKickoffDemo(h.db, { from: today, days: 1, now, approve: true });
  // Real sign-in. The sample agent's FIRST phone self-registers with the P-256 proof (registerSamplePhone),
  // then the normal bind challenge binds it. Nothing is inserted into registered_devices by hand.
  phone = await deviceKey();
  const signIn = await nativeSignIn(h, agent.email, PASSWORD, "field-android", {
    keyId: phone.keyId,
    publicKeySpki: phone.publicKeySpki,
  });
  expect(signIn.res.status).toBe(200);
  const [row] =
    await h.db`select id from registered_devices where profile_id=${agent.id} and app='field-android'`;
  const bound = await bind(h, signIn.body.accessToken, row.id, phone);
  expect(bound.body.bindingStatus).toBe("bound");
  device = { access: signIn.body.accessToken, deviceId: row.id, key: phone, app: "field-android" };
}, 180_000);
afterAll(async () => {
  await h?.close();
});

/** @param {any} payload */
const checkIn = (payload) => ({
  clientOpId: crypto.randomUUID(),
  opType: "visit.checkIn",
  clientTime: payload.deviceTime,
  dependsOn: [],
  payload,
});
/** @param {any[]} operations */
async function push(operations) {
  const r = await signedPost(h, device, "/api/sync/push", {
    version: 2,
    app: device.app,
    deviceId: device.deviceId,
    scopeId: agent.org_unit_id,
    operations,
  });
  expect(r.res.status).toBe(200);
  return /** @type {any[]} */ (r.body.results);
}

test("generated plan is active with five planned calls for today", async () => {
  expect(applied.activation).toEqual(["activated"]);
  expect(applied.verify.plans[0]).toMatchObject({ status: "active", signed: true, capacity: "supervisor" });
  expect(applied.verify.plannedVisitsPerDay).toEqual({ [today]: 5 });
});

test("real visits.checkIn accepts the generated planned call, rejects a mismatched one, and replays", async () => {
  const planned = await h.db`select v.id,v.outlet_id,s.sequence,v.intents from planned_visits v
    join coverage_plan_slots s on s.id=v.plan_slot_id where v.plan_id=${applied.plans[0]} and v.status='planned' order by s.sequence`;
  expect(planned).toHaveLength(5);
  const [first, second] = planned;
  // The phone receives its call-flow configuration (definition + verified pin) from the server and echoes the definition id.
  const [outlet] = await h.db`select * from outlets where id=${first.outlet_id}`;
  const at = Date.now();
  const config = await configuration(
    h.db,
    await profileAt(h.db, device.app, outlet, at, agent.id),
    outlet,
    at,
  );
  expect(config?.pin).toBeTruthy();
  const fix = {
    latitude: Number(config.pin.latitude),
    longitude: Number(config.pin.longitude),
    accuracyMeters: 5,
    fixTime: Date.now(),
    provider: "gps",
    mockSignal: false,
  };
  const base = (/** @type {any} */ v) => ({
    clientVisitId: crypto.randomUUID(),
    plannedVisitId: v.id,
    outletId: v.outlet_id,
    serviceDate: today,
    deviceTime: Date.now(),
    location: fix,
    intents: v.intents,
    flowDefinitionId: config.definition.id,
  });

  // a call that names another store's planned visit is refused by the real plan validation
  const wrong = checkIn({ ...base(first), outletId: second.outlet_id });
  const [refused] = await push([wrong]);
  expect(refused).toMatchObject({ status: "rejected", code: "invalid_plan" });
  expect((await h.db`select count(*)::int n from visit_executions where assignee_profile_id=${agent.id} and service_date=${today}`)[0].n).toBe(0);

  // the generated first call is accepted
  const ok = checkIn(base(first));
  const [accepted] = await push([ok]);
  expect(accepted.status).toBe("applied");
  const [visit] =
    await h.db`select * from visit_executions where id=${accepted.ack.entityId}`;
  expect(visit).toMatchObject({
    planned_visit_id: first.id,
    plan_id: applied.plans[0],
    assignee_profile_id: agent.id,
    outlet_id: first.outlet_id,
    state: "checked-in",
    source: "planned",
  });

  // an identical replay is a duplicate with the same ack; no second execution
  const [replay] = await push([ok]);
  expect(replay.status).toBe("duplicate");
  expect(replay.ack).toEqual(accepted.ack);
  expect((await h.db`select count(*)::int n from visit_executions where assignee_profile_id=${agent.id} and service_date=${today}`)[0].n).toBe(1);
});
