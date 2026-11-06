import { afterAll, beforeAll, expect, test, mock } from "bun:test";
mock.module("../src/domains/org/scope.js", () => ({
  scopeFilterForActor: async (
    /** @type {any} */ _db,
    /** @type {any} */ actor,
  ) => ({ unitIds: actor.role === "super_admin" ? null : [actor.orgUnitId] }),
  outletOwnerUnit: async () => null,
}));
import {
  startHarness,
  profileStore,
  boundDevice,
  createUser,
  signedPost,
} from "./harness.js";
import { install } from "../src/domains/storepos/index.js";
import { bundle } from "../src/domains/van/projection.js";
import { actorFor } from "../src/core/context.js";
import { tx } from "@sunpride/db/client";
import { ensureStorePosSamples } from "../../../packages/db/seed/storepos.js";

/** @type {any} */ let h;
/** @type {any} */ let profiles;
/** @type {any} */ let seller;
/** @type {any} */ let boss;
/** @type {any} */ let foreign;
const unit = crypto.randomUUID(),
  other = crypto.randomUUID(),
  location = crypto.randomUUID();
let cookie = "",
  registerId = "",
  policyId = "",
  modeId = "";
/** @param {any} who */
async function persist(who) {
  const p = who.profile;
  await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${who.userId},${who.userId},${p.name},${who.email},${p.role},'active',${p.orgUnitId})`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${p.orgUnitId},${p.role},now()-interval '1 day','fixture','fixture')`;
}
/** @param {string} path @param {any} body @param {string} [key] */
async function web(path, body, key = crypto.randomUUID()) {
  const res = await h.fetch(`/api/v1/storepos/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ ...body, requestKey: key }),
  });
  return { res, body: await res.json() };
}
/** @param {string} kind @param {any} body @returns {any} */
function op(kind, body) {
  const at = Date.now();
  return {
    clientOpId: crypto.randomUUID(),
    opType: kind,
    clientTime: at,
    dependsOn: [],
    payload: { registerId, modeVersionId: modeId, ...body, deviceTime: at },
  };
}
/** @param {any[]} ops @param {any} [who] */
async function push(ops, who = seller) {
  return signedPost(h, who, "/api/sync/push", {
    version: 2,
    app: "van-android",
    deviceId: who.deviceId,
    scopeId: who.profile.orgUnitId,
    operations: ops,
  });
}
/** @param {any} [who] */
async function view(who = boss) {
  const res = await h.fetch("/api/v1/storepos/workspace", {
    headers:
      who === boss ? { cookie } : { authorization: `Bearer ${who.access}` },
  });
  expect(res.status).toBe(200);
  return /** @type {any} */ (await res.json());
}
beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  profiles = profileStore(h);
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','NATIONAL','Cebu','national','active',now()-interval '1 day'),(${other},'sunpride','OTHER','Other region','region','active',now()-interval '1 day')`;
  seller = await boundDevice(h, profiles, {
    app: "van-android",
    orgUnitId: unit,
  });
  await persist(seller);
  foreign = await boundDevice(h, profiles, {
    app: "van-android",
    orgUnitId: other,
  });
  await persist(foreign);
  const userId = await createUser(
    h,
    "boss@example.com",
    "correct horse battery",
  );
  boss = {
    userId,
    email: "boss@example.com",
    profile: profiles.set(userId, {
      role: "super_admin",
      orgUnitId: unit,
      name: "Store supervisor",
    }),
  };
  await persist(boss);
  const login = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: boss.email,
      password: "correct horse battery",
    }),
  });
  expect(login.status).toBe(200);
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  await h.db`insert into inventory_locations(id,organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values(${location},'sunpride',${unit},'CEBU','STORE-1','Cebu sample shop','store',true,true,true,true,false)`;
  let r = await web("registers/save", {
    locationId: location,
    terminalCode: "CEBU-01",
    name: "Register one",
  });
  expect(r.res.status).toBe(200);
  registerId = r.body.id;
  r = await web("policies/save", { registerId, toleranceCentavos: "5000" });
  expect(r.res.status).toBe(200);
  policyId = r.body.id;
  r = await web("cashiers/save", {
    registerId,
    profileId: seller.profile.id,
    enabled: true,
  });
  expect(r.res.status).toBe(200);
  r = await web("mode/set", {
    deviceId: seller.deviceId,
    registerId,
    mode: "store",
    allowLocalSwitch: false,
  });
  expect(r.res.status).toBe(200);
  modeId = r.body.id;
});
afterAll(async () => {
  await h?.close();
});

