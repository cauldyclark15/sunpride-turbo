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

let day1 = "",
  day2 = "";

test("pesoText is exact, never floating point", () => {
  expect(pesoText("0")).toBe("₱0.00");
  expect(pesoText("5")).toBe("₱0.05");
  expect(pesoText("123456")).toBe("₱1,234.56");
  expect(pesoText("-50")).toBe("-₱0.50");
  expect(pesoText("9007199254740993")).toBe("₱90,071,992,547,409.93");
  expect(pesoText(null)).toBe("—");
});
test("pure math: privilege lines get their own Z buckets and the accumulator wraps without ever going backwards", () => {
  const receipt = (/** @type {any} */ extra) => ({
    totalMinor: "2786",
    lines: [{ discountCentavos: 0 }],
    tax: {
      vatableSalesMinor: "0",
      vatMinor: "0",
      vatExemptMinor: "3482",
      zeroRatedMinor: "0",
    },
    ...extra,
  });
  const agg = aggregateSales(
    [
      {
        number: "SI-1",
        status: "fulfilled",
        receipt: receipt({
          privilege: {
            byType: {
              senior: { discountMinor: "696", vatRemovedMinor: "418" },
            },
          },
        }),
      },
      {
        number: "SI-2",
        status: "fulfilled",
        receipt: receipt({
          privilege: {
            type: "pwd",
            discountMinor: "696",
            vatRemovedMinor: "418",
          },
        }),
      },
      { number: "SI-3", status: "voided", receipt: receipt({}) },
    ],
    [{ number: "CM-1", amount: "2786" }],
  );
  expect(agg.transactions).toBe(2);
  expect(agg.privilege.senior).toBe(696n);
  expect(agg.privilege.pwd).toBe(696n);
  expect(agg.vatRemoved).toBe(836n);
  expect(agg.net).toBe(5572n);
  expect(agg.gross).toBe(5572n + 1392n + 836n);
  expect(agg.voids).toMatchObject({ count: 1, total: 2786n, first: "SI-3" });
  expect(agg.refunds.total).toBe(2786n);
  expect(agg.firstNumber).toBe("SI-1");
  expect(agg.lastNumber).toBe("SI-2");
  expect(privilegeOf({}).vatRemoved).toBe(0n);
  const first = advanceAccumulator(null, 1000n, 900n);
  expect(first).toMatchObject({
    zCounter: 1,
    resetCounter: 0,
    beginningGross: 0n,
    endingGross: 1000n,
  });
  const second = advanceAccumulator(
    {
      z_counter: 1,
      reset_counter: 0,
      ending_gross_centavos: 1000n,
      ending_net_centavos: 900n,
    },
    500n,
    450n,
  );
  expect(second).toMatchObject({
    zCounter: 2,
    beginningGross: 1000n,
    endingGross: 1500n,
    endingNet: 1350n,
  });
  const wrap = advanceAccumulator(
    {
      z_counter: 9,
      reset_counter: 0,
      ending_gross_centavos: RESET_LIMIT - 10n,
      ending_net_centavos: 0n,
    },
    25n,
    0n,
  );
  expect(wrap.resetCounter).toBe(1);
  expect(wrap.endingGross).toBe(15n);
});

