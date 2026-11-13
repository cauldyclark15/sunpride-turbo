import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import {
  startHarness,
  profileStore,
  boundDevice,
  createUser,
  signedPost,
} from "./harness.js";
import { actorFor } from "../src/core/context.js";
import { tx } from "@sunpride/db/client";
import {
  temperatureAssessment,
  validatePolicy,
} from "../src/domains/van/route-policy.js";
import { containerBalances } from "../src/domains/van/route-evidence.js";
import {
  submitSettlement,
  decideSettlement,
  decideVariance,
} from "../src/domains/van/settlement.js";
import { today } from "../src/domains/van/model.js";
import { exerciseRoute } from "./vanops-route-proof.js";

mock.module("../src/domains/org/scope.js", () => ({
  scopeFilterForActor: async () => ({ unitIds: null }),
  outletOwnerUnit: async (/** @type {any} */ db, /** @type {string} */ id) =>
    (await db`select custodian_org_unit_id from outlets where id=${id}`)[0]
      ?.custodian_org_unit_id,
}));
const { install } = await import("../src/domains/van/index.js");
/** @type {any} */ let h;
/** @type {any} */ let who;
/** @type {any} */ let boss;
/** @type {any} */ let trip;
/** @type {any} */ let actor;
/** @type {any} */ let office;
const unit = crypto.randomUUID(),
  truck = crypto.randomUUID(),
  depot = crypto.randomUUID(),
  vehicle = crypto.randomUUID(),
  outlet = crypto.randomUUID();
const policy = {
  intervalMinutes: 60,
  bands: [
    { productId: null, label: "Sample frozen", minDeciC: -250, maxDeciC: -180 },
  ],
};
/** @type {any[]} */ const accepted = [];
beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  const profiles = profileStore(h);
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','ROOT','Sample team','national','active',now()-interval '10 days')`;
  who = await boundDevice(h, profiles, { app: "van-android", orgUnitId: unit });
  const userId = await createUser(
    h,
    "boss-vanops@example.com",
    "correct horse battery",
  );
  boss = {
    userId,
    email: "boss-vanops@example.com",
    profile: profiles.set(userId, { role: "super_admin", orgUnitId: unit }),
  };
  for (const u of [who, boss]) {
    await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${u.profile.id},${u.userId},${u.userId},${u.profile.name},${u.email},${u.profile.role},'active',${unit})`;
    await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${u.profile.id},${unit},${u.profile.role},now()-interval '10 days','fixture','fixture')`;
  }
  for (const [id, code, type] of [
    [depot, "DEPOT", "warehouse"],
    [truck, "TRUCK", "truck"],
  ])
    await h.db`insert into inventory_locations(id,organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values(${id},'sunpride',${unit},'CEBU',${code},${code},${type},true,true,true,true,false)`;
  await h.db`insert into vehicles(id,organization_id,org_unit_id,vehicle_code,plate_number,truck_location_id,home_location_id,status,created_by) values(${vehicle},'sunpride',${unit},'VANOPS','SAMPLE',${truck},${depot},'active',${boss.userId})`;
  const [t] =
    await h.db`insert into van_trips(organization_id,org_unit_id,trip_number,vehicle_id,truck_location_id,source_location_id,service_date,salesperson_profile_id,salesperson_subject,status,created_by,operations_version,started_device_id,start_odometer_km) values('sunpride',${unit},'SAMPLE-VANOPS',${vehicle},${truck},${depot},${today()},${who.profile.id},${who.userId},'active',${boss.userId},1,${who.deviceId},1000) returning *`;
  trip = t;
  await h.db`insert into outlets(id,organization_id,code,name,status,custodian_org_unit_id,channel,created_by) values(${outlet},'sunpride','STORE','Sample store','active',${unit},'GT','fixture')`;
  for (const [kind, facts] of Object.entries({
    cold_chain: policy,
    variance: { toleranceBasisPoints: 50, escalateAfterHours: 24 },
    returnables: { items: [{ code: "crate", label: "Sample crate" }] },
    return_reasons: {
      items: [
        { code: "damaged", label: "Damaged" },
        { code: "expired", label: "Expired" },
      ],
    },
  }))
    await h.db`insert into van_policy_versions(org_unit_id,kind,effective_from,source_ref,facts,created_by) values(${unit},${kind},now()-interval '10 days','SAMPLE',${facts},${boss.profile.id})`;
  actor = await actorFor(h.db, who.userId);
  office = await actorFor(h.db, boss.userId);
}, 30000);
afterAll(async () => {
  await h?.close();
});
/** @param {string} kind @param {any} p */
function op(kind, p) {
  const at = Date.now();
  return {
    clientOpId: crypto.randomUUID(),
    opType: kind,
    clientTime: at,
    dependsOn: [],
    payload: {
      tripId: trip.id,
      settlementVersion: 1,
      observationId: crypto.randomUUID(),
      ...p,
      deviceTime: at,
    },
  };
}
/** @param {any} o */
async function push(o) {
  return signedPost(h, who, "/api/sync/push", {
    version: 2,
    app: "van-android",
    deviceId: who.deviceId,
    scopeId: unit,
    operations: [o],
  });
}
/** @param {any} o */
async function apply(o) {
  const r = await push(o);
  expect(r.res.status).toBe(200);
  expect(r.body.results[0].status).toBe("applied");
  accepted.push(o);
  return r;
}

