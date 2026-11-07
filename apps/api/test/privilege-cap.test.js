import { beforeAll, afterAll, test, expect } from "bun:test";
import { tx } from "@sunpride/db/client";
import {
  startHarness,
  profileStore,
  boundDevice,
  createUser,
  signedPost,
} from "./harness.js";
import { install as installStore } from "../src/domains/storepos/index.js";
import { install as installFiscal } from "../src/domains/fiscal/index.js";
import { install as installDecide } from "../src/domains/decide/index.js";
import { actorFor } from "../src/core/context.js";
import { ingestMaster } from "../src/domains/integration/replicas.js";
import { sampleMaster, sampleMasters } from "../../sap-mock/src/sample.js";
import { postMovement } from "../src/domains/inventory/posting.js";
import {
  allocateDocumentNumber,
  saveRegistration,
  createSeries,
} from "../src/domains/fiscal/series.js";
import {
  prepareLegalSale,
  normalizeClaim,
  surfaceEnabled,
} from "../src/domains/fiscal/legal-sale.js";
import { buildPrintModel } from "../src/domains/fiscal/print-model.js";
import {
  capBundle,
  capSetting,
  computeOne,
  computeWithBudget,
  idHash,
  idKey,
  manilaWeekStart,
  manilaWeekEndsAt,
  weeklyLimitText,
  DEFAULT_WEEKLY_CAP_CENTAVOS,
} from "../src/domains/fiscal/privilege-cap.js";
import { vanProjection } from "../src/domains/van/projection.js";
import { assertLegacyZAllowed } from "../src/domains/storepos/legacy-z.js";
import vectors from "./fixtures/privilege-cap-vectors.json";

/** IP-BIR: legal selling through the store till, end to end (Itemcount PHP 39 senior case, mixed cart, mismatch, receipt, e-journal). */
/** @type {any} */ let h;
/** @type {any} */ let people;
/** @type {any} */ let seller;
/** @type {any} */ let boss;
const unit = crypto.randomUUID(),
  location = crypto.randomUUID(),
  outlet = crypto.randomUUID();
let register = "",
  policy = "",
  mode = "",
  cookie = "",
  allocation = "",
  prefix = "",
  shift = "",
  siRegistration = "";
/** @type {Record<string,string>} */ const products = {};
/** @param {any} who */ async function persist(who) {
  const p = who.profile;
  await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${who.userId},${who.userId},${p.name},${who.email},${p.role},'active',${unit})`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},${p.role},now()-interval '1 day','fixture','fixture')`;
}
/** @param {string} path @param {any} p */ async function web(path, p) {
  const res = await h.fetch("/api/v1/storepos/" + path, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      registerId: register,
      ...p,
      requestKey: crypto.randomUUID(),
    }),
  });
  const data = await res.json();
  if (res.status !== 200) throw new Error(JSON.stringify(data));
  return data;
}
/** @param {string} path @param {any} [body] */ async function api(path, body) {
  const res = await h.fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}