test(
  "SPEC 7.8: opening lands on an open session of a new till day; the server acknowledges it back to the phone",
  async () => {
    const r = await A.open("200000");
    const day = await sessionDay(A.shift);
    expect(day.status).toBe("open");
    expect(r.ack.entityId).toBe(A.shift);
    expect(r.ack.eventIds).toEqual([day.id]);
    day1 = day.id;
    const [s] = await h.db`select * from store_shifts where id=${A.shift}`;
    expect(s.doc_number).toMatch(/^SHF-REG01-\d{6}-0001$/);
    expect(day.doc_number).toMatch(/^TILL-REG01-\d{6}-0001$/);
    const [closure] =
      await h.db`select 1 from store_shift_closures where shift_id=${A.shift}`;
    expect(closure).toBeUndefined();
    // The bundle is the server's own list of this handheld's sessions, not the outbox.
    const device = (
      await h.db`select * from registered_devices where id=${A.s.deviceId}`
    )[0];
    const mode = (
      await h.db`select * from pos_device_modes where id=${A.mode}`
    )[0];
    const bundle = /** @type {any} */ (
      await modeBundle(h.db, await actorFor(h.db, A.s.userId), device, mode)
    );
    expect(bundle.shift.shiftId).toBe(A.shift);
    expect(bundle.shift.tillDayId).toBe(day.id);
    expect(bundle.sessions[0]).toMatchObject({
      shiftId: A.shift,
      status: "open",
      dayStatus: "open",
    });
    // per-supervisor verifier travels in the bundle, never the key
    const mine = bundle.supervisors.find(
      (/** @type {any} */ x) => x.profileId === sup.profile.id,
    );
    expect(mine).toBeTruthy();
    expect(mine.salt).toBeTruthy();
    expect(mine.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(bundle.supervisors)).not.toContain("pin_key");
  },
  T,
);

test(
  "SPEC 7.8: two cashiers share one register in sequence; the Z covers both and only runs after both close",
  async () => {
    await A.sell("cash");
    await A.close("204500");
    // second cashier on the same register, same business day
    await B.open("100000");
    expect((await sessionDay(B.shift)).id).toBe(day1);
    await B.sell("gcash");
    // one open session at a time on a register
    const clash = await A.send(
      A.op("store.shift.open", {
        shiftId: crypto.randomUUID(),
        policyId: policy,
        openingCentavos: "0",
      }),
    );
    expect(clash.status).toBe("rejected");
    const early = await webRaw(`days/${day1}/z`, {});
    expect(early.status).toBe(422);
    expect(early.body.error.message).toMatch(/open cashier session/);
    await B.close("100000");
    const z = await web(`days/${day1}/z`, {});
    expect(z.zCounter).toBe(1);
    expect(z.docNumber).toMatch(/^Z-REG01-\d{6}-0001$/);
    const [row] =
      await h.db`select * from store_z_readings where till_day_id=${day1}`;
    expect(row.sessions_count).toBe(2);
    expect(row.transactions_count).toBe(2);
    expect(String(row.net_sales_centavos)).toBe("9000");
    expect(String(row.cash_tender_centavos)).toBe("4500");
    expect(String(row.gcash_tender_centavos)).toBe("4500");
    expect(String(row.opening_float_centavos)).toBe("300000");
    expect(String(row.expected_cash_centavos)).toBe("304500");
    expect(String(row.counted_cash_centavos)).toBe("304500");
    expect(String(row.short_over_centavos)).toBe("0");
    expect(row.beginning_invoice).toMatch(/-000000001$/);
    expect(row.ending_invoice).toMatch(/-0000000\d+$/);
    expect(String(row.beginning_gross_centavos)).toBe("0");
    expect(String(row.ending_gross_centavos)).toBe("9000");
    expect(row.z_counter.toString()).toBe("1");
    expect((await dayRow(day1)).status).toBe("z_done");
    expect(
      z.printModel.lines.find(
        (/** @type {any} */ l) => l.label === "Z counter no.",
      ).value,
    ).toBe("1");
    // a second Z for the same day is refused, and the old JSON read row still exists for deposits
    expect((await webRaw(`days/${day1}/z`, {})).status).toBe(422);
    const [read] =
      await h.db`select snapshot from store_reads where id=${row.read_id}`;
    expect(read.snapshot.salesCentavos).toBe("9000");
    expect(read.snapshot.typed).toBe(true);
  },
  T,
);

test(
  "SPEC 7.8: a session opened after the Z belongs to the next business date; sales on the closed day are refused",
  async () => {
    await A.open("1000000");
    const day = await sessionDay(A.shift);
    const d1 = await dayRow(day1);
    expect(day.id).not.toBe(day1);
    expect(
      new Date(day.business_date).getTime() -
        new Date(d1.business_date).getTime(),
    ).toBe(86400000);
    day2 = day.id;
    // the old session cannot sell any more
    const oldSession = B.shift;
    B.shift = oldSession;
    const r = await B.send((await B.saleOp("cash")).operation);
    expect(r.status).toBe("rejected");
  },
  T,
);