test("F-115 effective bands catch excursions and reject missing/ambiguous product bands", () => {
  expect(temperatureAssessment(policy, -180, ["sku"]).excursion).toBe(false);
  expect(temperatureAssessment(policy, -179, ["sku"]).excursion).toBe(true);
  expect(() => temperatureAssessment(policy, NaN, ["sku"])).toThrow();
  expect(() =>
    temperatureAssessment(
      {
        ...policy,
        bands: [{ ...policy.bands[0], productId: crypto.randomUUID() }],
      },
      -200,
      ["other"],
    ),
  ).toThrow();
  expect(() =>
    validatePolicy("cold_chain", {
      ...policy,
      bands: [policy.bands[0], policy.bands[0]],
    }),
  ).toThrow();
});
test("F-114 custody issues, swaps and physical counts retain distinct facts", () => {
  const e = (/** @type {string} */ action, /** @type {string} */ quantity) => ({
    outlet_id: outlet,
    facts: { typeCode: "crate", label: "Crate", action, quantity },
  });
  expect(
    containerBalances([e("issue", "12"), e("receive", "8"), e("count", "3")]),
  ).toEqual([
    {
      outletId: outlet,
      typeCode: "crate",
      label: "Crate",
      outstanding: "4",
      lastCount: "3",
    },
  ]);
});
test("F-115 offline temperature sync is exactly once, immutable and bound to this trip and store", async () => {
  const capture = op("temperature.record", {
    checkpoint: "delivery",
    outletId: outlet,
    deciC: -150,
    method: "manual",
  });
  await apply(capture);
  const replay = await push(capture);
  expect(replay.body.results[0].status).toBe("duplicate");
  const rows =
    await h.db`select * from van_trip_observations where id=${capture.payload.observationId}`;
  expect(rows).toHaveLength(1);
  expect(rows[0].facts.excursion).toBe(true);
  expect(rows[0].policy_id).toBeTruthy();
  await expect(
    (async () => {
      await h.db`update van_trip_observations set facts='{}' where id=${capture.payload.observationId}`;
    })(),
  ).rejects.toThrow("append-only");
  const invalid = await push(
    op("temperature.record", {
      checkpoint: "delivery",
      deciC: -200,
      method: "manual",
    }),
  );
  expect(invalid.body.results[0].status).toBe("rejected");
});
test("F-123 new trip refuses legacy close/count downgrade and accepts capture from a previous service day", async () => {
  const bad = op("temperature.record", {
    checkpoint: "interval",
    deciC: -200,
    method: "manual",
  });
  delete bad.payload.settlementVersion;
  expect((await push(bad)).body.results[0].status).toBe("rejected");
  const yesterday = new Date(Date.parse(today()) - 86400000)
    .toISOString()
    .slice(0, 10);
  await h.db`update van_trips set service_date=${yesterday} where id=${trip.id}`;
  const delayed = op("temperature.record", {
    checkpoint: "interval",
    deciC: -200,
    method: "manual",
  });
  delayed.clientTime = Date.parse(yesterday + "T12:00:00+08:00");
  delayed.payload.deviceTime = delayed.clientTime;
  await apply(delayed);
  await h.db`update van_trips set service_date=${today()} where id=${trip.id}`;
});
test("F-117 F-123 submission does not need network-era cash remittance, never unloads, and cannot rewrite a version", async () => {
  await h.db`insert into van_cash_counts(id,trip_id,expected_centavos,declared_centavos,variance_centavos,facts) values(${crypto.randomUUID()},${trip.id},0,0,0,'{}')`;
  await h.db`insert into van_stock_counts(id,trip_id,count_code,variance_lines,short_base,over_base,facts) values(${crypto.randomUUID()},${trip.id},'COUNT',0,0,0,'{}')`;
  const unload = op("unload.record", {
    lines: [
      {
        productId: crypto.randomUUID(),
        status: "available",
        quantityBase: "0",
        partition: "unsold",
      },
    ],
    empties: [],
  });
  // Empty van: capture immutable empty unload directly; normal scanner requires stock lines.
  await h.db`insert into van_trip_observations(id,trip_id,client_op_id,kind,captured_at,recorded_by,device_id,facts) values(${unload.payload.observationId},${trip.id},${unload.clientOpId},'unload',now(),${who.profile.id},${who.deviceId},${{ lines: [], empties: [] }})`;
  const p = {
    closeId: crypto.randomUUID(),
    deviceTime: Date.now(),
    endOdometerKm: 1020,
    exceptionsReviewed: true,
    operations: accepted.map((o) => ({
      clientRequestId: o.clientOpId,
      kind: o.opType,
    })),
  };
  await tx(h.db, async (db) => submitSettlement(db, trip, actor, p));
  const [saved] =
    await h.db`select * from van_settlements where id=${p.closeId}`;
  expect(saved.facts.state).toBe("pending_supervisor");
  expect(saved.version).toBe(1);
  expect(
    (
      await h.db`select status,end_odometer_km from van_trips where id=${trip.id}`
    )[0],
  ).toMatchObject({ status: "closing", end_odometer_km: 1020 });
  await expect(
    (async () => {
      await h.db`update van_settlements set facts='{}' where id=${p.closeId}`;
    })(),
  ).rejects.toThrow("append-only");
  await expect(
    tx(h.db, async (db) =>
      decideSettlement(db, actor, {
        tripId: trip.id,
        settlementId: saved.id,
        contentHash: saved.content_hash,
        decision: "approved",
        note: "self",
      }),
    ),
  ).rejects.toThrow();
  await expect(
    tx(h.db, async (db) =>
      decideSettlement(db, office, {
        tripId: trip.id,
        settlementId: saved.id,
        contentHash: saved.content_hash,
        decision: "approved",
        note: "Missing receipt",
      }),
    ),
  ).rejects.toThrow("Warehouse receipt");
});
test("F-118 tolerance breach must pass supervisor then a different area manager", async () => {
  const [s] =
    await h.db`select id from van_settlements where trip_id=${trip.id}`;
  const [p] =
    await h.db`select id from van_policy_versions where org_unit_id=${unit} and kind='variance'`;
  const [c] =
    await h.db`insert into van_variance_cases(settlement_id,policy_id,sales_centavos,variance_centavos,tolerance_basis_points,level,due_at) values(${s.id},${p.id},100000,501,50,'supervisor',now()) returning id`;
  await expect(
    tx(h.db, async (db) =>
      decideVariance(db, office, {
        tripId: trip.id,
        caseId: c.id,
        action: "accept",
        note: "Cannot skip",
      }),
    ),
  ).rejects.toThrow("supervisor");
  await tx(h.db, async (db) =>
    decideVariance(db, office, {
      tripId: trip.id,
      caseId: c.id,
      action: "escalate",
      note: "Investigate the short cash",
    }),
  );
  await expect(
    tx(h.db, async (db) =>
      decideVariance(db, office, {
        tripId: trip.id,
        caseId: c.id,
        action: "accept",
        note: "Same approver",
      }),
    ),
  ).rejects.toThrow("different area manager");
  expect(
    (await h.db`select level from van_variance_cases where id=${c.id}`)[0]
      .level,
  ).toBe("area_manager");
});
test("F-103 F-104 F-105 F-113 F-114 F-115 F-116 F-117 F-121 F-122 F-123 signed full-route replay posts exact batches and independent office sign-off once", async () => {
  // Retire the preceding zero-stock fixture to release the unique seller/vehicle-day slot.
  await h.db`update van_trips set status='closed' where id=${trip.id}`;
  h.signed = (/** @type {any} */ seller, /** @type {any} */ operation) =>
    signedPost(h, seller, "/api/sync/push", {
      version: 2,
      app: "van-android",
      deviceId: seller.deviceId,
      scopeId: unit,
      operations: [operation],
    });
  const proof = await exerciseRoute(
    h,
    who,
    boss,
    unit,
    vehicle,
    truck,
    depot,
    outlet,
    expect,
  );
  expect(proof.operationCount).toBeGreaterThan(10);
});
