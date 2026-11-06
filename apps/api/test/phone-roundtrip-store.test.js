import { beforeAll, afterAll, test, expect } from "bun:test";
import { tx } from "@sunpride/db/client";
import { readFileSync } from "node:fs";
import { pbkdf2Sync, createHash } from "node:crypto";
import {
  startHarness,
  profileStore,
  boundDevice,
  createUser,
  signedPost,
} from "./harness.js";
import { install } from "../src/domains/storepos/index.js";
import { modeBundle } from "../src/domains/storepos/model.js";
import { overrideProof } from "../src/domains/storepos/overrides.js";
import {
  aggregateSales,
  advanceAccumulator,
  privilegeOf,
  RESET_LIMIT,
  pesoText,
} from "../src/domains/storepos/readings.js";
import { actorFor } from "../src/core/context.js";
import { ingestMaster } from "../src/domains/integration/replicas.js";
import { sampleMaster, sampleMasters } from "../../sap-mock/src/sample.js";
import { postMovement } from "../src/domains/inventory/posting.js";
import {
  allocateDocumentNumber,
  saveRegistration,
  createSeries,
} from "../src/domains/fiscal/series.js";

const T = 30000;
/** A query that must fail; wrapped so expect().rejects sees a real promise. @param {any} q */
const fails = (q) =>
  expect(
    (async () => {
      await q;
    })(),
  ).rejects.toThrow();
/** @type {any} */ let h;
/** @type {any} */ let people;
/** @type {any} */ let A;
/** @type {any} */ let B;
/** @type {any} */ let boss;
/** @type {any} */ let sup;
/** @type {any} */ let supervisorActor;
let cookie = "";
const unit = crypto.randomUUID(),
  location = crypto.randomUUID();
let register = "",
  policy = "",
  product = "",
  prefix = "";
const PIN = "482915";

/** @param {any} who */ async function persist(who) {
  const p = who.profile;
  await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${who.userId},${who.userId},${p.name},${who.email},${p.role},'active',${unit})`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},${p.role},now()-interval '9 days',${"fixture"},'fixture')`;
}
/** @param {string} path @param {any} p @param {string} [authCookie] */
async function webRaw(path, p, authCookie = cookie) {
  const res = await h.fetch("/api/v1/storepos/" + path, {
    method: "POST",
    headers: { cookie: authCookie, "content-type": "application/json" },
    body: JSON.stringify({
      registerId: register,
      ...p,
      requestKey: crypto.randomUUID(),
    }),
  });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}
/** @param {string} path @param {any} p */ async function web(path, p) {
  const r = await webRaw(path, p);
  if (r.status !== 200) throw new Error(path + " " + JSON.stringify(r.body));
  return r.body;
}
/** @param {string} path */ async function get(path) {
  const res = await h.fetch("/api/v1/storepos/" + path, {
    headers: { cookie },
  });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}

/** A cashier on one handheld. */
class Till {
  /** @param {any} seller @param {string} mode @param {string} allocation */
  constructor(seller, mode, allocation) {
    this.s = seller;
    this.mode = mode;
    this.allocation = allocation;
    this.shift = "";
    this.sales = /** @type {any[]} */ ([]);
  }
  /** @param {string} kind @param {any} p @param {number} [time] */
  op(kind, p, time = Date.now()) {
    return {
      clientOpId: crypto.randomUUID(),
      opType: kind,
      clientTime: time,
      dependsOn: [],
      payload: {
        registerId: register,
        modeVersionId: this.mode,
        shiftId: this.shift,
        ...p,
        deviceTime: time,
      },
    };
  }
  /** @param {any} operation */
  async send(operation) {
    const r = await signedPost(h, this.s, "/api/sync/push", {
      version: 2,
      app: "van-android",
      deviceId: this.s.deviceId,
      scopeId: unit,
      operations: [operation],
    });
    return r.body.results?.[0] ?? { status: "http_" + r.res.status };
  }
  /** @param {any} operation */
  async push(operation) {
    const r = await this.send(operation);
    if (r.status !== "applied") throw new Error(JSON.stringify(r));
    return r;
  }
  /** @param {string} float @param {number} [time] */
  async open(float, time = Date.now()) {
    this.shift = crypto.randomUUID();
    return this.push(
      this.op(
        "store.shift.open",
        { shiftId: this.shift, policyId: policy, openingCentavos: float },
        time,
      ),
    );
  }
  /** @param {string} declared @param {number} [time] */
  async close(declared, time = Date.now()) {
    return this.push(
      this.op("store.shift.close", { declaredCentavos: declared }, time),
    );
  }
  /** Build (do not send) a 4,500 sale. @param {"cash"|"gcash"} method @param {number} [time] */
  async saleOp(method = "cash", time = Date.now()) {
    const [a] =
      await h.db`select next_issue from fiscal_allocations where id=${this.allocation}`;
    const serial = String(a.next_issue),
      id = crypto.randomUUID();
    const operation = this.op(
      "store.sale",
      {
        saleId: id,
        receiptNumber: `${prefix}-${serial.padStart(9, "0")}`,
        lines: [{ productId: product, uom: "PC", quantity: 1 }],
        totalCentavos: "4500",
        fiscal: { allocationId: this.allocation, serial },
        tenders: [
          {
            method,
            amountCentavos: "4500",
            ...(method === "gcash"
              ? { reference: "SAMPLE-" + id.slice(0, 8) }
              : {}),
          },
        ],
      },
      time,
    );
    return { operation, id };
  }
  /** @param {"cash"|"gcash"} [method] */
  async sell(method = "cash") {
    const { operation, id } = await this.saleOp(method);
    await this.push(operation);
    this.sales.push(id);
    return id;
  }
}
/** What the handheld computes offline from the verifier it downloaded.
 * @param {string} kind @param {string} refId @param {string} shiftId @param {string} amount @param {any} [who] */