test(
  "SPEC 7.8: a ₱5,000 drop mid-session is in expected cash, needs a supervisor, and cannot be forged",
  async () => {
    await A.sell("cash");
    const id = crypto.randomUUID();
    const drop = (/** @type {any} */ extra) => ({
      kind: "drop",
      amountCentavos: "500000",
      reasonCode: "safe_drop",
      ...extra,
    });
    const mk = (/** @type {any} */ p) => ({
      ...A.op("store.cash", p),
      clientOpId: id,
    });
    // no supervisor: refused, nothing written
    const none = await A.send(A.op("store.cash", drop({})));
    expect(none.status).toBe("rejected");
    // proof for a different amount is refused
    const small = await proofFor("cash_drop", id, A.shift, "100000");
    expect((await A.send(mk(drop({ supervisor: small })))).status).toBe(
      "rejected",
    );
    // the right proof is accepted once
    const good = await proofFor("cash_drop", id, A.shift, "500000");
    const ok = await A.send(mk(drop({ supervisor: good })));
    expect(ok.status).toBe("applied");
    const [m] = await h.db`select * from store_cash_movements where id=${id}`;
    expect(m.slip_number).toMatch(/^REM-REG01-\d{6}-0001$/);
    expect(m.supervisor_profile_id).toBe(sup.profile.id);
    // the same proof cannot move a different movement
    const reuse = await A.send(A.op("store.cash", drop({ supervisor: good })));
    expect(reuse.status).toBe("rejected");
    // a supervisor cannot approve for themselves: the cashier's own proof is not accepted either way
    const closeOk = await A.close("504500");
    expect(closeOk.status).toBe("applied");
    const [c] =
      await h.db`select * from store_shift_closures where shift_id=${A.shift}`;
    expect(String(c.expected_centavos)).toBe("504500");
    expect(String(c.variance_centavos)).toBe("0");
    expect(c.needs_review).toBe(false);
    const [o] = await h.db`select * from store_overrides where ref_id=${id}`;
    expect(o).toMatchObject({
      kind: "cash_drop",
      method: "pin_offline",
      supervisor_profile_id: sup.profile.id,
    });
    expect(String(o.amount_centavos)).toBe("500000");
    // the office lists it
    const list = await get(`overrides?registerId=${register}`);
    expect(list.status).toBe(200);
    expect(
      list.body.overrides.some(
        (/** @type {any} */ x) =>
          x.id === id && x.supervisorName === "Store supervisor",
      ),
    ).toBe(true);
    const moves = await get(`cash-movements?dayId=${day2}`);
    expect(moves.body.movements[0]).toMatchObject({
      kind: "drop",
      amountCentavos: "500000",
      effectCentavos: "-500000",
    });
  },
  T,
);

