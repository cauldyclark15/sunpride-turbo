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
      idempotencyKey: `bir-opening-${code}`,
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
  h = await startHarness({ installers: [installStore, installFiscal] });
  people = profileStore(h);
  h.setHooks({ unitInScope: async () => true });
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SUNPRIDE','SAMPLE Cebu','national','active',now()-interval '1 day')`;
  await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values('bir-test','org_units',${unit},'unit')`;
  seller = await boundDevice(h, people, {
    app: "van-android",
    orgUnitId: unit,
  });
  await persist(seller);
  const userId = await createUser(
    h,
    "bir-boss@example.com",
    "fixture password only",
  );
  boss = {
    userId,
    email: "bir-boss@example.com",
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

test("Itemcount case: PHP 39 VATable item to a senior pays PHP 27.86 (VAT 4.18 removed, discount 6.96)", async () => {
  const { id, result } = await ring(["VAT39"], "2786", {
    discountClaim: { ...senior },
  });
  expect(result.status).toBe("applied");
  const [sale] = await h.db`select * from store_sales where id=${id}`;
  expect(sale.receipt.totalMinor).toBe("2786");
  expect(sale.receipt.tax).toMatchObject({
    vatableSalesMinor: "0",
    vatMinor: "0",
    vatExemptMinor: "3482",
    zeroRatedMinor: "0",
    totalMinor: "2786",
    grossMinor: "3900",
    privilegeDiscountMinor: "696",
    vatRemovedMinor: "418",
    privilegeType: "senior",
  });
  expect(sale.receipt.discountClaim).toMatchObject({
    type: "senior",
    idNumber: "SC-2026-004411",
    holderName: "Juana Dela Cruz",
  });
  const [claim] =
    await h.db`select * from sale_discount_claims where source_id=${id}`;
  expect(claim).toMatchObject({
    source_type: "store_sale",
    privilege_type: "senior",
    id_number: "SC-2026-004411",
    holder_name: "Juana Dela Cruz",
    applied: true,
  });
  expect(String(claim.privilege_discount_centavos)).toBe("696");
  expect(String(claim.vat_removed_centavos)).toBe("418");
  expect(String(claim.total_centavos)).toBe("2786");
  // cash tender is the discounted amount; change from PHP 500 tendered
  const [tender] = await h.db`select * from store_tenders where sale_id=${id}`;
  expect(String(tender.amount_centavos)).toBe("2786");
  // typed per-document tax row for the Z reading
  const [t] =
    await h.db`select * from fiscal_document_tax where document_id=${sale.fiscal_document_id}`;
  expect(String(t.vat_exempt_centavos)).toBe("3482");
  expect(String(t.privilege_discount_centavos)).toBe("696");
  expect(String(t.vat_removed_centavos)).toBe("418");
  expect(String(t.total_due_centavos)).toBe("2786");
  expect(t.privilege_type).toBe("senior");
  // canonical order and stock see the paid amount
  const [order] = await h.db`select total_centavos from orders where id=${id}`;
  expect(String(order.total_centavos)).toBe("2786");
  const [stock] =
    await h.db`select available_base::text as n from inventory_balances where location_id=${location} and product_id=${products.VAT39}`;
  expect(stock.n).toBe("49");
  // the claim row is append-only evidence
  expect(
    await fails(
      () =>
        h.db`update sale_discount_claims set holder_name='X' where source_id=${id}`,
    ),
  ).toBe(true);
});

test("store sales without a claim are taxed per line, not at one basket rate", async () => {
  const { id, result } = await ring(["VAT39", "EXM112", "ZRO50"], "20100");
  expect(result.status).toBe("applied");
  const [sale] = await h.db`select * from store_sales where id=${id}`;
  expect(sale.receipt.tax).toMatchObject({
    vatableSalesMinor: "3482",
    vatMinor: "418",
    vatExemptMinor: "11200",
    zeroRatedMinor: "5000",
    totalMinor: "20100",
    privilegeDiscountMinor: "0",
  });
  expect(
    sale.receipt.tax.lines.map((/** @type {any} */ l) => l.treatment),
  ).toEqual(["vatable", "exempt", "zero_rated"]);
});

test("mixed cart: privilege applies only to the chosen items; exempt and zero-rated lines are handled by treatment", async () => {
  const { id, result } = await ring(["VAT39", "EXM112", "ZRO50"], "16746", {
    discountClaim: {
      type: "pwd",
      idNumber: "PWD-77-1200",
      holderName: "Mario Reyes",
      eligibleProductIds: [products.VAT39, products.EXM112],
    },
  });
  expect(result.status).toBe("applied");
  const [sale] = await h.db`select * from store_sales where id=${id}`;
  // VAT39 -> 27.86, EXM112 -> 112 less 20% = 89.60, ZRO50 stays 50.00
  expect(sale.receipt.tax).toMatchObject({
    vatableSalesMinor: "0",
    vatExemptMinor: "14682",
    zeroRatedMinor: "5000",
    privilegeDiscountMinor: "2936",
    vatRemovedMinor: "418",
    totalMinor: "16746",
  });
  // buckets before the privilege discount = amount paid + privilege discount
  expect(14682 + 5000).toBe(16746 + 2936);
  expect(
    sale.receipt.lines.map((/** @type {any} */ l) => l.lineTotalCentavos),
  ).toEqual([2786, 8960, 5000]);
  const [order] = await h.db`select total_centavos from orders where id=${id}`;
  expect(String(order.total_centavos)).toBe("16746");
});

test("a phone total that does not match the server recompute is refused, nothing is saved", async () => {
  const before = (await h.db`select count(*)::int as n from store_sales`)[0].n;
  const claimsBefore = (
    await h.db`select count(*)::int as n from sale_discount_claims`
  )[0].n;
  const { result } = await ring(["VAT39"], "3900", {
    discountClaim: { ...senior },
  });
  expect(result.status).toBe("rejected");
  // the wire code set is closed: a changed basket tells the phone to refresh (same as "Basket changed")
  expect(result.code).toBe("stock_conflict");
  // a phone that sends its own wrong discount amount is refused too
  const second = await ring(["VAT39"], "2786", {
    discountClaim: { ...senior, privilegeDiscountCentavos: "500" },
  });
  expect(second.result.code).toBe("stock_conflict");
  expect((await h.db`select count(*)::int as n from store_sales`)[0].n).toBe(
    before,
  );
  expect(
    (await h.db`select count(*)::int as n from sale_discount_claims`)[0].n,
  ).toBe(claimsBefore);
  // the message is in plain words and names both amounts
  const db = /** @type {any} */ (async () => []);
  const legal = await prepareLegalSale(db, {
    surface: "store",
    orgUnitId: unit,
    payload: { discountClaim: senior },
    at: Date.now(),
    lines: [
      {
        productId: products.VAT39,
        description: "Frozen nuggets 39",
        grossCentavos: 3900,
        promoDiscountCentavos: 0,
        taxTreatment: "vatable",
        taxBasisPoints: 1200,
      },
    ],
  });
  expect(legal.totals.total).toBe(2786);
  expect(() => legal.assertMatches({ totalCentavos: "3900" })).toThrow(
    /senior citizen discount does not match.*₱39\.00.*₱27\.86/i,
  );
});

test("claim validation messages are plain words", () => {
  expect(() =>
    normalizeClaim({ type: "senior", idNumber: "", holderName: "Juana" }),
  ).toThrow(/Enter the senior citizen ID number exactly as printed/);
  expect(() =>
    normalizeClaim({ type: "vip", idNumber: "SC-123456", holderName: "Juana" }),
  ).toThrow(/Choose the discount type/);
  expect(() =>
    normalizeClaim({ type: "pwd", idNumber: "PWD-1234", holderName: "" }),
  ).toThrow(/name of the person on the ID/);
  expect(normalizeClaim(undefined)).toBeNull();
});
test("bad claims are refused in plain words and the office can switch the discount off per till", async () => {
  const noId = await ring(["VAT39"], "2786", {
    discountClaim: { type: "senior", idNumber: "", holderName: "Juana" },
  });
  expect(noId.result.code).toBe("invalid_request");
  const noType = await ring(["VAT39"], "2786", {
    discountClaim: { type: "vip", idNumber: "SC-123456", holderName: "Juana" },
  });
  expect(noType.result.code).toBe("invalid_request");
  const off = await api("/api/v1/fiscal/privilege/settings", {
    orgUnitId: unit,
    surface: "store",
    enabled: false,
  });
  expect(off.status).toBe(200);
  const blocked = await ring(["VAT39"], "2786", {
    discountClaim: { ...senior },
  });
  expect(blocked.result.code).toBe("invalid_request");
  expect(
    await surfaceEnabled(h.db, {
      orgUnitId: unit,
      surface: "store",
      at: Date.now(),
    }),
  ).toBe(false);
  await new Promise((r) => setTimeout(r, 15));
  const on = await api("/api/v1/fiscal/privilege/settings", {
    orgUnitId: unit,
    surface: "store",
    enabled: true,
  });
  expect(on.status).toBe(200);
  await new Promise((r) => setTimeout(r, 15));
  const ok = await ring(["VAT39"], "2786", { discountClaim: { ...senior } });
  expect(ok.result.status).toBe("applied");
  const list = await api("/api/v1/fiscal/privilege/settings");
  expect(list.body.defaults).toEqual({ store: true, van: false });
});

let printedSale = "";
test("receipt print model carries every BIR field: sample banner, PTU/MIN/serial, range, buyer, VAT lines, SC/PWD, change", async () => {
  const ids = await api("/api/v1/fiscal/registrations/identifiers", {
    registrationId: siRegistration,
    ptuNumber: "FP012026-07-0099999",
    ptuIssuedOn: "2026-01-15",
    minNumber: "26011512345678901",
    machineSerial: "H10P758268A0123",
    accreditationNumber: "082-123456789-000123",
    accreditationDate: "2026-01-10",
    posProvider: {
      name: "Cauld & Clark Software",
      address: "Cebu City",
      tin: "009-888-777-000",
      accreditationNumber: "082-123456789-000123",
      accreditationDate: "2026-01-10",
    },
  });
  expect(ids.status).toBe(200);
  const saved = await api("/api/v1/fiscal/buyers/save", {
    outletId: outlet,
    registeredName: "Sample Store Trading Inc.",
    tin: "123-456-789-000",
    address: "12 Colon St, Cebu City",
  });
  expect(saved.status).toBe(200);
  const { id, result } = await ring(["VAT39", "ZRO50"], "7786", {
    discountClaim: {
      ...senior,
      eligibleProductIds: [products.VAT39],
    },
  });
  expect(result.status).toBe("applied");
  printedSale = id;
  const res = await api(`/api/v1/fiscal/receipts/${id}/print-model`);
  expect(res.status).toBe(200);
  const m = res.body.model;
  expect(m.title).toBe("SALES INVOICE");
  expect(m.documentNumber).toMatch(/^SAMPLE-SI-\d{9}$/);
  expect(m.banner).toBe("NOT FILED - SAMPLE");
  expect(m.notFiled).toBe(true);
  expect(m.seller).toMatchObject({
    entityName: "SAMPLE company",
    tin: "000-111-222-000",
    tinLabel: "VAT REG TIN",
    address: "1 Sample Road, Cebu",
  });
  expect(m.registration).toMatchObject({
    ptuNumber: "FP012026-07-0099999",
    ptuIssuedOn: "2026-01-15",
    minNumber: "26011512345678901",
    machineSerial: "H10P758268A0123",
    accreditationNumber: "082-123456789-000123",
  });
  expect(m.range).toMatchObject({
    firstNumber: "SAMPLE-SI-000000001",
    lastNumber: "SAMPLE-SI-000000500",
  });
  expect(m.buyer).toMatchObject({
    name: "Sample Store Trading Inc.",
    tin: "123-456-789-000",
    address: "12 Colon St, Cebu City",
    signatureLine: true,
  });
  expect(m.totals).toMatchObject({
    totalDueMinor: "7786",
    vatableSalesMinor: "0",
    vatMinor: "0",
    vatExemptSalesMinor: "3482",
    zeroRatedSalesMinor: "5000",
    privilegeDiscountMinor: "696",
    vatRemovedMinor: "418",
    tenderedMinor: "50000",
    changeMinor: "42214",
  });
  expect(m.discountLines.map((/** @type {any} */ l) => l.kind)).toEqual([
    "vat_removed",
    "privilege",
  ]);
  expect(m.privilege).toMatchObject({
    type: "senior",
    holderName: "Juana Dela Cruz",
    idNumber: "SC-2026-004411",
  });
  expect(m.lines.map((/** @type {any} */ l) => l.taxLetter)).toEqual([
    "V",
    "Z",
  ]);
  expect(m.footer.join(" ")).toContain("NOT FILED - SAMPLE");
  expect(m.footer.join(" ")).toContain("Cauld & Clark Software");
  expect(m.copy.label).toBe("ORIGINAL");
  expect(m.contentHash).toMatch(/^[0-9a-f]{64}$/);
  // an unknown receipt is a plain 4xx
  const missing = await api(
    `/api/v1/fiscal/receipts/${crypto.randomUUID()}/print-model`,
  );
  expect(missing.status).toBeGreaterThanOrEqual(400);
});

test("discount preview route returns the server's recompute for a basket, in centavos, for web and handheld", async () => {
  const lines = [
    {
      productId: products.VAT39,
      description: "Frozen nuggets 39",
      grossCentavos: 3900,
      promoDiscountCentavos: 0,
      taxTreatment: "vatable",
      taxBasisPoints: 1200,
    },
  ];
  const ok = await api("/api/v1/fiscal/discount-claims/preview", {
    surface: "store",
    orgUnitId: unit,
    discountClaim: senior,
    lines,
  });
  expect(ok.status).toBe(200);
  expect(ok.body.totals).toMatchObject({
    gross: 3900,
    total: 2786,
    privilegeDiscount: 696,
    vatRemoved: 418,
    applied: true,
  });
  expect(ok.body.label).toBe("Senior citizen");
  const bad = await api("/api/v1/fiscal/discount-claims/preview", {
    surface: "store",
    orgUnitId: unit,
    discountClaim: { ...senior, idNumber: "" },
    lines,
  });
  expect(bad.status).toBeGreaterThanOrEqual(400);
  expect(JSON.stringify(bad.body)).toContain("ID number");
});

test("a live (approved) registration with missing identifiers says what is missing; complete ones print no banner", () => {
  const doc = {
    id: crypto.randomUUID(),
    document_number: "LIVE-SI-000000007",
    issued_at: new Date("2026-11-06T02:00:00Z"),
    snapshot: {
      totalMinor: "11200",
      lines: [
        {
          description: "Exempt item",
          quantity: 1,
          uom: "PC",
          unitPriceCentavos: 11200,
          lineTotalCentavos: 11200,
          discountCentavos: 0,
          taxTreatment: "exempt",
        },
      ],
      tax: {
        vatableSalesMinor: "0",
        vatMinor: "0",
        vatExemptMinor: "11200",
        zeroRatedMinor: "0",
        totalMinor: "11200",
      },
      tenders: [
        {
          method: "cash",
          label: "Cash",
          amountCentavos: "11200",
          tenderedCentavos: "20000",
          changeCentavos: "8800",
        },
      ],
    },
  };
  const series = { prefix: "LIVE-SI", first_serial: "1", last_serial: "1000" };
  const base = {
    document_type: "sales_invoice",
    entity_name: "Sunpride",
    branch_name: "Cebu",
    address: "Cebu",
    tin: "123-456-789-000",
    tax_basis_points: 1200,
    sample: false,
    status: "approved",
  };
  const incomplete = buildPrintModel({ doc, series, registration: base });
  expect(incomplete.banner).toBeNull();
  expect(incomplete.compliance).toEqual({
    complete: false,
    missing: ["ptuNumber", "minNumber", "machineSerial", "accreditationNumber"],
  });
  const full = buildPrintModel({
    doc,
    series,
    registration: {
      ...base,
      ptu_number: "FP-1",
      min_number: "MIN-1",
      machine_serial: "SER-1",
      accreditation_number: "ACC-1",
    },
  });
  expect(full.compliance.complete).toBe(true);
  expect(full.totals.changeMinor).toBe("8800");
  expect(full.copy.label).toBe("ORIGINAL");
  const again = buildPrintModel({
    doc,
    series,
    registration: {
      ...base,
      ptu_number: "FP-1",
      min_number: "MIN-1",
      machine_serial: "SER-1",
      accreditation_number: "ACC-1",
    },
    copy: { kind: "reprint", number: 2 },
  });
  expect(again.copy.label).toBe("REPRINT - COPY 2");
  expect(again.contentHash).toBe(full.contentHash);
});

test("reprint and void land in the append-only, hash-chained e-journal with the print model hash", async () => {
  const first = await api(`/api/v1/fiscal/receipts/${printedSale}/print-model`);
  const original = first.body.model.contentHash;
  const r1 = await api(`/api/v1/fiscal/receipts/${printedSale}/reprint`, {
    reason: "Customer asked for a copy",
  });
  expect(r1.status).toBe(200);
  expect(r1.body.model.copy.label).toBe("REPRINT - COPY 1");
  expect(r1.body.model.contentHash).toBe(original);
  const r2 = await api(`/api/v1/fiscal/receipts/${printedSale}/reprint`, {
    reason: "Printer jammed",
  });
  expect(r2.body.model.copy.label).toBe("REPRINT - COPY 2");
  const noReason = await api(
    `/api/v1/fiscal/receipts/${printedSale}/reprint`,
    {},
  );
  expect(noReason.status).toBeGreaterThanOrEqual(400);
  const rows =
    await h.db`select * from fiscal_ejournal j join fiscal_documents d on d.id=j.document_id where d.source_id=${printedSale} order by j.seq`;
  expect(
    rows.map((/** @type {any} */ r) => [r.entry_kind, r.copy_number]),
  ).toEqual([
    ["reprinted", 1],
    ["reprinted", 2],
  ]);
  expect(
    rows.every(
      (/** @type {any} */ r) =>
        r.model_hash === original && r.hash_basis === "print_model",
    ),
  ).toBe(true);
  // another module voids the document: the trigger journals it, so no path can skip the e-journal
  const [doc] =
    await h.db`select id from fiscal_documents where source_id=${printedSale}`;
  await h.db`insert into fiscal_document_events(document_id,kind,request_key,reason,actor_profile_id,facts) values(${doc.id},'void',${crypto.randomUUID()},'Wrong customer',${boss.profile.id},'{}')`;
  const voided =
    await h.db`select * from fiscal_ejournal where document_id=${doc.id} and entry_kind='voided'`;
  expect(voided.length).toBe(1);
  expect(voided[0].hash_basis).toBe("document_snapshot");
  const list = await api(`/api/v1/fiscal/ejournal?documentId=${doc.id}`);
  expect(list.status).toBe(200);
  expect(list.body.entries.map((/** @type {any} */ e) => e.entry_kind)).toEqual(
    ["voided", "reprinted", "reprinted"],
  );
  expect(list.body.chainBroken).toEqual([]);
  // the model now says voided, and it can no longer be edited or deleted
  const after = await api(`/api/v1/fiscal/receipts/${printedSale}/print-model`);
  expect(after.body.model.status).toBe("voided");
  expect(after.body.model.contentHash).toBe(original);
  expect(
    await fails(
      () => h.db`delete from fiscal_ejournal where document_id=${doc.id}`,
    ),
  ).toBe(true);
  expect(
    await fails(
      () =>
        h.db`update fiscal_ejournal set reason='x' where document_id=${doc.id}`,
    ),
  ).toBe(true);
});

test("recent receipts list is searchable and any receipt opens by its printed number", async () => {
  const all = await api("/api/v1/fiscal/receipts");
  expect(all.status).toBe(200);
  expect(all.body.receipts.length).toBeGreaterThanOrEqual(5);
  const voided = all.body.receipts.find(
    (/** @type {any} */ r) => r.saleId === printedSale,
  );
  expect(voided).toMatchObject({
    voided: true,
    reprints: 2,
    privilegeType: "senior",
    totalDueMinor: "7786",
    buyerName: "Sample Store Trading Inc.",
  });
  const found = await api(
    `/api/v1/fiscal/receipts?q=${voided.documentNumber.slice(-6)}`,
  );
  expect(
    found.body.receipts.map((/** @type {any} */ r) => r.documentNumber),
  ).toContain(voided.documentNumber);
  const byNumber = await api(
    `/api/v1/fiscal/receipts/${voided.documentNumber}/print-model`,
  );
  expect(byNumber.status).toBe(200);
  expect(byNumber.body.model.documentNumber).toBe(voided.documentNumber);
  expect(byNumber.body.journal.length).toBe(3);
});

test("tax summary shows privilege discounts as their own lines and leaves voided documents out; SC/PWD book lists holders", async () => {
  const s = await api("/api/v1/fiscal/tax-summary");
  expect(s.status).toBe(200);
  // Four live sales (2786 + 20100 + 16746 + 2786); the voided 7786 invoice is excluded.
  expect(s.body.totals).toMatchObject({
    documents: 4,
    total_due: "42418",
    privilege_discount: "4328",
    vat_removed: "1254",
    zero_rated: "10000",
    vat_exempt: "32846",
    vatable: "3482",
    vat: "418",
  });
  const byType = Object.fromEntries(
    s.body.privilege.map((/** @type {any} */ r) => [r.type, r]),
  );
  expect(byType.senior).toMatchObject({
    documents: 2,
    discount: "1392",
    vat_removed: "836",
    label: "Senior citizen",
  });
  expect(byType.pwd).toMatchObject({
    documents: 1,
    discount: "2936",
    vat_removed: "418",
    label: "PWD",
  });
  expect(s.body.days.length).toBe(1);
  const book = await api("/api/v1/fiscal/privilege/claims?type=senior");
  expect(book.status).toBe(200);
  expect(book.body.claims.length).toBe(3);
  expect(book.body.claims[0]).toMatchObject({
    privilege_type: "senior",
    id_number: "SC-2026-004411",
    holder_name: "Juana Dela Cruz",
  });
  expect(book.body.claims[0].document_number).toMatch(/^SAMPLE-SI-/);
});

test("IP-INT2 ask 1: after senior/PWD sales the Z shows non-zero privilege lines that match the claims, with no double counting", async () => {
  const [sh] =
    await h.db`select till_day_id from store_shifts where id=${shift}`;
  const close = await pushRaw(
    op("store.shift.close", { declaredCentavos: "10000" }),
  );
  expect(close.status).toBe("applied");
  const z = await web(`days/${sh.till_day_id}/z`, {});
  const [row] =
    await h.db`select * from store_z_readings where till_day_id=${sh.till_day_id}`;
  /** @type {any[]} */ const sales =
    await h.db`select s.receipt from store_sales s join orders o on o.id=s.order_id where s.shift_id=${shift} and o.status<>'voided'`;
  const sum = (/** @type {(r:any)=>bigint} */ f) =>
    sales.reduce((/** @type {bigint} */ n, /** @type {any} */ s) => n + f(s.receipt), 0n);
  const claim = (/** @type {any} */ r, /** @type {string} */ t, k = "discountMinor") =>
    BigInt(r.privilege?.byType?.[t]?.[k] ?? 0);
  // the sale writes the shape the Z reads
  expect(sales.some((/** @type {any} */ s) => s.receipt.privilege?.byType?.senior)).toBe(true);
  expect(BigInt(row.senior_discount_centavos)).toBeGreaterThan(0n);
  expect(BigInt(row.pwd_discount_centavos)).toBeGreaterThan(0n);
  expect(BigInt(row.senior_discount_centavos)).toBe(sum((r) => claim(r, "senior")));
  expect(BigInt(row.pwd_discount_centavos)).toBe(sum((r) => claim(r, "pwd")));
  expect(BigInt(row.vat_removed_centavos)).toBe(
    sum((r) => claim(r, "senior", "vatRemovedMinor") + claim(r, "pwd", "vatRemovedMinor")),
  );
  // gross = what the customers were charged before any discount: no promo/privilege double count
  const gross = sum((r) =>
    r.lines.reduce(
      (/** @type {bigint} */ n, /** @type {any} */ l) =>
        n + BigInt(l.lineTotalCentavos) + BigInt(l.discountCentavos),
      0n,
    ),
  );
  expect(BigInt(row.gross_sales_centavos)).toBe(gross);
  expect(BigInt(row.promo_discount_centavos)).toBe(0n);
  expect(
    z.printModel.lines.find((/** @type {any} */ l) => l.label.startsWith("Senior"))
      .value,
  ).not.toBe("₱0.00");
});

test("IP-INT2FIX: the tax summary subtracts an approved refund, so output VAT is not overstated", async () => {
  const before = (await api("/api/v1/fiscal/tax-summary")).body.totals;
  shift = crypto.randomUUID();
  const opened = await pushRaw(
    op("store.shift.open", {
      shiftId: shift,
      policyId: policy,
      openingCentavos: "0",
    }),
  );
  expect(opened.status).toBe("applied");
  const { id, result } = await ring(["VAT39"], "3900");
  expect(result.status).toBe("applied");
  const sold = (await api("/api/v1/fiscal/tax-summary")).body.totals;
  expect(Number(sold.vat) - Number(before.vat)).toBe(418);
  expect(sold.documents).toBe(before.documents + 1);
  const refund = await pushRaw(
    op("store.refund", { saleId: id, reason: "SAMPLE returned" }),
  );
  expect(refund.status).toBe("applied");
  const [reversal] =
    await h.db`select id from store_reversals where sale_id=${id}`;
  await web("reversals/decide", { id: reversal.id, decision: "approved" });
  const after = await api("/api/v1/fiscal/tax-summary");
  expect(after.status).toBe(200);
  for (const key of ["gross", "vatable", "vat", "total_due", "vat_exempt", "zero_rated"])
    expect(after.body.totals[key]).toBe(before[key]);
  // the sale is still a document of the day; the credit memo is not counted as a sale
  expect(after.body.totals.documents).toBe(before.documents + 1);
});

test("IP-INT3: the store bundle carries each product's tax facts for a handheld that asks, and nothing for one that does not", async () => {
  const { bundle } = await import("../src/domains/van/projection.js");
  const actor = await actorFor(h.db, seller.userId);
  const ctx = {
    db: h.db,
    actor,
    device: { id: seller.deviceId },
    params: {
      serviceDate: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
      posMode: true,
    },
    now: Date.now(),
  };
  /** @param {any} res @param {string} code */
  const row = (res, code) =>
    res.policy.storePos.catalogue.find((/** @type {any} */ c) => c.code === code);
  const plain = await bundle(ctx, {});
  expect(row(plain, "VAT39")).toBeTruthy();
  expect(row(plain, "VAT39").taxTreatment).toBeUndefined();
  expect(row(plain, "VAT39").taxBasisPoints).toBeUndefined();
  const handheld = await bundle(
    { ...ctx, params: { ...ctx.params, handheld: true } },
    {},
  );
  expect(row(handheld, "VAT39")).toMatchObject({
    unitPriceMinor: "3900",
    taxTreatment: "vatable",
    taxBasisPoints: 1200,
  });
  expect(row(handheld, "EXM112")).toMatchObject({
    taxTreatment: "exempt",
    taxBasisPoints: 0,
  });
  expect(row(handheld, "ZRO50")).toMatchObject({
    taxTreatment: "zero_rated",
    taxBasisPoints: 0,
  });
});
