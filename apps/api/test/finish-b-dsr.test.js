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
import { domainInstallers } from "../src/domains/index.js";
import { ensureCallflowSamples } from "../../../packages/db/seed/callflow.js";
import { invite } from "../src/domains/distributors/setup.js";
import { profileAt, configuration } from "../src/domains/callflow/engine.js";
import { scopeOf } from "../src/core/scope.js";
import { actorFor } from "../src/core/context.js";
import { manilaDate } from "../src/domains/visits/shared.js";

/** @type {any} */ let h;
/** @type {any} */ let d;
/** @type {any} */ let who;
/** @type {any} */ let actor;
/** @type {any} */ let store;
let unit = "",
  rep = "",
  visit = "",
  product = "";
const id = () => crypto.randomUUID(),
  early = new Date(Date.now() - 86400000);
beforeAll(async () => {
  h = await startHarness({ installers: domainInstallers });
  const [u] =
    await h.db`insert into org_units(organization_id,code,name,type_code,status,effective_from) values('sunpride','SUNPRIDE','Sample company','national','active',${early}) returning id`;
  unit = u.id;
  await ensureCallflowSamples(h.db, Date.now() - 86400000);
  [d] =
    await h.db`insert into distributors(code,name,org_unit_id,status,source,partner_kind,effective_from) values('SAMPLE-DSR','Sample distributor',${unit},'accredited','sample','distributor',${early}) returning *`;
  const saved = await invite({ db: h.db, actor: { subject: "fixture" } }, d, {
    access: "field",
    name: "Sample DSR",
    email: "sample-dsr@example.com",
    grants: ["read", "dsr"],
  });
  rep = saved.profileId;
  const user = await createUser(h, saved.email, "Test-only-DSR-password");
  await h.db`update profiles set user_id=${user},auth_subject=${user} where id=${rep}`;
  const [t] =
    await h.db`insert into territories(organization_id,code,name,status,effective_from,created_by) values('sunpride','SAMPLE-DSR','Sample territory','active',${early},'fixture') returning id`;
  await h.db`insert into territory_ownerships(territory_id,org_unit_id,effective_from,actor_subject,reason) values(${t.id},${unit},${early},'fixture','Sample assignment')`;
  await h.db`insert into territory_salespeople(territory_id,profile_id,effective_from,actor_subject,reason) values(${t.id},${rep},${early},'fixture','Sample assignment')`;
  [store] =
    await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,created_by,enrolment_status) values('sunpride','SAMPLE-DSR','Sample shared store','active',${unit},'fixture','approved') returning *`;
  await h.db`insert into outlet_assignments(outlet_id,territory_id,effective_from,actor_subject,reason) values(${store.id},${t.id},${early},'fixture','Sample assignment')`;
  const [replica] =
    await h.db`insert into distributor_master_versions(distributor_id,source,source_key,version,payload_hash,payload,effective_from) values(${d.id},'sample','SAMPLE-DSR',1,'fixture',${{ products: [], terms: {} }},${early}) returning id`;
  await h.db`insert into distributor_outlets(distributor_id,outlet_id,territory_id,master_version_id,effective_from) values(${d.id},${store.id},${t.id},${replica.id},${early})`;
  await h.db`insert into outlet_pins(outlet_id,latitude,longitude,radius_meters,source,status,effective_from,proposed_by,proposed_at,verified_by,verified_at) values(${store.id},10.33,123.94,100,'sample','verified',${early},'first',${early},'second',${early})`;
  product = id();
  const master = id();
  await h.db`insert into products(id,code,name,category,uom,unit_price,active,organization_id) values(${product},'SAMPLE-DSR','Sample DSR SKU','Sample','PC',0,true,'sunpride')`;
  await h.db`insert into master_definitions(id,kind,code) values(${master},'msl','SAMPLE-DSR')`;
  await h.db`insert into master_versions(master_id,version,label,status,data,effective_from,reason) values(${master},1,'Sample shared MSL','active',${{ productIds: [product] }},${early},'Sample fixture')`;
  const key = await deviceKey(),
    deviceId = await registerDevice(h, {
      profileId: rep,
      orgUnitId: unit,
      key,
    });
  const login = await nativeSignIn(
    h,
    saved.email,
    "Test-only-DSR-password",
    "field-android",
    { keyId: key.keyId, publicKeySpki: key.publicKeySpki },
  );
  expect(login.res.status).toBe(200);
  who = { access: login.body.accessToken, deviceId, key };
  expect((await bind(h, who.access, deviceId, key)).res.status).toBe(200);
  actor = await actorFor(h.db, user);
}, 60000);
afterAll(async () => {
  await h?.close();
});
const pull = () =>
  signedPost(h, who, "/api/sync/pull", {
    version: 2,
    scopes: [
      {
        scopeId: unit,
        projection: "field.bundle",
        params: { dayFrom: manilaDate(Date.now()) },
      },
    ],
  });
/** @param {string} type @param {any} payload */
const push = (type, payload) =>
  signedPost(h, who, "/api/sync/push", {
    version: 2,
    scopeId: unit,
    operations: [
      {
        clientOpId: id(),
        opType: type,
        clientTime: payload.deviceTime,
        dependsOn: [],
        payload,
      },
    ],
  });
test("F-407 dedicated DSR uses shared field bundle, canonical MSL and distributor call configuration", async () => {
  const result = await pull();
  expect(result.res.status).toBe(200);
  const data = result.body.bundles[0].data;
  expect(data.outlets.map((/** @type {any} */ o) => o.id)).toEqual([store.id]);
  expect(data.outlets[0].availability.lines[0].productId).toBe(product);
  expect(await profileAt(h.db, "field-android", store, Date.now(), rep)).toBe(
    "distributor_rep",
  );
  expect(data.localCustomers).toEqual([]);
  const config = await configuration(
    h.db,
    "distributor_rep",
    store,
    Date.now(),
  );
  const at = Date.now();
  const checkIn = await push("visit.checkIn", {
    clientVisitId: id(),
    outletId: store.id,
    serviceDate: manilaDate(at),
    intents: ["sell"],
    unplannedReason: "Sample DSR call",
    deviceTime: at,
    flowDefinitionId: config.definition.id,
    location: {
      latitude: 10.33,
      longitude: 123.94,
      accuracyMeters: 5,
      fixTime: at,
      provider: "gps",
      mockSignal: false,
    },
  });
  expect(checkIn.res.status).toBe(200);
  expect(checkIn.body.results[0].status).toBe("applied");
  visit = checkIn.body.results[0].ack.entityId;
  const [call] =
    await h.db`select definition_snapshot from call_executions where visit_id=${visit}`;
  expect(call.definition_snapshot.channelProfile).toBe("distributor_rep");
});
test("F-407 DSR cannot access office endpoints and withdrawn outlet grants retire native scope", async () => {
  const office = await h.fetch("/api/v1/org/tree", {
    headers: { authorization: `Bearer ${who.access}` },
  });
  expect(office.status).toBe(403);
  const before = await scopeOf(h.db, actor);
  await h.db`update distributor_outlets set effective_to=now() where distributor_id=${d.id}`;
  expect((await scopeOf(h.db, actor)).fingerprint).not.toBe(before.fingerprint);
  const result = await push("visit.activity", {
    visitId: visit,
    deviceTime: Date.now(),
    activity: { kind: "note", text: "Must be refused" },
  });
  expect(result.res.status).toBe(403);
  const [notes] =
    await h.db`select count(*)::int n from visit_activities where visit_id=${visit} and activity_kind='note'`;
  expect(notes.n).toBe(0);
});