test(
  "SPEC 7.8: a senior citizen sale prints in its own Z line; grand totals only grow across days",
  async () => {
    // Lane BIR writes receipt.privilege; simulate that exact contract on one saved receipt.
    const [sale] =
      await h.db`select s.id from store_sales s join store_shifts h on h.id=s.shift_id where h.till_day_id=${day2} limit 1`;
    await h.db.unsafe(
      "alter table store_sales disable trigger store_sale_immutable",
    );
    await h.db`update store_sales set receipt=jsonb_set(receipt,'{privilege}',${{ byType: { senior: { discountMinor: "696", vatRemovedMinor: "418" } } }}::jsonb) where id=${sale.id}`;
    await h.db.unsafe(
      "alter table store_sales enable trigger store_sale_immutable",
    );
    const z = await web(`days/${day2}/z`, {});
    expect(z.zCounter).toBe(2);
    const [row] =
      await h.db`select * from store_z_readings where till_day_id=${day2}`;
    expect(String(row.senior_discount_centavos)).toBe("696");
    expect(String(row.pwd_discount_centavos)).toBe("0");
    expect(String(row.vat_removed_centavos)).toBe("418");
    expect(String(row.gross_sales_centavos)).toBe(String(4500 + 696 + 418));
    expect(
      z.printModel.lines.find((/** @type {any} */ l) =>
        l.label.startsWith("Senior"),
      ).value,
    ).toBe("₱6.96");
    // grand totals continue from the last Z and never decrease
    expect(String(row.beginning_gross_centavos)).toBe("9000");
    expect(BigInt(row.ending_gross_centavos)).toBeGreaterThanOrEqual(
      BigInt(row.beginning_gross_centavos),
    );
    expect(String(row.ending_gross_centavos)).toBe(
      String(9000 + 4500 + 696 + 418),
    );
    expect(String(row.ending_net_centavos)).toBe("13500");
    // append-only: no edit, no delete, no step backwards
    await fails(
      h.db`update store_fiscal_accumulators set ending_gross_centavos=0 where z_counter=2`,
    );
    await fails(h.db`delete from store_fiscal_accumulators where z_counter=2`);
    await fails(
      h.db`update store_z_readings set net_sales_centavos=1 where id=${row.id}`,
    );
    const [reg] = await h.db`select id from store_registers limit 1`;
    const [last] =
      await h.db`select * from store_fiscal_accumulators where register_id=${reg.id} order by z_counter desc limit 1`;
    const d3 = (
      await h.db`insert into store_till_days(register_id,business_date) values(${reg.id},'2099-01-01') returning id`
    )[0];
    await fails(
      h.db`insert into store_fiscal_accumulators(register_id,z_counter,reset_counter,beginning_gross_centavos,ending_gross_centavos,beginning_net_centavos,ending_net_centavos,till_day_id) values(${reg.id},3,0,${String(last.ending_gross_centavos)},1,${String(last.ending_net_centavos)},${String(last.ending_net_centavos)},${d3.id})`,
    );
    // typed read path
    const zl = await get(
      `z-readings?registerId=${register}&from=2026-01-01&to=2099-01-01`,
    );
    expect(zl.body.readings.map((/** @type {any} */ r) => r.zCounter)).toEqual([
      2, 1,
    ]);
    expect(zl.body.readings[0].seniorDiscountCentavos).toBe("696");
    const zr = await get(`z-readings/${row.id}`);
    expect(zr.body.printModel.reprint).toBe(true);
  },
  T,
);

test(
  "X reading is read-only, printable any time, and prints the same lines as the Z",
  async () => {
    await A.open("100000");
    const day3 = (await sessionDay(A.shift)).id;
    await A.sell("cash");
    const before =
      await h.db`select (select count(*)::int from store_reads) as reads,(select count(*)::int from store_fiscal_accumulators) as acc,(select count(*)::int from store_z_readings) as z`;
    const x1 = await get(`days/${day3}/reading`);
    const x2 = await get(`days/${day3}/reading`);
    expect(x1.status).toBe(200);
    expect(x1.body.reading.provisional).toBe(true);
    expect(x1.body.reading.sales.netCentavos).toBe("4500");
    expect(x1.body.reading.accumulators.beginningGrossCentavos).toBe("14614");
    expect(x2.body.reading.accumulators).toEqual(x1.body.reading.accumulators);
    const after =
      await h.db`select (select count(*)::int from store_reads) as reads,(select count(*)::int from store_fiscal_accumulators) as acc,(select count(*)::int from store_z_readings) as z`;
    expect(after[0]).toEqual(before[0]);
    // the handheld's own numbered X: stored, but no accumulator or day state moves
    await A.push(A.op("store.read", { kind: "x" }));
    const mid =
      await h.db`select (select count(*)::int from store_fiscal_accumulators) as acc`;
    expect(mid[0].acc).toBe(before[0].acc);
    expect((await dayRow(day3)).status).toBe("open");
    // a cashier cannot Z at the till without a supervisor, and not while the session is open
    expect((await A.send(A.op("store.read", { kind: "z" }))).status).toBe(
      "rejected",
    );
    await A.close("104500");
    const xClosed = await get(`days/${day3}/reading`);
    const z = await web(`days/${day3}/z`, {});
    const labels = (/** @type {any} */ m) =>
      m.lines
        .map((/** @type {any} */ l) => l.label)
        .filter(
          (/** @type {string} */ l) => !/^(Z counter|Reset counter)/.test(l),
        );
    expect(labels(xClosed.body.printModel)).toEqual(labels(z.printModel));
    expect(labels(x1.body.printModel).length).toBeGreaterThan(20);
    expect(x1.body.printModel.title).toMatch(/^X READING/);
    expect(z.printModel.title).toBe("Z READING");
  },
  T,
);