/** @param {string} kind @param {any} p */ function op(kind, p) {
  const time = Date.now();
  return {
    clientOpId: crypto.randomUUID(),
    opType: kind,
    clientTime: time,
    dependsOn: [],
    payload: {
      registerId: register,
      modeVersionId: mode,
      shiftId: shift,
      ...p,
      deviceTime: time,
    },
  };
}
/** @param {any} operation */ async function pushRaw(operation) {
  const r = await signedPost(h, seller, "/api/sync/push", {
    version: 2,
    app: "van-android",
    deviceId: seller.deviceId,
    scopeId: unit,
    operations: [operation],
  });
  expect(r.res.status).toBe(200);
  return r.body.results[0];
}
/** Ring a cash sale of 1 of each named product. @param {string[]} codes @param {string} total @param {any} [extra] */
async function ring(codes, total, extra = {}) {
  const [a] =
    await h.db`select next_issue from fiscal_allocations where id=${allocation}`;
  const serial = String(a.next_issue),
    id = crypto.randomUUID();
  const operation = op("store.sale", {
    saleId: id,
    receiptNumber: `${prefix}-${serial.padStart(9, "0")}`,
    lines: codes.map((c) => ({
      productId: products[c],
      uom: "PC",
      quantity: 1,
    })),
    totalCentavos: total,
    fiscal: { allocationId: allocation, serial },
    tenders: [
      { method: "cash", amountCentavos: total, tenderedCentavos: "50000" },
    ],
    ...extra,
  });
  const result = await pushRaw(operation);
  return { id, result };
}
/** True when the statement is refused by the database. @param {() => any} run */
async function fails(run) {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}
const senior = {
  type: "senior",
  idNumber: "SC-2026-004411",
  holderName: "Juana Dela Cruz",
};
/** @param {string} code @param {string} name @param {number} price @param {"vatable"|"exempt"|"zero_rated"} treatment */
async function product(code, name, price, treatment) {
  const material = sampleMasters.find((m) => m.kind === "material");
  const condition = sampleMasters.find((m) => m.kind === "condition");
  await ingestMaster(
    h.db,
    sampleMaster("material", code, {
      ...material.data,
      code,
      name,
      tracking: "none",
      packs: [
        {
          uom: "PC",
          parentUom: null,
          numerator: 1,
          denominator: 1,
          barcode: String(9910000000000 + Object.keys(products).length),
        },
      ],
    }),
  );
  await ingestMaster(
    h.db,
    sampleMaster("condition", `${code}-PRICE`, {
      ...condition.data,
      productCode: code,
      unitPriceCentavos: price,
      taxCode: `SAMPLE-${treatment}`,
      taxBasisPoints: treatment === "vatable" ? 1200 : 0,
      taxTreatment: treatment,
      taxInclusive: true,
    }),
  );
  const id = (await h.db`select id from products where code=${code}`)[0].id;
  products[code] = id;
  await tx(h.db, (db) =>
    postMovement(db, {
      kind: "opening_balance",
      sourceType: "cutover",
      sourceId: crypto.randomUUID(),
      idempotencyKey: `cap-opening-${code}`,
      occurredAt: Date.now(),
      organizationId: "sunpride",
      actor: { profileId: seller.profile.id, userId: seller.userId },
      lines: [
        {
          productId: id,
          quantityBase: 50,
          fromLocationId: null,
          toLocationId: location,
          uom: "PC",
          unitCostMinor: 1000,
        },
      ],
    }),
  );
}
beforeAll(async () => {
  h = await startHarness({ installers: [installStore, installFiscal, installDecide] });
  people = profileStore(h);
  h.setHooks({ unitInScope: async () => true });
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SUNPRIDE','SAMPLE Cebu','national','active',now()-interval '1 day')`;
  await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values('cap-test','org_units',${unit},'unit')`;
  seller = await boundDevice(h, people, {
    app: "van-android",
    orgUnitId: unit,
  });
  await persist(seller);
  const userId = await createUser(
    h,
    "cap-boss@example.com",
    "fixture password only",
  );
  boss = {
    userId,
    email: "cap-boss@example.com",
    profile: people.set(userId, {
      role: "super_admin",
      orgUnitId: unit,
      name: "Sample supervisor",
    }),
  };
  await persist(boss);
  const actor = await actorFor(h.db, seller.userId);
  const supervisor = await actorFor(h.db, userId);
  const login = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: boss.email,
      password: "fixture password only",
    }),
  });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  await ingestMaster(
    h.db,
    sampleMasters.find((m) => m.kind === "customer"),
  );
  const customer = (
    await h.db`select id from customers where code='MOCK-C1'`
  )[0].id;
  await h.db`insert into outlets(id,organization_id,code,name,status,custodian_org_unit_id,channel,address,created_by) values(${outlet},'sunpride','STORE','Sample store','active',${unit},'gt','12 Colon St, Cebu',${seller.userId})`;
  await h.db`insert into outlet_customer_links(outlet_id,customer_id,source,effective_from,actor_subject,reason) values(${outlet},${customer},'sample',now()-interval '1 day','fixture','fixture')`;
  await h.db`insert into inventory_locations(id,organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values(${location},'sunpride',${unit},'CEBU','STORE','STORE','store',true,true,true,true,false)`;
  register = (
    await web("registers/save", {
      locationId: location,
      terminalCode: "SAMPLE-01",
      name: "Sample terminal",
    })
  ).id;
  await web("registers/link", { outletId: outlet });
  policy = (
    await web("policies/save", {
      toleranceCentavos: "100",
      loyaltyEnabled: false,
      earnPerCentavos: "1000",
      pointValueCentavos: "100",
      pin: "482913",
    })
  ).id;
  await web("cashiers/save", { profileId: seller.profile.id, enabled: true });
  mode = (
    await web("mode/set", {
      deviceId: seller.deviceId,
      mode: "store",
      allowLocalSwitch: true,
    })
  ).id;
  for (const method of ["cash", "gcash", "card"])
    await h.db`insert into fiscal_tender_rules(org_unit_id,method,label,enabled,effective_from,sample,entered_by) values(${unit},${method},${method},true,now()-interval '1 day',true,${boss.profile.id})`;
  for (const [type, p] of [
    ["sales_invoice", "SAMPLE-SI"],
    ["credit_memo", "SAMPLE-CM"],
  ]) {
    const reg = await tx(h.db, (db) =>
      saveRegistration(db, supervisor, {
        orgUnitId: unit,
        entityName: "SAMPLE company",
        branchName: "SAMPLE Cebu",
        tin: "000-111-222-000",
        address: "1 Sample Road, Cebu",
        documentType: type,
        status: "sample_not_filed",
        effectiveFrom: "2026-01-01T00:00:00Z",
      }),
    );
    const series = await tx(h.db, (db) =>
      createSeries(db, supervisor, {
        registrationId: reg.id,
        prefix: p,
        firstSerial: "1",
        lastSerial: "500",
        effectiveFrom: "2026-01-01T00:00:00Z",
      }),
    );
    if (type === "sales_invoice") {
      siRegistration = reg.id;
      const a = await tx(h.db, (db) =>
        allocateDocumentNumber(db, {
          actor,
          deviceId: seller.deviceId,
          seriesId: series.id,
          requestKey: crypto.randomUUID(),
          count: 60,
        }),
      );
      allocation = a.allocationId;
      prefix = p;
    }
  }
  await product("VAT39", "Frozen nuggets 39", 3900, "vatable");
  await product("EXM112", "Exempt item 112", 11200, "exempt");
  await product("ZRO50", "Zero-rated item 50", 5000, "zero_rated");
  await product("BIG1000", "Case of frozen chicken 1000", 100000, "vatable");
  shift = crypto.randomUUID();
  const opened = await pushRaw(
    op("store.shift.open", {
      shiftId: shift,
      policyId: policy,
      openingCentavos: "10000",
    }),
  );
  expect(opened.status).toBe("applied");
}, 60000);
afterAll(async () => h?.close());

/** Test helpers for this file. */
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const BIG_PRICE = 100000;
/** BIG1000 is PHP 1,000 VATable: uncapped senior = PHP 714.29 to pay (discount 178.57, VAT removed 107.14). */
const FULL = { total: "71429", discount: "17857", removed: "10714" };
/** @param {string} id @param {any} [extra] */
const claim = (id, extra = {}) => ({
  type: "senior",
  idNumber: id,
  holderName: "Cap Tester",
  ...extra,
});
/** @param {boolean} enabled @param {number} centavos @param {any} [more] */
async function setCap(enabled, centavos, more = {}) {
  const r = await api("/api/v1/fiscal/privilege/cap", {
    enabled,
    capCentavos: centavos,
    ...more,
  });
  expect(r.status).toBe(200);
  await sleep(20);
}
/** @param {string} id */
const ledgerFor = (id) =>
  h.db`select * from privilege_cap_ledger where id_key=${idKey("senior", id)} order by created_at`;
/** Ring one BIG1000 with a senior claim. @param {string} id @param {{total:string,discount:string,removed:string}} t @param {any} [capBasis] */
async function ringBig(id, t, capBasis = undefined, type = "senior") {
  return ring(["BIG1000"], t.total, {
    tenders: [
      {
        method: "cash",
        amountCentavos: t.total,
        tenderedCentavos: t.total,
      },
    ],
    discountClaim: {
      ...claim(id, { type }),
      privilegeDiscountCentavos: t.discount,
      vatRemovedCentavos: t.removed,
      ...(capBasis === undefined ? {} : { capBasis }),
    },
  });
}
const bigLine = {
  productId: "",
  description: "Case of frozen chicken",
  grossCentavos: BIG_PRICE,
  taxTreatment: "vatable",
  taxBasisPoints: 1200,
};
/** @param {string} id @param {any} [more] */
const preview = (id, more = {}) =>
  api("/api/v1/fiscal/discount-claims/preview", {
    surface: "store",
    orgUnitId: unit,
    discountClaim: claim(id),
    lines: [{ ...bigLine, productId: products.BIG1000 }],
    ...more,
  });

test("shared vectors: the reference allocation reproduces every number the Kotlin mirror is held to, with hand-checked anchors", () => {
  const taken = (/** @type {any} */ v) =>
    new Map(v.lines.map((/** @type {any} */ l) => [l.productId, l.eligible]));
  for (const v of vectors.vectors) {
    const t = taken(v);
    const lines = v.lines.map((/** @type {any} */ l) => ({
      productId: l.productId,
      grossCentavos: l.gross,
      promoDiscountCentavos: l.promo,
      taxTreatment: l.treatment,
      taxBasisPoints: l.vatBps,
    }));
    const zero = (/** @type {any} */ l) => ({
      grossCentavos: 0,
      vatableCentavos: 0,
      vatCentavos: 0,
      vatExemptCentavos: 0,
      zeroRatedCentavos: 0,
      privilegeDiscountCentavos: 0,
      promoDiscountCentavos: l.promoDiscountCentavos,
      netCentavos: 0,
      vatRemovedCentavos: 0,
      privilegeType: null,
    });
    const r = computeWithBudget(
      lines,
      (l, g, p, w) =>
        l.grossCentavos === 0 ? zero(l) : computeOne(l, g, p, w ? v.type : null),
      (l) => t.get(l.productId),
      v.budget,
    );
    const sum = (/** @type {string} */ k) =>
      r.results.reduce((a, x) => a + x[k], 0);
    expect(
      {
        appliedGross: r.appliedGross,
        eligibleGross: r.eligibleGross,
        total: sum("netCentavos"),
        privilegeDiscount: sum("privilegeDiscountCentavos"),
        vatRemoved: sum("vatRemovedCentavos"),
      },
      v.name,
    ).toEqual({
      appliedGross: v.expect.appliedGross,
      eligibleGross: v.expect.eligibleGross,
      total: v.expect.total,
      privilegeDiscount: v.expect.privilegeDiscount,
      vatRemoved: v.expect.vatRemoved,
    });
    expect(
      r.results.map((/** @type {any} */ x) => x.netCentavos),
      v.name,
    ).toEqual(v.expect.lines.map((/** @type {any} */ x) => x.net));
    // every cut keeps the BIR identity: buckets = amount paid + privilege discount
    for (const x of r.results)
      expect(
        x.vatableCentavos + x.vatCentavos + x.vatExemptCentavos + x.zeroRatedCentavos,
        v.name,
      ).toBe(x.netCentavos + x.privilegeDiscountCentavos);
  }
  const by = (/** @type {string} */ n) =>
    vectors.vectors.find((/** @type {any} */ v) => v.name.startsWith(n)).expect;
  // PHP 1,000 VATable, senior: full = 714.29; with only PHP 500 of room 857.14; with PHP 300 of room 914.29; with none 1,000.
  expect(by("no limit on the phone").total).toBe(71429);
  expect(by("half the purchase fits").total).toBe(85714);
  expect(by("only 30,000 left").total).toBe(91429);
  expect(by("nothing left").total).toBe(100000);
});

test("week = Monday to Sunday in Manila time; the ID key ignores spacing, dashes and case; the phone only ever gets a hash", () => {
  // Sunday 8 Nov 2026 23:59:59 Manila is still the week of Monday 2 Nov; Monday 9 Nov 00:00 starts the next one.
  expect(manilaWeekStart(Date.parse("2026-11-08T23:59:59+08:00"))).toBe("2026-11-02");
  expect(manilaWeekStart(Date.parse("2026-11-09T00:00:00+08:00"))).toBe("2026-11-09");
  expect(manilaWeekStart(Date.parse("2026-11-02T00:00:00+08:00"))).toBe("2026-11-02");
  expect(manilaWeekStart(Date.parse("2026-11-01T23:59:59+08:00"))).toBe("2026-10-26");
  // 4:00 pm UTC Sunday is already Monday in Manila
  expect(manilaWeekStart(Date.parse("2026-11-08T16:00:00Z"))).toBe("2026-11-09");
  expect(new Date(manilaWeekEndsAt(Date.parse("2026-11-07T10:00:00Z"))).toISOString()).toBe("2026-11-08T16:00:00.000Z");
  expect(idKey("senior", "SC-2026-004411")).toBe("senior:SC2026004411");
  expect(idKey("senior", "sc 2026/004411.")).toBe("senior:SC2026004411");
  expect(idKey("pwd", "SC-2026-004411")).not.toBe(idKey("senior", "SC-2026-004411"));
  expect(idHash(idKey("senior", "sc 2026 004411"))).toBe(idHash(idKey("senior", "SC-2026-004411")));
  expect(idHash("senior:X")).toMatch(/^[0-9a-f]{32}$/);
  expect(weeklyLimitText(130000)).toBe("Weekly limit: ₱1,300.00 left");
  expect(weeklyLimitText(0)).toBe("Weekly limit: ₱0.00 left");
});

/** @type {any} */ let cookieSales = "";
test("the limit is an office setting: shipped default is marked for the accountant, only the office can change it, every change is kept", async () => {
  const first = await api("/api/v1/fiscal/privilege/cap");
  expect(first.status).toBe(200);
  expect(first.body.setting).toMatchObject({
    enabled: true,
    capCentavos: DEFAULT_WEEKLY_CAP_CENTAVOS,
    isDefault: true,
    accountantConfirmed: false,
    note: "Default — confirm with Sunpride accountant",
  });
  expect(DEFAULT_WEEKLY_CAP_CENTAVOS).toBe(250000);
  expect(first.body.week.note).toBe("Monday to Sunday, Manila time");
  expect(first.body.appliesTo).toEqual(["senior", "pwd"]);
  expect(first.body.canManage).toBe(true);
  // a salesperson cannot change it
  const salesId = await createUser(h, "cap-sales@example.com", "fixture password only");
  const salesProfile = people.set(salesId, { role: "sales", orgUnitId: unit, name: "Sample seller 2" });
  await persist({ userId: salesId, email: "cap-sales@example.com", profile: salesProfile });
  const login = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "cap-sales@example.com", password: "fixture password only" }),
  });
  cookieSales = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const denied = await h.fetch("/api/v1/fiscal/privilege/cap", {
    method: "POST",
    headers: { cookie: cookieSales, "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, capCentavos: 130000 }),
  });
  expect(denied.status).toBe(403);
  // bad amounts are refused in plain words
  for (const bad of [0, -5, 1.5, "abc", 200000000]) {
    const r = await api("/api/v1/fiscal/privilege/cap", { enabled: true, capCentavos: bad });
    expect(r.status).toBe(422);
  }
  expect((await api("/api/v1/fiscal/privilege/cap", { capCentavos: 130000 })).status).toBe(422);
  // the office can set it (pesos or centavos); the change is a new row
  const set = await api("/api/v1/fiscal/privilege/cap", { enabled: true, capPesos: 1300, note: "Per Sunpride accountant", accountantConfirmed: true });
  expect(set.status).toBe(200);
  await sleep(20);
  const now = await api("/api/v1/fiscal/privilege/cap");
  expect(now.body.setting).toMatchObject({ capCentavos: 130000, isDefault: false, accountantConfirmed: true, note: "Per Sunpride accountant" });
  expect(now.body.history).toHaveLength(1);
  expect(await fails(() => h.db`update privilege_cap_settings set cap_centavos=1`)).toBe(true);
  expect(await fails(() => h.db`delete from privilege_cap_settings`)).toBe(true);
  await setCap(true, 130000, { accountantConfirmed: false, note: null });
  expect((await capSetting(h.db, Date.now())).accountantConfirmed).toBe(false);
});

test("store sale from a phone that knows the limit: discount, ledger row, 'Weekly limit: left' on the receipt and the print model", async () => {
  const { id, result } = await ringBig("SC-CAP-0001", FULL, { budgetCentavos: "130000" });
  expect(result.status).toBe("applied");
  const [sale] = await h.db`select * from store_sales where id=${id}`;
  expect(sale.receipt.totalMinor).toBe(FULL.total);
  expect(sale.receipt.discountClaim.weeklyLimit).toMatchObject({
    capMinor: "130000",
    usedMinor: "100000",
    leftMinor: "30000",
    limited: false,
    text: "Weekly limit: ₱300.00 left",
  });
  const rows = await ledgerFor("SC-CAP-0001");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    privilege_type: "senior",
    applied_gross_centavos: "100000",
    eligible_gross_centavos: "100000",
    discount_centavos: "17857",
    cap_centavos: "130000",
    used_before_centavos: "0",
    overage_centavos: "0",
    short_centavos: "0",
    claim_basis: "phone_cap",
  });
  expect(rows[0].week_start.toISOString?.().slice(0, 10) ?? String(rows[0].week_start)).toBe(manilaWeekStart(Date.now()));
  const model = await api(`/api/v1/fiscal/receipts/${id}/print-model`);
  expect(model.body.model.privilege).toMatchObject({
    type: "senior",
    weeklyLimitLeftMinor: "30000",
    weeklyLimitText: "Weekly limit: ₱300.00 left",
  });
  // append-only
  expect(await fails(() => h.db`update privilege_cap_ledger set applied_gross_centavos=0`)).toBe(true);
  expect(await fails(() => h.db`delete from privilege_cap_ledger`)).toBe(true);
});

test("server is the authority online: the preview gives the discount only to the part that fits in what is left", async () => {
  const p = await preview("SC-CAP-0001");
  expect(p.status).toBe(200);
  expect(p.body.cap).toMatchObject({
    enabled: true,
    capCentavos: 130000,
    usedBeforeCentavos: 100000,
    remainingBeforeCentavos: 30000,
    eligibleGrossCentavos: 100000,
    appliedGrossCentavos: 30000,
    leftCentavos: 0,
    limited: true,
    message: "Weekly limit: ₱0.00 left",
    claimBasis: "server",
  });
  // PHP 300 of the PHP 1,000 case gets the discount: 914.29 to pay
  expect(p.body.totals).toMatchObject({ total: 91429, privilegeDiscount: 5357, vatRemoved: 3214, applied: true });
  // a different card is not affected; spacing and case in the number do not make it a different card
  const other = await preview("SC-CAP-9999");
  expect(other.body.totals.total).toBe(71429);
  expect(other.body.cap.leftCentavos).toBe(30000);
  const spaced = await preview("sc cap 0001");
  expect(spaced.body.cap.usedBeforeCentavos).toBe(100000);
  // the web lookup says the same in plain words
  const look = await api("/api/v1/fiscal/privilege/cap?type=senior&idNumber=SC-CAP-0001");
  expect(look.body.card).toMatchObject({ usedCentavos: 100000, leftCentavos: 30000, message: "Weekly limit: ₱300.00 left" });
  // a preview never writes
  expect((await ledgerFor("SC-CAP-0001")).length).toBe(1);
});

test("an offline phone that could not see the limit: the sale is accepted as made, the overage is recorded and lands in the Decide inbox", async () => {
  // an older build knows no limit and discounts the whole case; another card (SC-CAP-0002) is brand new
  await ringBig("SC-CAP-0002", FULL, { budgetCentavos: "130000" });
  const oldPhone = await ringBig("SC-CAP-0001", FULL); // 100,000 already used + 100,000 = 70,000 over the 130,000 limit
  expect(oldPhone.result.status).toBe("applied");
  const rows = await ledgerFor("SC-CAP-0001");
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({
    applied_gross_centavos: "100000",
    used_before_centavos: "100000",
    overage_centavos: "70000",
    short_centavos: "0",
    claim_basis: "phone_uncapped",
  });
  const [sale] = await h.db`select receipt from store_sales where id=${oldPhone.id}`;
  expect(sale.receipt.discountClaim.weeklyLimit).toMatchObject({ leftMinor: "0", usedMinor: "200000" });
  const inbox = await api("/api/v1/decide/inbox");
  expect(inbox.status).toBe(200);
  expect(inbox.body.kinds.privilege_cap).toBe("Senior / PWD weekly limit");
  const items = inbox.body.items.filter((/** @type {any} */ i) => i.kind === "privilege_cap");
  expect(items).toHaveLength(1);
  expect(items[0].title).toContain("went over the weekly limit");
  expect(items[0].canDecide).toBe(true);
  expect(items[0].lines.map((/** @type {any} */ l) => l.label)).toEqual(["ID", "Used before this sale", "Discounted in this sale", "Past the limit", "Phone"]);
  const act = await api("/api/v1/decide/act", { id: items[0].id, verdict: "approve", reason: "Customer keeps it", idempotencyKey: crypto.randomUUID() });
  expect(act.status).toBe(200);
  const after = await api("/api/v1/decide/inbox");
  expect(after.body.items.filter((/** @type {any} */ i) => i.kind === "privilege_cap")).toHaveLength(0);
  expect((await h.db`select verdict,kind from decide_log where kind='privilege_cap'`)[0]).toMatchObject({ verdict: "approved" });
  // the sale itself was never touched
  expect((await h.db`select status from orders where id=${oldPhone.id}`)[0].status).toBe("fulfilled");
});

test("a new phone that follows the limit is accepted exactly; a phone whose numbers do not fit its own limit is refused", async () => {
  // SC-CAP-0001 is used up (200,000 against 130,000): the phone's best-known remaining is 0, so the case sells at full price
  const plain = await ring(["BIG1000"], "100000", {
    tenders: [{ method: "cash", amountCentavos: "100000", tenderedCentavos: "100000" }],
    discountClaim: { ...claim("SC-CAP-0001"), privilegeDiscountCentavos: "0", vatRemovedCentavos: "0", capBasis: { budgetCentavos: "0" } },
  });
  expect(plain.result.status).toBe("applied");
  const [row] = await h.db`select applied,total_centavos from sale_discount_claims where source_id=${plain.id}`;
  expect(row).toMatchObject({ applied: false, total_centavos: "100000" });
  expect(await ledgerFor("SC-CAP-0001")).toHaveLength(2); // nothing discounted, nothing used
  // a phone that says "budget 30,000" but prints the uncapped total does not add up
  const wrong = await ringBig("SC-CAP-0003", FULL, { budgetCentavos: "30000" });
  expect(wrong.result.status).toBe("rejected");
  expect(wrong.result.code).toBe("stock_conflict");
  expect((await ledgerFor("SC-CAP-0003")).length).toBe(0);
  // right numbers for a 30,000 budget: accepted; the card had the whole 130,000 left, so 70,000 was held back
  const held = await ringBig("SC-CAP-0003", { total: "91429", discount: "5357", removed: "3214" }, { budgetCentavos: "30000" });
  expect(held.result.status).toBe("applied");
  const [l] = await ledgerFor("SC-CAP-0003");
  expect(l).toMatchObject({ applied_gross_centavos: "30000", eligible_gross_centavos: "100000", overage_centavos: "0", short_centavos: "70000", claim_basis: "phone_cap" });
  const inbox = await api("/api/v1/decide/inbox");
  const short = inbox.body.items.find((/** @type {any} */ i) => i.kind === "privilege_cap");
  expect(short.title).toContain("got less discount than the weekly limit allows");
  // unreadable limit details are refused in plain words, nothing saved
  const bad = await ringBig("SC-CAP-0004", FULL, { budgetCentavos: "-5" });
  expect(bad.result.status).toBe("rejected");
  expect(bad.result.code).toBe("invalid_request");
  const bad2 = await ringBig("SC-CAP-0004", FULL, "lots");
  expect(bad2.result.code).toBe("invalid_request");
});

test("a void gives the used amount back; a switched-off limit gives the full discount and still keeps the ledger", async () => {
  const [first] = await ledgerFor("SC-CAP-0001");
  expect((await preview("SC-CAP-0001")).body.cap.remainingBeforeCentavos).toBe(0);
  await h.db`insert into fiscal_document_events(document_id,kind,request_key,reason,actor_profile_id,facts) values(${first.fiscal_document_id},'void',${crypto.randomUUID()},'Wrong customer',${boss.profile.id},'{}')`;
  // 100,000 is still used by the second sale; the first one's 100,000 is back
  const after = await preview("SC-CAP-0001");
  expect(after.body.cap.usedBeforeCentavos).toBe(100000);
  expect(after.body.cap.remainingBeforeCentavos).toBe(30000);
  await setCap(false, 130000);
  const off = await preview("SC-CAP-0001");
  expect(off.body.cap).toMatchObject({ enabled: false, leftCentavos: null, message: null, limited: false });
  expect(off.body.totals.total).toBe(71429);
  const done = await ringBig("SC-CAP-0005", FULL);
  expect(done.result.status).toBe("applied");
  const [l] = await ledgerFor("SC-CAP-0005");
  expect(l).toMatchObject({ cap_centavos: null, overage_centavos: "0" });
  const [sale] = await h.db`select receipt from store_sales where id=${done.id}`;
  expect(sale.receipt.discountClaim.weeklyLimit).toBeUndefined();
  await setCap(true, 130000);
});

test("only the 5% basic-necessities discount has a weekly limit: solo parent, athlete and uniformed claims use none, and PWD shares the same rule", async () => {
  const solo = await ringBig("SC-CAP-SOLO", { total: "80357", discount: "8929", removed: "10714" }, undefined, "solo_parent");
  expect(solo.result.status).toBe("applied");
  expect(await h.db`select 1 from privilege_cap_ledger where id_key like 'solo_parent:%'`).toHaveLength(0);
  const pwdPreview = await preview("PWD-CAP-1", { discountClaim: claim("PWD-CAP-1", { type: "pwd" }) });
  expect(pwdPreview.body.cap).toMatchObject({ capCentavos: 130000, leftCentavos: 30000 });
  const soloPreview = await preview("SC-CAP-SOLO", { discountClaim: claim("SC-CAP-SOLO", { type: "solo_parent" }) });
  expect(soloPreview.body.cap).toBeNull();
});

test("the phone's bundle carries the limit and this week's use per card, hashed, and only for a phone that asks", async () => {
  const bundle = await capBundle(h.db, Date.now());
  expect(bundle).toMatchObject({ version: 1, enabled: true, capCentavos: "130000", confirmed: false, weekStart: manilaWeekStart(Date.now()), complete: true });
  expect(bundle.weekEndsAt).toBe(manilaWeekEndsAt(Date.now()));
  const used = Object.fromEntries(bundle.used.map((/** @type {any} */ u) => [u.k, u.v]));
  // SC-CAP-0001: first sale voided, second sale 100,000 counts
  expect(used[idHash(idKey("senior", "SC-CAP-0001"))]).toBe("100000");
  expect(used[idHash(idKey("senior", "SC-CAP-0003"))]).toBe("30000");
  expect(JSON.stringify(bundle)).not.toContain("CAP-0001");
  const proj = vanProjection({});
  const base = { serviceDate: new Date().toISOString().slice(0, 10) };
  expect(proj.params?.({ ...base, privilegeCap: true })).toMatchObject({ privilegeCap: true });
  expect(proj.params?.({ ...base })).not.toHaveProperty("privilegeCap");
  expect(proj.params?.({ ...base, handheld: true, vanDay: true })).not.toHaveProperty("privilegeCap");
});


test("the store bundle carries `privilegeCap` inside storePos only for a handheld that asks; older asks see the same bundle as before", async () => {
  const { bundle } = await import("../src/domains/van/projection.js");
  const actor = await actorFor(h.db, seller.userId);
  const ctx = (/** @type {any} */ extra) => ({
    db: h.db,
    actor,
    device: { id: seller.deviceId },
    params: { serviceDate: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), posMode: true, ...extra },
    now: Date.now(),
  });
  const plain = await bundle(ctx({ handheld: true, vanDay: true }), {});
  expect(plain.policy.storePos.privilegeCap).toBeUndefined();
  expect(plain.policy.privilegeCap).toBeUndefined();
  expect(Object.keys(plain.policy.storePos)).not.toContain("privilegeCap");
  const asked = await bundle(ctx({ handheld: true, vanDay: true, privilegeCap: true }), {});
  expect(asked.policy.storePos.privilegeCap).toMatchObject({ version: 1, enabled: true, capCentavos: "130000", weekStart: manilaWeekStart(Date.now()) });
  expect(asked.policy.storePos.privilegeCap.used.length).toBeGreaterThan(0);
  // nothing else in the bundle changed for the phone that asked
  const { privilegeCap: _p, ...rest } = asked.policy.storePos;
  expect(Object.keys(rest).sort()).toEqual(Object.keys(plain.policy.storePos).sort());
  expect(Object.keys(asked.policy).sort()).toEqual(Object.keys(plain.policy).sort());
});

test("a sale with no claim, or a claim on a phone from before this change, is unchanged on the wire", async () => {
  const plain = await ring(["VAT39"], "3900");
  expect(plain.result.status).toBe("applied");
  const old = await ring(["VAT39"], "2786", { discountClaim: { ...senior, idNumber: "SC-CAP-OLD" } });
  expect(old.result.status).toBe("applied");
  const [row] = await ledgerFor("SC-CAP-OLD");
  expect(row).toMatchObject({ claim_basis: "phone_uncapped", overage_centavos: "0", applied_gross_centavos: "3900" });
});

test("the Kotlin copy of the shared vectors is byte-identical, and the strict v1 wire fixture still lists storePos as stripped (privilegeCap rides inside it)", async () => {
  const a = await Bun.file(new URL("./fixtures/privilege-cap-vectors.json", import.meta.url)).text();
  const b = await Bun.file(new URL("../../van-sales-android/app/src/test/resources/privilege-cap-vectors.json", import.meta.url)).text();
  expect(b).toBe(a);
  const v1 = await Bun.file(new URL("./fixtures/van-wire-v1-policy-keys.json", import.meta.url)).json();
  expect(v1.strippedBeforeValidation).toContain("storePos");
  expect(v1.validatedKeys).not.toContain("privilegeCap");
  expect(v1.strippedBeforeValidation).not.toContain("privilegeCap"); // never a policy key, so no v1 validator has to learn it
});

/** The legacy Z gate. */
/** @param {string|null} code */
async function reportBuild(code) {
  // any signed push carries the header; store.customer is the lightest op that is allowed on a closed session too
  const operation = op("store.customer", { phone: "09171234567", name: "Cap Customer" });
  const r = await signedPost(
    h,
    seller,
    "/api/sync/push",
    { version: 2, app: "van-android", deviceId: seller.deviceId, scopeId: unit, operations: [operation] },
    code === null ? {} : { headers: { "x-app-version-code": code, "x-app-version-name": `1.0.0-beta.${code}` } },
  );
  expect(r.res.status).toBe(200);
  expect(["applied", "duplicate"]).toContain(r.body.results[0].status);
}
/** @param {string} mode @param {number} min */
async function setGate(mode, min = 30) {
  const r = await api("/api/v1/storepos/legacy-z/gate", { requestKey: crypto.randomUUID(), mode, minVersionCode: min });
  expect(r.status).toBe(200);
  await sleep(20);
}
/** @param {() => Promise<any>} run */
async function refusal(run) {
  try {
    await run();
    return null;
  } catch (e) {
    return /** @type {any} */ (e);
  }
}

test("legacy Z gate: a phone that never reported a build still gets the old no-PIN Z; the build header is recorded; the report says who is left", async () => {
  // beta.26-31 never send a build, so nothing is known and nothing breaks
  expect(await refusal(() => assertLegacyZAllowed(h.db, { id: seller.deviceId }))).toBeNull();
  await reportBuild(null);
  expect((await h.db`select app_version_code from registered_devices where id=${seller.deviceId}`)[0].app_version_code).toBeNull();
  // a junk header is ignored; a real one is recorded
  const junk = await signedPost(h, seller, "/api/sync/push", { version: 2, app: "van-android", deviceId: seller.deviceId, scopeId: unit, operations: [op("store.customer", { phone: "09171234567", name: "Cap Customer" })] }, { headers: { "x-app-version-code": "abc" } });
  expect(junk.res.status).toBe(200);
  expect((await h.db`select app_version_code from registered_devices where id=${seller.deviceId}`)[0].app_version_code).toBeNull();
  await reportBuild("29");
  const [d] = await h.db`select app_version_code,app_version_name,app_version_seen_at from registered_devices where id=${seller.deviceId}`;
  expect(d.app_version_code).toBe(29);
  expect(d.app_version_name).toBe("1.0.0-beta.29");
  expect(d.app_version_seen_at).not.toBeNull();
  // beta.29 is below the gate: still allowed
  expect(await refusal(() => assertLegacyZAllowed(h.db, { id: seller.deviceId }))).toBeNull();
  const rep = await api("/api/v1/storepos/legacy-z");
  expect(rep.status).toBe(200);
  expect(rep.body.gate).toMatchObject({ mode: "older_builds_only", minVersionCode: 30, isDefault: true });
  const row = rep.body.devices.find((/** @type {any} */ x) => x.deviceId === seller.deviceId);
  expect(row).toMatchObject({ state: "older", needsUpdate: true, buildCode: 29, register: "Sample terminal", stateWords: "Older build (beta.29)" });
  expect(rep.body.summary).toMatchObject({ needingUpdate: 1, safeToSwitchOff: false });
  expect(rep.body.summary.advice).toContain("still on an older or unreported build");
  expect(rep.body.canManage).toBe(true);
});

test("legacy Z gate: a phone on beta.30 or later is refused the no-PIN Z, end to end through the Z op; an older one still works", async () => {
  await reportBuild("31");
  const sent = await pushRaw(op("store.shift.close", { declaredCentavos: "250000" }));
  expect(sent.status).toBe("applied");
  const early = await pushRaw(op("store.read", { kind: "z" }));
  expect(early.status).toBe("rejected");
  expect(early.code).toBe("unsupported_operation");
  expect((await h.db`select count(*)::int as n from store_z_readings`)[0].n).toBe(0);
  const err = await refusal(() => tx(h.db, (db) => assertLegacyZAllowed(db, { id: seller.deviceId })));
  expect(err.code).toBe("unsupported_operation");
  expect(err.message).toContain("supervisor PIN");
  // the same phone proves it is PIN-capable even without reporting: a build that never reported but signed a Z with a PIN
  await reportBuild("29");
  await h.db`update registered_devices set app_version_code=null where id=${seller.deviceId}`;
  expect(await refusal(() => assertLegacyZAllowed(h.db, { id: seller.deviceId }))).toBeNull();
  await h.db`insert into store_overrides(id,register_id,till_day_id,shift_id,kind,method,supervisor_profile_id,cashier_profile_id,reason,ref_type,ref_id,captured_at)
    select gen_random_uuid(),register_id,till_day_id,id,'void_line','pin_offline',${boss.profile.id},cashier_id,'fixture','cash',gen_random_uuid()::text,now() from store_shifts where id=${shift}`;
  // a PIN on a void or a drop does not prove the build can sign a Z: still allowed
  expect(await refusal(() => assertLegacyZAllowed(h.db, { id: seller.deviceId }))).toBeNull();
  await h.db`insert into store_overrides(id,register_id,till_day_id,shift_id,kind,method,supervisor_profile_id,cashier_profile_id,reason,ref_type,ref_id,captured_at)
    select gen_random_uuid(),register_id,till_day_id,id,'z_reading','pin_offline',${boss.profile.id},cashier_id,'fixture','z_reading',gen_random_uuid()::text,now() from store_shifts where id=${shift}`;
  const proven = await refusal(() => assertLegacyZAllowed(h.db, { id: seller.deviceId }));
  expect(proven.code).toBe("unsupported_operation");
  const rep = await api("/api/v1/storepos/legacy-z");
  expect(rep.body.devices.find((/** @type {any} */ x) => x.deviceId === seller.deviceId).state).toBe("signs_with_pin");
});

test("legacy Z gate: the office can switch the old way off for every phone; the old way still works for an unreported phone until then; setting needs the office", async () => {
  // store_overrides is append-only, so the fixture PIN row stays: model an unreported phone with no PIN history on a second device
  const second = await boundDevice(h, people, { app: "van-android", orgUnitId: unit, profileId: undefined });
  expect(second.deviceId).toBeTruthy();
  expect(await refusal(() => assertLegacyZAllowed(h.db, { id: second.deviceId }))).toBeNull();
  await setGate("off");
  const off = await refusal(() => assertLegacyZAllowed(h.db, { id: second.deviceId }));
  expect(off.code).toBe("unsupported_operation");
  expect(off.message).toContain("every till");
  const rep = await api("/api/v1/storepos/legacy-z");
  expect(rep.body.gate).toMatchObject({ mode: "off", isDefault: false });
  await setGate("older_builds_only", 32);
  expect(await refusal(() => assertLegacyZAllowed(h.db, { id: second.deviceId }))).toBeNull();
  await h.db`update registered_devices set app_version_code=31 where id=${second.deviceId}`;
  expect(await refusal(() => assertLegacyZAllowed(h.db, { id: second.deviceId }))).toBeNull(); // 31 < 32
  await h.db`update registered_devices set app_version_code=32 where id=${second.deviceId}`;
  expect((await refusal(() => assertLegacyZAllowed(h.db, { id: second.deviceId }))).code).toBe("unsupported_operation");
  await setGate("older_builds_only", 30);
  const denied = await h.fetch("/api/v1/storepos/legacy-z/gate", {
    method: "POST",
    headers: { cookie: cookieSales, "content-type": "application/json" },
    body: JSON.stringify({ requestKey: crypto.randomUUID(), mode: "off", minVersionCode: 30 }),
  });
  expect(denied.status).toBe(403);
  const badMode = await api("/api/v1/storepos/legacy-z/gate", { requestKey: crypto.randomUUID(), mode: "maybe" });
  expect(badMode.status).toBeGreaterThanOrEqual(400);
  expect(badMode.status).toBeLessThan(500);
  expect(await fails(() => h.db`delete from legacy_z_gate_settings`)).toBe(true);
});
