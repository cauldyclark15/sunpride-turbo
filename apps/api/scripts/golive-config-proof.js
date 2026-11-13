#!/usr/bin/env bun
// SP-0173 end-to-end proof on a RESTORED SCRATCH copy only (refuses any other database).
// A Route Sales rep captures a customer from the field app (signed census.capture), the store
// lands on the client's channel values, then a field call (check-in -> close with a no-order
// reason) and a van call (bundle -> call.start -> call.close) run on that store through the
// signed sync API with the re-bound call flows. All rows it writes are scratch fixtures.
//   DATABASE_URL=<scratch> bun apps/api/scripts/golive-config-proof.js
import { createDb } from "@sunpride/db/client";
import { createApp } from "../src/core/app.js";
import { configuration, profileAt } from "../src/domains/callflow/engine.js";
import { SAMPLE_IMAGE } from "../src/domains/masters/catalogue.js";
import { manilaDate } from "../src/domains/visits/shared.js";
import {
  deviceKey,
  registerDevice,
  nativeSignIn,
  bind,
  signedPost,
} from "../test/harness.js";

const url = process.env.DATABASE_URL;
if (!url || !/\/sp0173_scratch(\?|$)/.test(url)) {
  console.error("Scratch database only (sp0173_scratch)");
  process.exit(2);
}
const db = createDb(url, { max: 10 });
const app = createApp({
  db,
  dbUrl: url,
  env: {
    ...process.env,
    SYNC_CURSOR_SECRET: "sp0173-scratch-cursor-secret-0123456789abcdef",
    FILES_DIR: `${process.env.TMPDIR}/sp0173-files`,
  },
});
const server = await app.start({
  port: 0,
  hostname: "127.0.0.1",
  schedule: false,
});
const origin = `http://127.0.0.1:${server.port}`;
const h = { db, fetch: (p, i) => fetch(`${origin}${p}`, i) };
const out = { checks: [] };
const check = (name, ok, detail) => {
  out.checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) throw new Error(`FAILED ${name}: ${JSON.stringify(detail)}`);
};
const DAY = 86400000;
const now = Date.now(),
  early = new Date(now - 10 * DAY),
  day = manilaDate(now);

const [unit] =
  await db`select id from org_units where code='BR-CEBU' and status='active'`;
const [routeSalesPos] =
  await db`select id from positions where code='SR_ROUTE_SALESMAN'`;