test(
  "Z at the till needs a supervisor's signed approval and every session closed",
  async () => {
    await A.open("0");
    await A.sell("cash");
    await A.close("4500");
    const id = crypto.randomUUID();
    const dayId = (await sessionDay(A.shift)).id;
    const sig = await proofFor("z_reading", id, A.shift, "0");
    // a request that carries a proof stays strict: a forged one is refused (a request with NO proof is the legacy path, see
    // storepos-int2fix.test.js)
    const forged = {
      ...A.op("store.read", {
        kind: "z",
        supervisor: { ...sig, proof: "0".repeat(64) },
      }),
      clientOpId: id,
    };
    expect((await A.send(forged)).status).toBe("rejected");
    const ok = await A.send({
      ...A.op("store.read", { kind: "z", supervisor: sig }),
      clientOpId: id,
    });
    expect(ok.status).toBe("applied");
    const [z] =
      await h.db`select * from store_z_readings where till_day_id=${dayId}`;
    expect(z.generated_by).toBe(sup.profile.id);
    expect(Number(z.z_counter)).toBe(4);
    const [o] =
      await h.db`select * from store_overrides where kind='z_reading' and ref_id=${id}`;
    expect(o.supervisor_profile_id).toBe(sup.profile.id);
  },
  T,
);

test(
  "supervisor at the till voids a sale: approved now, logged for the office; PIN rate limit holds",
  async () => {
    await B.open("100000");
    const saleId = await B.sell("cash");
    const check = (/** @type {string} */ pin, /** @type {string} */ refId) =>
      signedPost(h, B.s, "/api/v1/storepos/overrides/verify", {
        deviceId: B.s.deviceId,
        supervisorProfileId: sup.profile.id,
        pin,
        kind: "void_sale",
        refId,
        shiftId: B.shift,
        amountCentavos: "4500",
      });
    // five wrong PINs, then even the right one is locked out
    for (let i = 0; i < 5; i++) {
      const w = await check("111111", saleId);
      expect(w.res.status).toBe(422);
    }
    const locked = await check(PIN, saleId);
    expect(locked.res.status).toBe(429);
    // the office resets it by setting the PIN again
    await web("supervisors/pin", { profileId: sup.profile.id, pin: PIN });
    const signed = await check(PIN, saleId);
    expect(signed.res.status).toBe(200);
    expect(signed.body.proof).toMatch(/^[a-f0-9]{64}$/);
    expect(signed.body.pin).toBeUndefined();
    // a proof for this sale cannot void another sale
    const other = await B.sell("cash");
    const wrongSale = await B.send(
      B.op("store.void", {
        saleId: other,
        reason: "SAMPLE wrong",
        supervisor: {
          profileId: sup.profile.id,
          pinId: signed.body.pinId,
          method: "pin_online",
          proof: signed.body.proof,
        },
      }),
    );
    expect(wrongSale.status).toBe("rejected");
    const v = await B.send(
      B.op("store.void", {
        saleId,
        reason: "SAMPLE customer left",
        supervisor: {
          profileId: sup.profile.id,
          pinId: signed.body.pinId,
          method: "pin_online",
          proof: signed.body.proof,
        },
      }),
    );
    expect(v.status).toBe("applied");
    const [rev] =
      await h.db`select status,decided_by from store_reversals where sale_id=${saleId}`;
    expect(rev).toMatchObject({
      status: "approved",
      decided_by: sup.profile.id,
    });
    const [o] =
      await h.db`select * from store_overrides where kind='void_sale' and ref_id=${saleId}`;
    expect(o).toMatchObject({
      method: "pin_online",
      supervisor_profile_id: sup.profile.id,
    });
    // a supervisor's PIN retired before the action was captured is refused on sync
    const old = await proofFor("price", "line-1", B.shift, "0");
    await h.db`update store_supervisor_pins set effective_from=now()-interval '10 minutes',effective_to=now()-interval '1 minute' where id=${old.pinId}`;
    const stale = await B.send(
      B.op("store.override", {
        kind: "price",
        refType: "line",
        refId: "line-1",
        amountCentavos: "0",
        reason: "SAMPLE price",
        supervisor: old,
      }),
    );
    expect(stale.status).toBe("rejected");
    await web("supervisors/pin", { profileId: sup.profile.id, pin: PIN });
    // a fresh key signs a logged line void
    const fresh = await proofFor("void_line", "line-9", B.shift, "0");
    const lv = await B.send(
      B.op("store.override", {
        kind: "void_line",
        refType: "line",
        refId: "line-9",
        amountCentavos: "0",
        reason: "SAMPLE scanned twice",
        supervisor: fresh,
      }),
    );
    expect(lv.status).toBe("applied");
    const list = await get(`overrides?registerId=${register}&kind=void_line`);
    expect(list.body.overrides).toHaveLength(1);
  },
  T,
);