test("F-R01 mode is opt-in and delivers a store session without a fake van trip", async () => {
  const actor = await actorFor(h.db, seller.userId);
  const ctx = {
    db: h.db,
    actor,
    device: { id: seller.deviceId },
    params: {
      serviceDate: new Date(Date.now() + 8 * 3600000)
        .toISOString()
        .slice(0, 10),
      posMode: true,
    },
    now: Date.now(),
  };
  const result = await bundle(ctx, {});
  if (!result.policy.storePos) throw new Error("Store configuration missing");
  expect(result.trip).toBeNull();
  expect(result.load).toBeNull();
  expect(result.policy.storePos.mode).toBe("store");
  expect(result.policy.storePos.transactionsEnabled).toBe(false);
  expect(result.policy.storePos.storeName).toBe("Cebu sample shop");
  await expect(
    bundle({ ...ctx, params: { ...ctx.params, posMode: false } }, {}),
  ).rejects.toMatchObject({ code: "update_required" });
});
test("F-R01 store shift uploads offline open and blind close in dependency order, replay is exact", async () => {
  const shiftId = crypto.randomUUID(),
    opening = op("store.shift.open", {
      shiftId,
      policyId,
      openingCentavos: "100000",
    });
  let r = await push([opening]);
  expect(r.res.status).toBe(200);
  expect(r.body.results[0].status).toBe("applied");
  const repeat = await push([opening]);
  expect(repeat.body.results[0].status).toBe("duplicate");
  expect(repeat.body.results[0].ack).toEqual(r.body.results[0].ack);
  const current = await view(seller);
  expect(current.shifts[0].expectedCentavos).toBeNull();
  expect(current.shifts[0].varianceCentavos).toBeNull();
  const blocked = await web("mode/set", {
    deviceId: seller.deviceId,
    registerId,
    mode: "van",
    allowLocalSwitch: false,
  });
  expect(blocked.res.status).toBe(422);
  const closing = op("store.shift.close", {
    shiftId,
    declaredCentavos: "90000",
  });
  closing.dependsOn = [opening.clientOpId];
  r = await push([closing]);
  expect(r.body.results[0].status).toBe("applied");
  const owner = await view();
  const row = owner.shifts.find((/** @type {any} */ s) => s.id === shiftId);
  expect(row.expectedCentavos).toBe("100000");
  expect(row.varianceCentavos).toBe("-10000");
  expect(row.canDecide).toBe(true);
  expect((await view(seller)).shifts[0].varianceCentavos).toBeNull();
  const decision = await web("shifts/decide", {
    closureId: row.closureId,
    decision: "investigate",
    reason: "Sample cash short",
  });
  expect(decision.res.status).toBe(200);
  expect(
    (await view()).shifts.find((/** @type {any} */ s) => s.id === shiftId)
      .status,
  ).toBe("investigate");
  const retry = await push([closing]);
  expect(retry.body.results[0].status).toBe("duplicate");
  const [counts] =
    await h.db`select (select count(*)::int from store_shifts where id=${shiftId}) as opens,(select count(*)::int from store_shift_closures where shift_id=${shiftId}) as closes`;
  expect(counts).toEqual({ opens: 1, closes: 1 });
});
test("F-R01 altered replay is refused and cross-store cashier cannot open", async () => {
  const shiftId = crypto.randomUUID(),
    opening = op("store.shift.open", {
      shiftId,
      policyId,
      openingCentavos: "10000",
    });
  const first = await push([opening]);
  expect(first.body.results[0].status).toBe("applied");
  const altered = structuredClone(opening);
  altered.payload.openingCentavos = "99999";
  expect((await push([altered])).body.results[0].code).toBe(
    "idempotency_conflict",
  );
  expect(
    (
      await push(
        [
          op("store.shift.open", {
            shiftId: crypto.randomUUID(),
            policyId,
            openingCentavos: "0",
          }),
        ],
        foreign,
      )
    ).body.results[0].status,
  ).toBe("rejected");
  const bad = op("store.shift.close", {
    shiftId,
    declaredCentavos: "10000",
    expectedCentavos: "10000",
  });
  expect((await push([bad])).body.results[0].status).toBe("rejected");
  const closed = await push([
    op("store.shift.close", { shiftId, declaredCentavos: "15000" }),
  ]);
  expect(closed.body.results[0].status).toBe("applied");
  expect(
    (await view()).shifts.find((/** @type {any} */ s) => s.id === shiftId)
      .status,
  ).toBe("closed"); // equal tolerance is accepted
});
test("F-R01 cashier withdrawal, future capture and stale configuration refuse before any business writes", async () => {
  const before = (await h.db`select count(*)::int as n from store_shifts`)[0].n;
  const removal = await web("cashiers/save", {
    registerId,
    profileId: seller.profile.id,
    enabled: false,
  });
  expect(removal.res.status).toBe(200);
  expect(
    (
      await push([
        op("store.shift.open", {
          shiftId: crypto.randomUUID(),
          policyId,
          openingCentavos: "0",
        }),
      ])
    ).body.results[0].status,
  ).toBe("rejected");
  await web("cashiers/save", {
    registerId,
    profileId: seller.profile.id,
    enabled: true,
  });
  const future = op("store.shift.open", {
    shiftId: crypto.randomUUID(),
    policyId,
    openingCentavos: "0",
  });
  future.clientTime += 120000;
  future.payload.deviceTime = future.clientTime;
  expect((await push([future])).body.results[0].code).toBe("wrong_date");
  expect(
    (
      await push([
        op("store.shift.open", {
          shiftId: crypto.randomUUID(),
          policyId,
          modeVersionId: crypto.randomUUID(),
          openingCentavos: "0",
        }),
      ])
    ).body.results[0].status,
  ).toBe("rejected");
  expect((await h.db`select count(*)::int as n from store_shifts`)[0].n).toBe(
    before,
  );
});
test("F-R01 concurrent opens serialize to exactly one session and cash evidence is immutable", async () => {
  const a = op("store.shift.open", {
      shiftId: crypto.randomUUID(),
      policyId,
      openingCentavos: "0",
    }),
    b = op("store.shift.open", {
      shiftId: crypto.randomUUID(),
      policyId,
      openingCentavos: "0",
    });
  const results = await Promise.all([push([a]), push([b])]);
  expect(results.map((r) => r.body.results[0].status).sort()).toEqual([
    "applied",
    "rejected",
  ]);
  const winner = results[0].body.results[0].status === "applied" ? a : b;
  await expect(
    tx(h.db, async (db) => {
      await db`update store_shifts set opening_centavos=1 where id=${winner.payload.shiftId}`;
    }),
  ).rejects.toThrow("append-only");
  const [audit] =
    await h.db`select actor_subject from fiscal_audit_events where table_name='store_shifts' and row_id=${winner.payload.shiftId}`;
  expect(audit.actor_subject).toBe(seller.userId);
  expect(
    (
      await push([
        op("store.shift.close", {
          shiftId: winner.payload.shiftId,
          declaredCentavos: "0",
        }),
      ])
    ).body.results[0].status,
  ).toBe("applied");
});
test("IP-P0 store session opens with a P2,000 float under either field name; the close expects it", async () => {
  const { expectedCash } =
    await import("../src/domains/storepos/operations.js");
  const both = [
    ["openingFloatCentavos", 200000],
    ["openingCentavos", "200000"],
  ];
  for (const [field, value] of both) {
    const shiftId = crypto.randomUUID(),
      opening = op("store.shift.open", { shiftId, policyId, [field]: value });
    const r = await push([opening]);
    expect(r.body.results[0].status).toBe("applied");
    expect((await push([opening])).body.results[0].status).toBe("duplicate");
    const [row] =
      await h.db`select opening_centavos::text as o from store_shifts where id=${shiftId}`;
    expect(row.o).toBe("200000");
    expect(await expectedCash(h.db, shiftId)).toBe(200000n);
    const closed = await push([
      op("store.shift.close", { shiftId, declaredCentavos: "200000" }),
    ]);
    expect(closed.body.results[0].status).toBe("applied");
    const [c] =
      await h.db`select expected_centavos::text as e,variance_centavos::text as v from store_shift_closures where shift_id=${shiftId}`;
    expect(c).toEqual({ e: "200000", v: "0" });
  }
});
test("IP-P0 store open without a float means zero; a float outside 0..P100,000 is refused", async () => {
  const bad = op("store.shift.open", {
    shiftId: crypto.randomUUID(),
    policyId,
    openingFloatCentavos: 10_000_001,
  });
  expect((await push([bad])).body.results[0]).toMatchObject({
    status: "rejected",
    code: "invalid_request",
  });
  const shiftId = crypto.randomUUID();
  const none = op("store.shift.open", { shiftId, policyId });
  expect((await push([none])).body.results[0].status).toBe("applied");
  const [row] =
    await h.db`select opening_centavos::text as o from store_shifts where id=${shiftId}`;
  expect(row.o).toBe("0");
  expect(
    (await push([op("store.shift.close", { shiftId, declaredCentavos: "0" })]))
      .body.results[0].status,
  ).toBe("applied");
});
test("IP-P0 fix: the store float cap is the same P100,000 the phone enforces: the top is accepted, one centavo over is not", async () => {
  const top = crypto.randomUUID();
  const ok = await push([
    op("store.shift.open", {
      shiftId: top,
      policyId,
      openingCentavos: "10000000",
    }),
  ]);
  expect(ok.body.results[0].status).toBe("applied");
  const [row] =
    await h.db`select opening_centavos::text as o from store_shifts where id=${top}`;
  expect(row.o).toBe("10000000");
  expect(
    (
      await push([
        op("store.shift.close", { shiftId: top, declaredCentavos: "10000000" }),
      ])
    ).body.results[0].status,
  ).toBe("applied");
  const over = await push([
    op("store.shift.open", {
      shiftId: crypto.randomUUID(),
      policyId,
      openingCentavos: "10000001",
    }),
  ]);
  expect(over.body.results[0]).toMatchObject({
    status: "rejected",
    code: "invalid_request",
  });
});
test("F-R01 office idempotency and Van mode round trip preserve the existing van contract", async () => {
  const body = {
      deviceId: seller.deviceId,
      registerId: null,
      mode: "van",
      allowLocalSwitch: false,
    },
    key = crypto.randomUUID();
  const a = await web("mode/set", body, key);
  expect(a.res.status).toBe(200);
  const b = await web("mode/set", body, key);
  expect(b.body).toEqual(a.body);
  const actor = await actorFor(h.db, seller.userId);
  const result = await bundle(
    {
      db: h.db,
      actor,
      device: { id: seller.deviceId },
      params: {
        serviceDate: new Date(Date.now() + 8 * 3600000)
          .toISOString()
          .slice(0, 10),
      },
      now: Date.now(),
    },
    {},
  );
  expect(result.policy).not.toHaveProperty("storePos");
  expect(result.trip).toBeNull();
});
test("F-R01 sample stores add twice without resetting or touching any device", async () => {
  await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values('sunpride-demo-v2','profiles',${seller.profile.id},'storepos-fixture-person')`;
  const before = await h.db`select id,mode from pos_device_modes order by id`;
  expect((await ensureStorePosSamples(h.db)).added).toBe(6);
  expect((await ensureStorePosSamples(h.db)).added).toBe(0);
  const stores =
    await h.db`select l.id from inventory_locations l join sample_data_rows m on m.table_name='inventory_locations' and m.row_id=l.id::text where l.type='store'`;
  expect(stores.length).toBe(2);
  expect(await h.db`select id,mode from pos_device_modes order by id`).toEqual(
    before,
  );
});