async function proofFor(kind, refId, shiftId, amount, who = sup) {
  const [k] =
    await h.db`select * from store_supervisor_pins where profile_id=${who.profile.id} and effective_to is null`;
  const key = pbkdf2Sync(PIN, k.pin_salt, 160000, 32, "sha256");
  expect(createHash("sha256").update(key).digest("hex")).toBe(k.pin_hash);
  return {
    profileId: who.profile.id,
    pinId: k.id,
    method: "pin_offline",
    proof: overrideProof(key.toString("hex"), {
      kind,
      refId,
      shiftId,
      amountCentavos: amount,
      pinId: k.id,
    }),
  };
}
const dayRow = async (/** @type {string} */ id) =>
  (await h.db`select * from store_till_days where id=${id}`)[0];
const sessionDay = async (/** @type {string} */ shiftId) =>
  (
    await h.db`select d.* from store_shifts s join store_till_days d on d.id=s.till_day_id where s.id=${shiftId}`
  )[0];

beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  people = profileStore(h);
  h.setHooks({ unitInScope: async () => true });
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SUNPRIDE','SAMPLE Cebu','national','active',now()-interval '30 days')`;
  await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values('zday-test','org_units',${unit},'unit')`;
  const a = await boundDevice(h, people, {
    app: "van-android",
    orgUnitId: unit,
  });
  const b = await boundDevice(h, people, {
    app: "van-android",
    orgUnitId: unit,
  });
  await persist(a);
  await persist(b);
  const mk = async (
    /** @type {string} */ email,
    /** @type {string} */ role,
    /** @type {string} */ name,
  ) => {
    const userId = await createUser(h, email, "fixture password only");
    const who = {
      userId,
      email,
      profile: people.set(userId, { role, orgUnitId: unit, name }),
    };
    await persist(who);
    return who;
  };
  boss = await mk("zday-boss@example.com", "super_admin", "Office boss");
  sup = await mk("zday-sup@example.com", "manager", "Store supervisor");
  supervisorActor = await actorFor(h.db, boss.userId);
  const login = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: boss.email,
      password: "fixture password only",
    }),
  });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  const material = sampleMasters.find((m) => m.kind === "material");
  await ingestMaster(
    h.db,
    sampleMaster("material", "ZDAY-SKU", {
      ...material.data,
      code: "ZDAY-SKU",
      name: "Sample day item",
      tracking: "none",
    }),
  );
  const condition = sampleMasters.find((m) => m.kind === "condition");
  await ingestMaster(
    h.db,
    sampleMaster("condition", "ZDAY-PRICE", {
      ...condition.data,
      productCode: "ZDAY-SKU",
    }),
  );
  await ingestMaster(
    h.db,
    sampleMasters.find((m) => m.kind === "customer"),
  );
  product = (await h.db`select id from products where code='ZDAY-SKU'`)[0].id;
  const customer = (
    await h.db`select id from customers where code='MOCK-C1'`
  )[0].id;
  const outlet = crypto.randomUUID();
  await h.db`insert into outlets(id,organization_id,code,name,status,custodian_org_unit_id,channel,created_by) values(${outlet},'sunpride','ZSTORE','Sample store','active',${unit},'gt',${a.userId})`;
  await h.db`insert into outlet_customer_links(outlet_id,customer_id,source,effective_from,actor_subject,reason) values(${outlet},${customer},'sample',now()-interval '1 day','fixture','fixture')`;
  await h.db`insert into inventory_locations(id,organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values(${location},'sunpride',${unit},'CEBU','ZSTORE','ZSTORE','store',true,true,true,true,false)`;
  register = (
    await web("registers/save", {
      locationId: location,
      terminalCode: "REG01",
      name: "Till one",
    })
  ).id;
  await web("registers/link", { outletId: outlet });
  policy = (
    await web("policies/save", { toleranceCentavos: "100", pin: "135790" })
  ).id;
  for (const w of [a, b])
    await web("cashiers/save", { profileId: w.profile.id, enabled: true });
  const modeA = (
    await web("mode/set", {
      deviceId: a.deviceId,
      mode: "store",
      allowLocalSwitch: false,
    })
  ).id;
  const modeB = (
    await web("mode/set", {
      deviceId: b.deviceId,
      mode: "store",
      allowLocalSwitch: false,
    })
  ).id;
  for (const method of ["cash", "gcash", "card"])
    await h.db`insert into fiscal_tender_rules(org_unit_id,method,label,enabled,effective_from,sample,entered_by) values(${unit},${method},${method},true,now()-interval '1 day',true,${boss.profile.id})`;
  const reg = await tx(h.db, (db) =>
    saveRegistration(db, supervisorActor, {
      orgUnitId: unit,
      entityName: "SAMPLE company",
      branchName: "SAMPLE Cebu",
      tin: "SAMPLE",
      address: "Sample address",
      documentType: "sales_invoice",
      status: "sample_not_filed",
      effectiveFrom: "2026-01-01T00:00:00Z",
    }),
  );
  prefix = "SAMPLE-ZD";
  const series = await tx(h.db, (db) =>
    createSeries(db, supervisorActor, {
      registrationId: reg.id,
      prefix,
      firstSerial: "1",
      lastSerial: "500",
      effectiveFrom: "2026-01-01T00:00:00Z",
    }),
  );
  const alloc = async (/** @type {any} */ seller) => {
    const who = await actorFor(h.db, seller.userId);
    const got = await tx(h.db, (db) =>
      allocateDocumentNumber(db, {
        actor: who,
        deviceId: seller.deviceId,
        seriesId: series.id,
        requestKey: crypto.randomUUID(),
        count: 30,
      }),
    );
    return got.allocationId;
  };
  A = new Till(a, modeA, await alloc(a));
  B = new Till(b, modeB, await alloc(b));
  await tx(h.db, (db) =>
    postMovement(db, {
      kind: "opening_balance",
      sourceType: "cutover",
      sourceId: location,
      idempotencyKey: "zday-opening",
      occurredAt: Date.now(),
      organizationId: "sunpride",
      actor: { profileId: boss.profile.id, userId: boss.userId },
      lines: [
        {
          productId: product,
          quantityBase: 100,
          fromLocationId: null,
          toLocationId: location,
          uom: "PC",
          unitCostMinor: 1000,
        },
      ],
    }),
  );
  // supervisor's own PIN, set by the office
  await web("supervisors/pin", { profileId: sup.profile.id, pin: PIN });
}, 90000);
afterAll(async () => h?.close());

// IP-INT3 gap 5 (store half): replay the exact JSON the phone sends for `store.cash`, `store.read x` and
// `store.read z` (with a supervisor proof). The payloads are made by the phone's own serializers and committed as
// fixtures/phone-ops.json by PhoneRoundTripFixtureTest (Android unit test). Only what must differ per run is replaced:
// the ids of the shift, register and mode, the clock, and the supervisor proof (which is bound to this run's shift and
// PIN version and is recomputed with the server's own `overrideProof`).
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/phone-ops.json", import.meta.url), "utf8"),
);
/** @param {string} name */
const captured = (name) =>
  structuredClone(fixture.ops.find((/** @type {any} */ o) => o.name === name).op);
const keysOf = (/** @type {any} */ o) => Object.keys(o).sort();

/** What the phone sent, with this run's ids and clock. @param {any} till @param {string} name */
function replayable(till, name) {
  const op = captured(name);
  const now = Date.now();
  op.clientTime = now;
  op.payload.deviceTime = now;
  op.payload.shiftId = till.shift;
  op.payload.registerId = register;
  op.payload.modeVersionId = till.mode;
  return op;
}

test("the server's own proof functions agree with the phone's proofs in the fixture (same PIN, same message, same bytes)", () => {
  const drop = captured("store.cash");
  const z = captured("store.read.z");
  const key = fixture.test.keyHex;
  expect(
    overrideProof(key, {
      kind: "cash_drop",
      refId: drop.clientOpId,
      shiftId: fixture.test.shiftId,
      amountCentavos: "500000",
      pinId: fixture.test.pinId,
    }),
  ).toBe(drop.payload.supervisor.proof);
  expect(
    overrideProof(key, {
      kind: "z_reading",
      refId: z.clientOpId,
      shiftId: fixture.test.shiftId,
      amountCentavos: "0",
      pinId: fixture.test.pinId,
    }),
  ).toBe(z.payload.supervisor.proof);
});

test(
  "the phone's store.cash (drop with a supervisor, paid-in without), store.read x and store.read z are accepted and recorded",
  async () => {
    const till = A;
    await till.open("700000");
    // 1. paid in: no supervisor, exactly the phone's payload
    const paidIn = replayable(till, "store.cash.paid_in");
    const r1 = await till.send(paidIn);
    expect(r1.status, JSON.stringify(r1)).toBe("applied");
    const [pin] =
      await h.db`select * from store_cash_movements where id=${paidIn.clientOpId}`;
    expect(pin).toMatchObject({ kind: "paid_in", reason_code: "change_fund" });
    expect(String(pin.amount_centavos)).toBe("150000");
    // 2. cash drop: the phone's payload, the supervisor's proof re-signed for this shift and PIN version
    const drop = replayable(till, "store.cash");
    const phoneSupervisor = drop.payload.supervisor;
    const signed = await proofFor("cash_drop", drop.clientOpId, till.shift, "500000");
    expect(keysOf(signed)).toEqual(keysOf(phoneSupervisor)); // same shape the phone sends
    expect(signed.method).toBe(phoneSupervisor.method);
    // the phone's proof from another shift/PIN version is not valid here: the server refuses it
    const forged = structuredClone(drop);
    forged.payload.supervisor = { ...signed, proof: phoneSupervisor.proof };
    forged.clientOpId = crypto.randomUUID();
    expect((await till.send(forged)).status).toBe("rejected");
    drop.payload.supervisor = signed;
    const r2 = await till.send(drop);
    expect(r2.status, JSON.stringify(r2)).toBe("applied");
    const [mv] =
      await h.db`select * from store_cash_movements where id=${drop.clientOpId}`;
    expect(mv).toMatchObject({
      kind: "drop",
      reason_code: "safe_drop",
      supervisor_profile_id: sup.profile.id,
    });
    expect(mv.slip_number).toMatch(/^REM-REG01-\d{6}-\d{4}$/);
    expect(String(mv.amount_centavos)).toBe("500000");
    expect(mv.note).toBe("to the safe");
    // 3. X reading: exactly the phone's payload; it never closes anything
    const x = replayable(till, "store.read.x");
    const r3 = await till.send(x);
    expect(r3.status, JSON.stringify(r3)).toBe("applied");
    expect(
      (await h.db`select kind from store_reads where shift_id=${till.shift} and kind='x'`).length,
    ).toBe(1);
    // 4. close the session, then Z with the supervisor's proof, exactly as the phone sends it
    expect((await till.close("350000")).status).toBe("applied");
    const dayId = (await sessionDay(till.shift)).id;
    const z = replayable(till, "store.read.z");
    const zSigned = await proofFor("z_reading", z.clientOpId, till.shift, "0");
    expect(keysOf(zSigned)).toEqual(keysOf(z.payload.supervisor));
    z.payload.supervisor = zSigned;
    const r4 = await till.send(z);
    expect(r4.status, JSON.stringify(r4)).toBe("applied");
    const [zr] =
      await h.db`select * from store_z_readings where till_day_id=${dayId}`;
    expect(zr.generated_by).toBe(sup.profile.id);
    expect((await dayRow(dayId)).status).toBe("z_done");
    // Every approval left an override row naming the supervisor and the method.
    const overrides =
      await h.db`select kind,method,supervisor_profile_id from store_overrides where ref_id in (${drop.clientOpId},${z.clientOpId}) order by kind`;
    expect(overrides.map((/** @type {any} */ o) => [o.kind, o.method, o.supervisor_profile_id])).toEqual([
      ["cash_drop", "pin_offline", sup.profile.id],
      ["z_reading", "pin_offline", sup.profile.id],
    ]);
    // The cash drawer agrees: 700000 + 150000 - 500000 = 350000 expected, 350000 declared, no variance.
    const [c] = await h.db`select * from store_shift_closures where shift_id=${till.shift}`;
    expect(String(c.expected_centavos)).toBe("350000");
    expect(String(c.variance_centavos)).toBe("0");
    // A replay of the same ops is idempotent (the phone resends until it hears back).
    expect((await till.send(paidIn)).status).not.toBe("rejected");
  },
  T,
);