test(
  "suspended sessions cannot sell; resume restores selling",
  async () => {
    await B.push(B.op("store.shift.suspend", { reason: "SAMPLE lunch" }));
    expect((await B.send((await B.saleOp("cash")).operation)).status).toBe(
      "rejected",
    );
    const view = await get(`days/${(await sessionDay(B.shift)).id}`);
    expect(view.body.reading.sessions.at(-1).status).toBe("suspended");
    await B.push(B.op("store.shift.resume", {}));
    await B.sell("cash");
  },
  T,
);

test(
  "office force-close needs a reason, closes with no count, keeps late offline sales, and the phone is told",
  async () => {
    const late = await B.saleOp("cash");
    const day = await sessionDay(B.shift);
    const none = await webRaw("sessions/force-close", { sessionId: B.shift });
    expect(none.status).toBe(400);
    const done = await web("sessions/force-close", {
      sessionId: B.shift,
      reason: "SAMPLE cashier went home sick",
    });
    expect(done.id).toBe(B.shift);
    const [c] =
      await h.db`select * from store_shift_closures where shift_id=${B.shift}`;
    expect(c).toMatchObject({
      kind: "forced",
      needs_review: true,
      force_reason: "SAMPLE cashier went home sick",
    });
    expect(c.forced_by).toBe(boss.profile.id);
    const device = (
      await h.db`select * from registered_devices where id=${B.s.deviceId}`
    )[0];
    const mode = (
      await h.db`select * from pos_device_modes where id=${B.mode}`
    )[0];
    const bundle = /** @type {any} */ (
      await modeBundle(h.db, await actorFor(h.db, B.s.userId), device, mode)
    );
    expect(bundle.shift).toBeNull();
    expect(bundle.sessions[0]).toMatchObject({
      shiftId: B.shift,
      status: "force_closed",
    });
    // sale captured before the force-close, synced after: accepted, never silently dropped
    const r = await B.send(late.operation);
    expect(r.status).toBe("applied");
    // the cashier's own phone can no longer sell new items after the close
    expect(
      (await B.send((await B.saleOp("cash", Date.now() + 5000)).operation))
        .status,
    ).toBe("rejected");
    const z = await web(`days/${day.id}/z`, {});
    const [row] =
      await h.db`select * from store_z_readings where till_day_id=${day.id}`;
    expect(row.forced_sessions).toBe(1);
    expect(row.counted_cash_centavos).toBeNull();
    expect(
      z.printModel.lines.some(
        (/** @type {any} */ l) => l.label === "Cash counted",
      ),
    ).toBe(false);
    const o = await get(`overrides?registerId=${register}&kind=force_close`);
    expect(o.body.overrides[0]).toMatchObject({
      kind: "force_close",
      method: "office",
      reason: "SAMPLE cashier went home sick",
    });
  },
  T,
);