async function rep(app, label) {
  const email = `sp0173-${label}-${crypto.randomUUID().slice(0, 6)}@scratch.invalid`,
    password = "scratch-proof-only-password";
  const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
  const [u] =
    await db`insert into users(email,password_hash) values(${email},${hash}) returning id`;
  const [p] =
    await db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id,position_id) values(${u.id},${u.id},${`Scratch ${label}`},${email},'sales','active',${unit.id},${routeSalesPos?.id ?? null}) returning id`;
  await db`insert into employee_assignments(profile_id,org_unit_id,role,position_id,effective_from,actor_subject,reason) values(${p.id},${unit.id},'sales',${routeSalesPos?.id ?? null},${early},${u.id},'SP-0173 scratch proof')`;
  const key = await deviceKey();
  const deviceId = await registerDevice(h, {
    profileId: p.id,
    orgUnitId: unit.id,
    app,
    key,
  });
  const { body: tokens } = await nativeSignIn(h, email, password, app, {
    keyId: key.keyId,
    publicKeySpki: key.publicKeySpki,
  });
  const b = await bind(h, tokens.accessToken, deviceId, key);
  if (b.body.bindingStatus !== "bound")
    throw new Error(`bind ${JSON.stringify(b.body)}`);
  const who = { access: tokens.accessToken, deviceId, key };
  return {
    userId: u.id,
    profileId: p.id,
    who,
    get: async (path) => {
      const r = await h.fetch(path, {
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      });
      return { status: r.status, body: await r.json() };
    },
    push: async (opType, payload) =>
      (
        await signedPost(h, who, "/api/sync/push", {
          version: 2,
          app,
          deviceId,
          scopeId: unit.id,
          operations: [
            {
              clientOpId: crypto.randomUUID(),
              opType,
              clientTime: payload.deviceTime,
              dependsOn: [],
              payload,
            },
          ],
        })
      ).body.results[0],
  };
}

try {
  const field = await rep("field-android", "field");
  // --- 1. what the phone offers: template channels, no Sample --------------------------------
  const cfg = await field.get("/api/v1/masters/census-config");
  check("census-config 200", cfg.status === 200, cfg.status);
  const labels = (cfg.body.channels ?? []).map((c) => c.label ?? c.name);
  check(
    "census-config channels are the template's, none 'Sample'",
    labels.includes("Route Sales") && !labels.some((l) => /sample/i.test(l)),
    labels,
  );
  const dc = cfg.body.customerMaster.lists
    .filter((l) => l.list === "distribution_channel")
    .map((l) => `${l.code} ${l.name}`);
  check(
    "customerMaster offers Distribution Channel 41 Route Sales",
    dc.includes("41 Route Sales"),
    dc,
  );

  // --- 2. field capture -> customer on the client's values ------------------------------------
  const photo = Buffer.from(
    await Bun.file(SAMPLE_IMAGE).arrayBuffer(),
  ).toString("base64");
  const fix = {
    latitude: 10.3312,
    longitude: 123.9056,
    accuracyMeters: 9,
    fixTime: Date.now(),
    mockSignal: false,
    provider: "gps",
  };
  const captureId = crypto.randomUUID();
  const cap = await field.push("census.capture", {
    captureId,
    name: "SP-0173 Scratch Sari-Sari",
    address: "12 Gorordo Ave, Apas, City of Cebu, Cebu 6000",
    ownerName: "Scratch Owner",
    ownerPhone: "09175550101",
    deviceTime: Date.now(),
    locationSource: "gps",
    location: fix,
    photoJpegBase64: photo,
    customer: {
      customerName: "SP-0173 Scratch Sari-Sari",
      mobileNo: "09175550101",
      regionCode: "0700000000",
      provinceCode: "0702200000",
      municipalityCode: "0730600000",
      barangayCode: "0730600003",
      houseNo: "12",
      street1: "Gorordo Ave",
      postalCode: "6000",
      salesOrgCode: "1000",
      distributionChannelCode: "41",
      customerGroup1Code: "RSF",
      customerGroup2Code: "RSS",
      customerGroupCode: "74",
      typeOfBusiness: "Sole Proprietor",
    },
  });
  check("census.capture applied", cap.status === "applied", cap);
  const [store] =
    await db`select o.id,o.code,o.channel,o.status,cp.distribution_channel_code dc,cp.customer_group1_code g1,cp.customer_group2_code g2,cp.completeness
    from outlets o join customer_profiles cp on cp.outlet_id=o.id where o.name='SP-0173 Scratch Sari-Sari' order by o.created_at desc limit 1`;
  check(
    "captured store carries 41 / RSF / RSS and price/flow key 41",
    store &&
      store.dc === "41" &&
      store.g1 === "RSF" &&
      store.g2 === "RSS" &&
      store.channel === "41",
    store,
  );
  const [tax] =
    await db`select c.code ch_code,cv.label ch_label,s.code sub_code,sv.label sub_label from master_channel_aliases a
      join master_definitions c on c.id=a.channel_id join master_versions cv on cv.master_id=c.id and cv.effective_to is null
      join master_definitions s on s.id=a.subchannel_id join master_versions sv on sv.master_id=s.id and sv.effective_to is null
      where a.legacy_key=lower(${store.channel})`;
  check(
    "store key 41 resolves to channel master 41 Route Sales / RSF RS Frozen",
    tax?.ch_code === "41" &&
      tax.ch_label === "Route Sales" &&
      tax.sub_code === "RSF" &&
      tax.sub_label === "RS Frozen",
    tax,
  );
  const list = await field.get(
    `/api/v1/customers?distributionChannelCode=41&q=${encodeURIComponent("SP-0173")}`,
  );
  const row = list.body.rows?.find(
    (r) => r.id === store.id || r.customerName === "SP-0173 Scratch Sari-Sari",
  );
  out.webCustomerRow = row
    ? {
        distributionChannel: `${row.distributionChannelCode} ${row.distributionChannelName}`,
        grp1: `${row.customerGroup1Code} ${row.customerGroup1Name}`,
        grp2: `${row.customerGroup2Code} ${row.customerGroup2Name}`,
      }
    : { status: list.status };

  // --- 3. make the prospect callable (scratch fixtures: pin verified, territory, route) -------
  const outletId = store.id;
  await db`update outlets set status='active',custodian_org_unit_id=${unit.id} where id=${outletId}`;
  await db`update outlet_pins set effective_to=now() where outlet_id=${outletId} and effective_to is null`;
  await db`insert into outlet_pins(outlet_id,latitude,longitude,radius_meters,source,status,effective_from,proposed_by,proposed_at,verified_by,verified_at)
    values(${outletId},${fix.latitude},${fix.longitude},100,'fixture','verified',${early},'scratch-a',${early},'scratch-b',${early})`;
  const [territory] =
    await db`insert into territories(organization_id,code,name,status,effective_from,created_by) values('sunpride',${`SP0173-${crypto.randomUUID().slice(0, 6)}`},'Scratch Cebu','active',${early},'sp0173') returning id`;
  await db`insert into territory_ownerships(territory_id,org_unit_id,effective_from,actor_subject,reason) values(${territory.id},${unit.id},${early},'sp0173','Scratch')`;
  await db`insert into outlet_assignments(outlet_id,territory_id,effective_from,actor_subject,reason) values(${outletId},${territory.id},${early},'sp0173','Scratch')`;
  await db`insert into territory_salespeople(territory_id,profile_id,effective_from,actor_subject,reason) values(${territory.id},${field.profileId},${early},'sp0173','Scratch')`;

  // --- 4. field call: binding 41 -> field_selling; check-in, close with no-order reason --------
  const outlet = { id: outletId, channel: "41" };
  const fprof = await profileAt(db, "field-android", outlet, Date.now());
  check(
    "field-android resolves Route Sales store to field_selling",
    fprof === "field_selling",
    fprof,
  );
  const fc = await configuration(db, fprof, outlet, Date.now());
  check(
    "field call flow label has no Sample",
    fc && !/sample/i.test(fc.definition.label),
    fc?.definition?.label,
  );
  const t0 = Date.now(),
    loc = { ...fix, fixTime: t0, accuracyMeters: 5 };
  const ci = await field.push("visit.checkIn", {
    clientVisitId: crypto.randomUUID(),
    plannedVisitId: null,
    unplannedReason: "Go-live config proof",
    outletId,
    serviceDate: day,
    intents: ["sell"],
    deviceTime: t0,
    location: loc,
    flowDefinitionId: fc.definition.id,
  });
  check("field check-in applied", ci.status === "applied", ci);
  const visitId = ci.ack.entityId;
  const co = await field.push("visit.checkOut", {
    visitId,
    outcome: "nonproductive",
    reasonCode: "no_demand",
    zeroSaleReason: "no_demand",
    shortCallReason: "Go-live config proof",
    deviceTime: t0 + 1000,
    location: { ...loc, fixTime: t0 + 1000 },
  });
  check(
    "field close with no-order reason applied",
    co.status === "applied",
    co,
  );
  const [fcall] =
    await db`select state,definition_snapshot,zero_sale_reason from call_executions where visit_id=${visitId}`;
  check(
    "field call closed on field_selling with no_demand",
    fcall?.state === "closed" &&
      fcall.definition_snapshot.channelProfile === "field_selling" &&
      fcall.zero_sale_reason.code === "no_demand",
    {
      state: fcall?.state,
      profile: fcall?.definition_snapshot?.channelProfile,
      label: fcall?.definition_snapshot?.label,
      reason: fcall?.zero_sale_reason,
    },
  );

  // --- 5. van call: binding 41 -> van_selling via bundle, call.start, call.close ---------------
  const van = await rep("van-android", "van");
  await db`insert into territory_salespeople(territory_id,profile_id,effective_from,actor_subject,reason) values(${territory.id},${van.profileId},${early},'sp0173','Scratch')`;
  const trip = crypto.randomUUID(),
    vehicle = crypto.randomUUID(),
    truck = crypto.randomUUID(),
    depot = crypto.randomUUID(),
    route = crypto.randomUUID();
  for (const [id, type] of [
    [truck, "truck"],
    [depot, "warehouse"],
  ])
    await db`insert into inventory_locations(id,organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production)
      values(${id},'sunpride',${unit.id},'SP0173',${id},'Scratch location',${type},true,true,true,true,false)`;
  await db`insert into vehicles(id,organization_id,org_unit_id,vehicle_code,plate_number,truck_location_id,home_location_id,status,created_by)
    values(${vehicle},'sunpride',${unit.id},${vehicle},'SCRATCH',${truck},${depot},'active','sp0173')`;
  await db`insert into routes(id,organization_id,code,name,status,effective_from,created_by) values(${route},'sunpride',${route},'Scratch route','active',${early},'sp0173')`;
  await db`insert into route_territories(route_id,territory_id,effective_from,actor_subject,reason) values(${route},${territory.id},${early},'sp0173','Scratch')`;
  await db`update outlet_assignments set route_id=${route},sequence=1 where outlet_id=${outletId}`;
  await db`insert into van_trips(id,organization_id,org_unit_id,trip_number,vehicle_id,truck_location_id,source_location_id,service_date,salesperson_profile_id,salesperson_subject,status,started_at,started_device_id,created_by,route_id)
    values(${trip},'sunpride',${unit.id},${trip},${vehicle},${truck},${depot},${day},${van.profileId},${van.userId},'active',now(),null,'sp0173',${route})`;
  const bundle = await signedPost(h, van.who, "/api/sync/pull", {
    version: 2,
    app: "van-android",
    deviceId: van.who.deviceId,
    since: null,
    pageCursor: null,
    scopes: [
      {
        scopeId: unit.id,
        projection: "van.bundle",
        params: { serviceDate: day },
      },
    ],
    limit: 100,
  });
  check(
    "van bundle 200",
    bundle.res.status === 200,
    bundle.body?.error ?? bundle.res.status,
  );
  const offered = bundle.body.bundles?.[0]?.data?.customers?.find(
    (o) => o.outletId === outletId,
  );
  check(
    "van bundle offers the store with van_selling flow",
    offered?.callFlow?.definition?.channelProfile === "van_selling",
    {
      flow: offered?.callFlow?.definition?.channelProfile,
      label: offered?.callFlow?.definition?.label,
      channel: offered?.channel,
    },
  );
  const t1 = Date.now(),
    clientCallId = crypto.randomUUID();
  const vs = await van.push("call.start", {
    tripId: trip,
    clientCallId,
    outletId,
    flowDefinitionId: offered.callFlow.definition.id,
    deviceTime: t1,
    location: { ...fix, fixTime: t1, accuracyMeters: 5 },
    unplannedReason: "Go-live config proof",
  });
  check("van call.start applied", vs.status === "applied", vs);
  const vc = await van.push("call.close", {
    tripId: trip,
    clientCallId,
    deviceTime: t1 + 1000,
    location: { ...fix, fixTime: t1 + 1000, accuracyMeters: 5 },
    shortCallReason: "Go-live config proof",
    zeroSaleReason: "buyer_unavailable",
  });
  check("van call.close applied", vc.status === "applied", vc);
  const [vcall] =
    await db`select state,definition_snapshot,zero_sale_reason from call_executions where client_call_id=${clientCallId}`;
  check(
    "van call closed on van_selling with buyer_unavailable",
    vcall?.state === "closed" &&
      vcall.definition_snapshot.channelProfile === "van_selling" &&
      vcall.zero_sale_reason.code === "buyer_unavailable",
    {
      state: vcall?.state,
      profile: vcall?.definition_snapshot?.channelProfile,
      label: vcall?.definition_snapshot?.label,
      reason: vcall?.zero_sale_reason,
    },
  );
  out.ok = true;
} catch (e) {
  out.ok = false;
  out.error = String(e?.message ?? e);
}
console.log(JSON.stringify(out, null, 1));
await app.stop().catch(() => {});
await db.close();
process.exit(out.ok ? 0 : 1);
