import { beforeAll, afterAll, test, expect } from "bun:test";
import { tx } from "@sunpride/db/client";
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
import { readFileSync } from "node:fs";
import { manilaBusinessDate } from "../src/core/docnum.js";
import { generateZ } from "../src/domains/storepos/readings.js";
import { tillDayForOpen } from "../src/domains/storepos/till-days.js";
import { authorityRule } from "../src/domains/fiscal/authority.js";
import { postingLocks, stockLock } from "../src/domains/inventory/common.js";
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
  await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values('int2fix-test','org_units',${unit},'unit')`;
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
  boss = await mk("int2fix-boss@example.com", "super_admin", "Office boss");
  sup = await mk("int2fix-sup@example.com", "manager", "Store supervisor");
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
    sampleMaster("material", "I2F-SKU", {
      ...material.data,
      code: "I2F-SKU",
      name: "Sample day item",
      tracking: "none",
    }),
  );
  const condition = sampleMasters.find((m) => m.kind === "condition");
  await ingestMaster(
    h.db,
    sampleMaster("condition", "I2F-PRICE", {
      ...condition.data,
      productCode: "I2F-SKU",
    }),
  );
  await ingestMaster(
    h.db,
    sampleMasters.find((m) => m.kind === "customer"),
  );
  product = (await h.db`select id from products where code='I2F-SKU'`)[0].id;
  const customer = (
    await h.db`select id from customers where code='MOCK-C1'`
  )[0].id;
  const outlet = crypto.randomUUID();
  await h.db`insert into outlets(id,organization_id,code,name,status,custodian_org_unit_id,channel,created_by) values(${outlet},'sunpride','I2STORE','Sample store','active',${unit},'gt',${a.userId})`;
  await h.db`insert into outlet_customer_links(outlet_id,customer_id,source,effective_from,actor_subject,reason) values(${outlet},${customer},'sample',now()-interval '1 day','fixture','fixture')`;
  await h.db`insert into inventory_locations(id,organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values(${location},'sunpride',${unit},'CEBU','I2STORE','I2STORE','store',true,true,true,true,false)`;
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
  prefix = "SAMPLE-I2";
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
      idempotencyKey: "i2f-opening",
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

const MIGRATIONS = new URL("../../../packages/db/migrations/", import.meta.url);
/** @param {string} name */
const migrationSql = (name) => readFileSync(new URL(name, MIGRATIONS), "utf8");
/** The one statement of 0770 that closes old backfilled days; the test runs the migration's own text. */
const closeOldDaysSql = () =>
  /** @type {string} */ (
    migrationSql("0770_till_day_legacy_and_opening.sql").match(
      /update store_till_days d set status = 'closed_no_z'[^;]+;/,
    )?.[0]
  );
const DAY = 86400000;
const ymd = (/** @type {any} */ v) =>
  String(v?.toISOString?.() ?? v).slice(0, 10);

test(
  "P2-1 (a): a supervisor proof older than 24 hours is refused, a fresh one is honoured",
  async () => {
    // the PIN has been valid for days, so the only thing that can refuse the proof is its age
    await h.db`update store_supervisor_pins set effective_from=now()-interval '10 days' where profile_id=${sup.profile.id} and effective_to is null`;
    // everything the till is configured with has been in force for days, so a capture time two days ago is valid
    await h.db`update store_register_policies set effective_from=now()-interval '10 days'`;
    await h.db`update pos_device_modes set effective_from=now()-interval '10 days'`;
    await h.db`update store_cashier_assignments set effective_from=now()-interval '10 days'`;
    await h.db`update store_registers set effective_from=now()-interval '10 days'`;
    await h.db`update fiscal_tender_rules set effective_from=now()-interval '10 days'`;
    const past = Date.now() - 2 * DAY;
    await A.open("10000", past);
    for (const n of [1, 2]) {
      const { operation, id } = await A.saleOp("cash", past + n * 600000);
      await A.push(operation);
      A.sales.push(id);
    }
    const line = async (/** @type {string} */ ref, /** @type {number} */ at) =>
      A.send(
        A.op(
          "store.override",
          {
            kind: "void_line",
            refType: "line",
            refId: ref,
            amountCentavos: "0",
            reason: "SAMPLE scanned twice",
            supervisor: await proofFor("void_line", ref, A.shift, "0"),
          },
          at,
        ),
      );
    const old = await line("line-old", Date.now() - 30 * 3600000);
    expect(old.status).toBe("rejected");
    const fresh = await line("line-fresh", Date.now() - 2 * 3600000);
    expect(fresh.status).toBe("applied");
  },
  T,
);

test("P1-1 + P1-4 + P0: old no-Z days never take a new session, the first Z continues the grand total, and a Z with no PIN from an older app still works", async () => {
  const oldDay = await sessionDay(A.shift);
  expect(ymd(oldDay.business_date)).toBe(
    manilaBusinessDate(Date.now() - 2 * DAY),
  );
  await A.close("19000", Date.now() - 3600000);
  // a new session today does not join the old day that never got its Z
  await A.open("10000");
  const today = await sessionDay(A.shift);
  expect(today.id).not.toBe(oldDay.id);
  expect(ymd(today.business_date)).toBe(manilaBusinessDate(Date.now()));
  expect((await dayRow(oldDay.id)).status).toBe("open");
  // the migration's own statement marks the old day readable but never joinable
  await h.db.unsafe(closeOldDaysSql());
  expect((await dayRow(oldDay.id)).status).toBe("closed_no_z");
  expect((await dayRow(today.id)).status).toBe("open");
  const oldView = await get(`days/${oldDay.id}`);
  expect(oldView.status).toBe(200);
  expect(oldView.body.day.status).toBe("closed_no_z");
  expect(oldView.body.day.canZ).toBe(false);
  expect((await webRaw(`days/${oldDay.id}/z`, {})).status).toBe(422);

  await A.sell("cash");
  // the X reading (a preview) already shows the continued grand total and writes nothing
  const x = await get(`days/${today.id}/reading`);
  expect(x.body.reading.accumulators.beginningGrossCentavos).toBe("9000");
  expect(x.body.reading.accumulators.endingGrossCentavos).toBe("13500");
  expect(
    (await h.db`select count(*)::int as n from store_accumulator_openings`)[0]
      .n,
  ).toBe(0);
  // legacy request (no supervisor proof) while the session is open: refused like any Z
  const early = await A.send(A.op("store.read", { kind: "z" }));
  expect(early.status).toBe("rejected");
  await A.close("14500");
  // a malformed / foreign proof still takes the strict path
  expect(
    (
      await A.send(
        A.op("store.read", {
          kind: "z",
          supervisor: {
            profileId: sup.profile.id,
            pinId: crypto.randomUUID(),
            proof: "zz",
          },
        }),
      )
    ).status,
  ).toBe("rejected");
  expect(
    (
      await h.db`select count(*)::int as n from store_z_readings where till_day_id=${today.id}`
    )[0].n,
  ).toBe(0);

  // P0: beta.25/26/hh1 send the Z with no proof; it is accepted because everything is closed, and logged
  const id = crypto.randomUUID();
  const ok = await A.send({
    ...A.op("store.read", { kind: "z" }),
    clientOpId: id,
  });
  expect(ok.status).toBe("applied");
  const [z] =
    await h.db`select * from store_z_readings where till_day_id=${today.id}`;
  expect(z.generated_by).toBe(A.s.profile.id);
  expect(z.sessions_count).toBe(1);
  expect(z.transactions_count).toBe(1);
  expect(z.net_sales_centavos.toString()).toBe("4500");
  expect((await dayRow(today.id)).status).toBe("z_done");
  const [o] =
    await h.db`select * from store_overrides where kind='z_legacy_no_pin' and ref_id=${id}`;
  expect(o).toMatchObject({
    method: "legacy_no_pin",
    supervisor_profile_id: A.s.profile.id,
    cashier_profile_id: A.s.profile.id,
    till_day_id: today.id,
  });
  // P1-4: Beginning grand total = everything the register sold before, recorded once and audited
  expect(z.beginning_gross_centavos.toString()).toBe("9000");
  expect(z.beginning_net_centavos.toString()).toBe("9000");
  expect(z.ending_gross_centavos.toString()).toBe("13500");
  const rows = await h.db`select * from store_accumulator_openings`;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    register_id: register,
    sales_count: 2,
    first_till_day_id: today.id,
  });
  expect(rows[0].opening_gross_centavos.toString()).toBe("9000");
  expect(ymd(rows[0].through_business_date)).toBe(
    manilaBusinessDate(Date.now()),
  );
  expect(
    (
      await h.db`select count(*)::int as n from fiscal_audit_events where table_name='store_accumulator_openings'`
    )[0].n,
  ).toBe(1);
  // the next Z continues from this one, and the opening is not written again
  await A.open("0");
  await A.sell("cash");
  await A.close("4500");
  const next = await web(`days/${(await sessionDay(A.shift)).id}/z`, {});
  expect(
    next.printModel.lines.find(
      (/** @type {any} */ l) => l.label === "Beginning grand total (gross)",
    ).value,
  ).toBe("₱135.00");
  expect(
    (await h.db`select count(*)::int as n from store_accumulator_openings`)[0]
      .n,
  ).toBe(1);
  // the database itself refuses a first accumulator row that does not start at the opening
  const made = await web("registers/save", {
    locationId: location,
    terminalCode: "REG10",
    name: "Till ten",
  });
  const [d10] =
    await h.db`insert into store_till_days(register_id,business_date,status) values(${made.id},'2026-10-01','open') returning id`;
  await h.db`insert into store_accumulator_openings(register_id,opening_gross_centavos,opening_net_centavos,sales_count,through_business_date) values(${made.id},500,400,3,'2026-10-01')`;
  const accumulator = (
    /** @type {number} */ gross,
    /** @type {number} */ net,
  ) =>
    h.db`insert into store_fiscal_accumulators(register_id,z_counter,reset_counter,beginning_gross_centavos,ending_gross_centavos,beginning_net_centavos,ending_net_centavos,till_day_id) values(${made.id},1,0,${gross},${gross + 10},${net},${net + 10},${d10.id})`;
  await fails(accumulator(0, 0));
  await accumulator(500, 400);
}, 90000);

test(
  "P1-1: a register with weeks of old open days: the new session gets today, the old days become closed_no_z, and the Z covers only today",
  async () => {
    const made = await web("registers/save", {
      locationId: location,
      terminalCode: "REG09",
      name: "Till nine",
    });
    const [reg] =
      await h.db`select r.*,l.organization_id from store_registers r join inventory_locations l on l.id=r.location_id where r.id=${made.id}`;
    const old = [];
    for (const d of ["2026-10-01", "2026-10-08", "2026-10-15", "2026-10-22"]) {
      const [row] =
        await h.db`insert into store_till_days(register_id,business_date,status,opened_at) values(${reg.id},${d},'open',${new Date(d + "T01:00:00Z")}) returning id`;
      await h.db`insert into store_shifts(id,register_id,mode_version_id,policy_id,device_id,cashier_id,service_date,opening_centavos,opened_at,till_day_id) values(${crypto.randomUUID()},${reg.id},${A.mode},${policy},${A.s.deviceId},${A.s.profile.id},${d},0,${new Date(d + "T01:00:00Z")},${row.id})`;
      old.push(row.id);
    }
    const now = Date.now();
    const fresh = await tx(h.db, (db) => tillDayForOpen(db, reg, now));
    expect(old).not.toContain(fresh.id);
    expect(ymd(fresh.business_date)).toBe(manilaBusinessDate(now));
    expect((await tx(h.db, (db) => tillDayForOpen(db, reg, now))).id).toBe(
      fresh.id,
    );
    await h.db.unsafe(closeOldDaysSql());
    const states =
      await h.db`select status from store_till_days where register_id=${reg.id} order by business_date`;
    expect(states.map((/** @type {any} */ r) => r.status)).toEqual([
      "closed_no_z",
      "closed_no_z",
      "closed_no_z",
      "closed_no_z",
      "open",
    ]);
    // today's session, closed; the Z reads only today's session
    const shift = crypto.randomUUID();
    await h.db`insert into store_shifts(id,register_id,mode_version_id,policy_id,device_id,cashier_id,service_date,opening_centavos,opened_at,till_day_id) values(${shift},${reg.id},${A.mode},${policy},${A.s.deviceId},${A.s.profile.id},${ymd(fresh.business_date)},0,${new Date(now)},${fresh.id})`;
    await h.db`insert into store_shift_closures(id,shift_id,declared_centavos,expected_centavos,variance_centavos,needs_review,closed_at) values(${crypto.randomUUID()},${shift},0,0,0,false,${new Date(now + 1000)})`;
    const z = await tx(h.db, (db) =>
      generateZ(db, reg, supervisorActor, {
        dayId: fresh.id,
        readId: crypto.randomUUID(),
        at: now + 2000,
      }),
    );
    expect(z.model.sessions).toHaveLength(1);
    expect(z.model.businessDate).toBe(manilaBusinessDate(now));
    const [typed] =
      await h.db`select sessions_count from store_z_readings where id=${z.id}`;
    expect(typed.sessions_count).toBe(1);
  },
  T,
);

test(
  "P1-3: ten wrong PIN tries from a device that is not on a register never lock the supervisor",
  async () => {
    const c = await boundDevice(h, people, {
      app: "van-android",
      orgUnitId: unit,
    });
    await persist(c);
    for (let i = 0; i < 10; i++) {
      const r = await signedPost(h, c, "/api/v1/storepos/overrides/verify", {
        deviceId: c.deviceId,
        supervisorProfileId: sup.profile.id,
        pin: "111111",
        kind: "void_sale",
        refId: crypto.randomUUID(),
        amountCentavos: "4500",
      });
      expect(r.res.status).toBe(422);
      expect(JSON.stringify(r.body)).not.toMatch(/Too many/);
    }
    expect(
      (
        await h.db`select count(*)::int as n from store_supervisor_pin_attempts where profile_id=${sup.profile.id} and failed_count>0`
      )[0].n,
    ).toBe(0);
    // the real till can still have the supervisor approve
    const ok = await signedPost(h, B.s, "/api/v1/storepos/overrides/verify", {
      deviceId: B.s.deviceId,
      supervisorProfileId: sup.profile.id,
      pin: PIN,
      kind: "void_sale",
      refId: crypto.randomUUID(),
      amountCentavos: "4500",
    });
    expect(ok.res.status).toBe(200);
    // an authorised device that guesses wrong is still counted and locked (the old rule is kept)
    for (let i = 0; i < 5; i++)
      expect(
        (
          await signedPost(h, B.s, "/api/v1/storepos/overrides/verify", {
            deviceId: B.s.deviceId,
            supervisorProfileId: sup.profile.id,
            pin: "111111",
            kind: "void_sale",
            refId: crypto.randomUUID(),
            amountCentavos: "4500",
          })
        ).res.status,
      ).toBe(422);
    expect(
      (
        await signedPost(h, B.s, "/api/v1/storepos/overrides/verify", {
          deviceId: B.s.deviceId,
          supervisorProfileId: sup.profile.id,
          pin: "111111",
          kind: "void_sale",
          refId: crypto.randomUUID(),
          amountCentavos: "4500",
        })
      ).res.status,
    ).toBe(429);
  },
  T,
);

test(
  "P2-5 (b): counts already running at deploy finish under the old rules; planned v2 counts are left alone",
  async () => {
    const mk = async (
      /** @type {string} */ n,
      /** @type {string} */ status,
      /** @type {string|null} */ planner,
    ) =>
      (
        await h.db`insert into stock_count_sessions(organization_id,count_number,count_type,location_id,status,blind_count,snapshot_at,created_by,planned_by) values('sunpride',${n},'full',${location},${status},true,now(),${boss.userId},${planner}) returning id`
      )[0].id;
    const running = await mk("I2F-OLD-1", "counting", null);
    const submitted = await mk("I2F-OLD-2", "submitted", null);
    const done = await mk("I2F-OLD-3", "posted", null);
    const v2 = await mk("I2F-V2-1", "counting", boss.userId);
    await h.db.unsafe(migrationSql("0771_counts_in_flight_legacy.sql"));
    const flags = Object.fromEntries(
      (
        await h.db`select id,legacy_whole from stock_count_sessions where id in ${h.db([running, submitted, done, v2])}`
      ).map((/** @type {any} */ r) => [r.id, r.legacy_whole]),
    );
    expect(flags).toEqual({
      [running]: true,
      [submitted]: true,
      [done]: false,
      [v2]: false,
    });
  },
  T,
);

test(
  "P2 (c): a default stock band for manager and admin is seeded, labelled, and safe to run again",
  async () => {
    const sql = migrationSql("0773_default_stock_bands.sql");
    await h.db.unsafe(sql);
    await h.db.unsafe(sql);
    const rows =
      await h.db`select role,label,self_limit_centavos,sample from fiscal_authority_rules where org_unit_id=${unit} and kind='stock' order by role`;
    expect(
      rows.map((/** @type {any} */ r) => [r.role, r.label, r.sample]),
    ).toEqual([
      ["admin", "default", false],
      ["manager", "default", false],
    ]);
    const manager = await actorFor(h.db, sup.userId);
    const rule = await authorityRule(h.db, manager, {
      orgUnitId: unit,
      kind: "stock",
      channel: "inventory",
      amountCentavos: "150000",
    });
    expect(rule.label).toBe("default");
    expect(BigInt(rule.self_limit_centavos)).toBeGreaterThan(150000n);
  },
  T,
);

test(
  "P2-4 (e): inside a command that holds the org lock, postings take no per-row locks",
  async () => {
    const lines = Array.from({ length: 300 }, () => ({
      productId: crypto.randomUUID(),
      fromLocationId: crypto.randomUUID(),
      toLocationId: null,
    }));
    const held = async (/** @type {any} */ t) =>
      Number(
        (
          await t`select count(*)::int as n from pg_locks where locktype='advisory' and pid=pg_backend_pid()`
        )[0].n,
      );
    const plain = await h.db.begin(async (/** @type {any} */ t) => {
      await postingLocks(t, "sunpride", "k1", lines);
      return held(t);
    });
    const exclusive = await h.db.begin(async (/** @type {any} */ t) => {
      await stockLock(t, "sunpride");
      await postingLocks(t, "sunpride", "k2", lines);
      return held(t);
    });
    expect(plain).toBeGreaterThan(300);
    expect(exclusive).toBeLessThanOrEqual(2);
  },
  T,
);