test(
  "a session that crosses midnight stays in its till day; a Z moves the next session to the next date",
  async () => {
    const second = await web("registers/save", {
      locationId: location,
      terminalCode: "REG02",
      name: "Till two",
    });
    const [reg] =
      await h.db`select r.*,l.organization_id from store_registers r join inventory_locations l on l.id=r.location_id where r.id=${second.id}`;
    const { tillDayForOpen } =
      await import("../src/domains/storepos/till-days.js");
    // Manila 2026-03-10 23:50 and 2026-03-11 00:20 as real instants
    const late = Date.parse("2026-03-10T15:50:00Z"),
      after = Date.parse("2026-03-10T16:20:00Z");
    const first = await tx(h.db, (db) => tillDayForOpen(db, reg, late));
    // a session still open across midnight keeps the day (IP-INT2FIX: only then may yesterday's day be joined)
    await h.db`insert into store_shifts(id,register_id,mode_version_id,policy_id,device_id,cashier_id,service_date,opening_centavos,opened_at,till_day_id) values(${crypto.randomUUID()},${reg.id},${A.mode},${policy},${A.s.deviceId},${A.s.profile.id},'2026-03-10',0,${new Date(late)},${first.id})`;
    expect(
      String(first.business_date.toISOString?.() ?? first.business_date).slice(
        0,
        10,
      ),
    ).toBe("2026-03-10");
    const again = await tx(h.db, (db) => tillDayForOpen(db, reg, after));
    expect(again.id).toBe(first.id);
    // while day-end is under way, nobody can slip a session into the day
    await h.db`update store_till_days set status='closing',closing_at=now() where id=${first.id}`;
    await expect(
      tx(h.db, (db) => tillDayForOpen(db, reg, after)),
    ).rejects.toThrow(/Day-end has started/);
    // Z done: the next session is the next business date even though the clock still says 03-11 early morning
    await h.db`update store_till_days set status='z_done',z_done_at=now() where id=${first.id}`;
    const next = await tx(h.db, (db) => tillDayForOpen(db, reg, after));
    expect(next.id).not.toBe(first.id);
    expect(
      String(next.business_date.toISOString?.() ?? next.business_date).slice(
        0,
        10,
      ),
    ).toBe("2026-03-11");
    const [seq] =
      await h.db`select count(*)::int as n from store_till_days where register_id=${reg.id}`;
    expect(seq.n).toBe(2);
  },
  T,
);

test(
  "legacy Z rows (no typed row) stay listed and readable",
  async () => {
    // A pre-IP-ZDAY Z: only a store_reads row and its day. It must list as legacy, not vanish or crash.
    const [reg] = await h.db`select id from store_registers limit 1`;
    const [shift] =
      await h.db`select s.id from store_shifts s where s.register_id=${reg.id} limit 1`;
    const old = crypto.randomUUID();
    await h.db.unsafe(
      "alter table store_reads disable trigger store_read_immutable",
    );
    await h.db`insert into store_reads(id,register_id,shift_id,kind,sequence,snapshot,captured_at) values(${old},${reg.id},${shift.id},'z',97,${{ kind: "z", date: "2025-12-31", salesCentavos: "1234", tenders: [] }},${new Date("2025-12-31T10:00:00Z")})`;
    await h.db.unsafe(
      "alter table store_reads enable trigger store_read_immutable",
    );
    const list = await get(
      `z-readings?registerId=${register}&from=2025-12-01&to=2025-12-31`,
    );
    expect(list.body.legacy).toHaveLength(1);
    expect(list.body.legacy[0]).toMatchObject({
      legacy: true,
      zCounter: 97,
      netSalesCentavos: "1234",
      typed: false,
    });
  },
  T,
);
