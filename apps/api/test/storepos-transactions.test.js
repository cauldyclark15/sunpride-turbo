import { beforeAll, afterAll, test, expect } from "bun:test";
import { tx } from "@sunpride/db/client";
import {
  startHarness,
  profileStore,
  boundDevice,
  createUser,
  signedPost,
} from "./harness.js";
import { install } from "../src/domains/storepos/index.js";
import { actorFor } from "../src/core/context.js";
import { ingestMaster } from "../src/domains/integration/replicas.js";
import { sampleMaster, sampleMasters } from "../../sap-mock/src/sample.js";
import { postMovement } from "../src/domains/inventory/posting.js";
import {
  allocateDocumentNumber,
  saveRegistration,
  createSeries,
} from "../src/domains/fiscal/series.js";
import { commands as inventory } from "../src/domains/inventory/commands.js";
import { pinSettings } from "../src/domains/storepos/security.js";
import { createHmac, randomInt } from "node:crypto";
/** @type {any} */ let h;
/** @type {any} */ let people;
/** @type {any} */ let seller;
/** @type {any} */ let boss;
/** @type {any} */ let actor;
/** @type {any} */ let supervisor;
let reviewCookie = "";
const unit = crypto.randomUUID(),
  location = crypto.randomUUID(),
  warehouse = crypto.randomUUID(),
  transit = crypto.randomUUID(),
  outlet = crypto.randomUUID();
let register = "",
  policy = "",
  mode = "",
  product = "",
  cookie = "",
  allocation = "",
  prefix = "",
  shift = "",
  customerPhone = "09912345678";
/** @type {any[]} */ const sales = [];
const pin = String(randomInt(100000, 999999));
/** @param {any} who */ async function persist(who) {
  const p = who.profile;
  await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${who.userId},${who.userId},${p.name},${who.email},${p.role},'active',${unit})`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},${p.role},now()-interval '1 day','fixture','fixture')`;
}
/** @param {string} path @param {any} p */ async function web(
  path,
  p,
  authCookie = cookie,
) {
  const res = await h.fetch("/api/v1/storepos/" + path, {
    method: "POST",
    headers: { cookie: authCookie, "content-type": "application/json" },
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
/** @param {any} operation */ async function push(operation) {
  const r = await signedPost(h, seller, "/api/sync/push", {
    version: 2,
    app: "van-android",
    deviceId: seller.deviceId,
    scopeId: unit,
    operations: [operation],
  });
  expect(r.res.status).toBe(200);
  if (r.body.results[0].status !== "applied")
    throw new Error(JSON.stringify(r.body));
  return r.body.results[0];
}
/** @param {string} method @param {boolean} [benefit] */ async function sale(
  method,
  benefit = false,
) {
  const [a] =
    await h.db`select next_issue from fiscal_allocations where id=${allocation}`;
  const serial = String(a.next_issue),
    id = crypto.randomUUID(),
    total = benefit ? "3950" : "4500";
  /** @type {any} */ const p = {
    saleId: id,
    receiptNumber: `${prefix}-${serial.padStart(9, "0")}`,
    lines: [{ productId: product, uom: "PC", quantity: 1 }],
    totalCentavos: total,
    fiscal: { allocationId: allocation, serial },
    customerPhone,
    redeemPoints: benefit ? "1" : "0",
    employeeDiscount: benefit,
    tenders:
      method === "split"
        ? [
            { method: "cash", amountCentavos: "2500" },
            {
              method: "gcash",
              amountCentavos: "2000",
              reference: "SAMPLE-SPLIT-REF",
            },
          ]
        : [
            {
              method,
              amountCentavos: total,
              ...(method === "gcash" ? { reference: "SAMPLE-WALLET-REF" } : {}),
            },
          ],
  };
  if (benefit) {
    const [q] =
      await h.db`select * from store_register_policies where id=${policy}`;
    p.employeeProof = createHmac("sha256", Buffer.from(q.pin_key, "hex"))
      .update(`${id}|${shift}|${total}|${policy}`)
      .digest("hex");
  }
  const operation = op("store.sale", p);
  await push(operation);
  sales.push(operation);
  return id;
}
beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  people = profileStore(h);
  h.setHooks({ unitInScope: async () => true });
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SUNPRIDE','SAMPLE Cebu','national','active',now()-interval '1 day')`;
  await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values('retail-test','org_units',${unit},'unit')`;
  seller = await boundDevice(h, people, {
    app: "van-android",
    orgUnitId: unit,
  });
  await persist(seller);
  const userId = await createUser(
    h,
    "store-reviewer@example.com",
    "fixture password only",
  );
  boss = {
    userId,
    email: "store-reviewer@example.com",
    profile: people.set(userId, {
      role: "super_admin",
      orgUnitId: unit,
      name: "Sample supervisor",
    }),
  };
  await persist(boss);
  actor = await actorFor(h.db, seller.userId);
  supervisor = await actorFor(h.db, userId);
  const reviewerId = await createUser(
    h,
    "store-stock-approver@example.com",
    "fixture password only",
  );
  const reviewer = {
    userId: reviewerId,
    email: "store-stock-approver@example.com",
    profile: people.set(reviewerId, {
      role: "approver",
      orgUnitId: unit,
      name: "Independent stock approver",
    }),
  };
  await persist(reviewer);
  const reviewerLogin = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: reviewer.email,
      password: "fixture password only",
    }),
  });
  reviewCookie = (reviewerLogin.headers.get("set-cookie") ?? "").split(";")[0];
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
    sampleMaster("material", "STORE-SKU", {
      ...material.data,
      code: "STORE-SKU",
      name: "Sample store item",
      tracking: "none",
    }),
  );
  const condition = sampleMasters.find((m) => m.kind === "condition");
  await ingestMaster(
    h.db,
    sampleMaster("condition", "STORE-PRICE", {
      ...condition.data,
      productCode: "STORE-SKU",
    }),
  );
  await ingestMaster(
    h.db,
    sampleMasters.find((m) => m.kind === "customer"),
  );
  product = (await h.db`select id from products where code='STORE-SKU'`)[0].id;
  const customer = (
    await h.db`select id from customers where code='MOCK-C1'`
  )[0].id;
  await h.db`insert into outlets(id,organization_id,code,name,status,custodian_org_unit_id,channel,created_by) values(${outlet},'sunpride','STORE','Sample store','active',${unit},'gt',${seller.userId})`;
  await h.db`insert into outlet_customer_links(outlet_id,customer_id,source,effective_from,actor_subject,reason) values(${outlet},${customer},'sample',now()-interval '1 day','fixture','fixture')`;
  for (const [id, type, code] of [
    [location, "store", "STORE"],
    [warehouse, "warehouse", "DEPOT"],
    [transit, "in_transit", "TRANSIT"],
  ])
    await h.db`insert into inventory_locations(id,organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values(${id},'sunpride',${unit},'CEBU',${code},${code},${type},true,true,true,true,false)`;
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
      loyaltyEnabled: true,
      earnPerCentavos: "1000",
      pointValueCentavos: "100",
      pin,
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
        tin: "SAMPLE",
        address: "Sample address",
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
        lastSerial: "100",
        effectiveFrom: "2026-01-01T00:00:00Z",
      }),
    );
    if (type === "sales_invoice") {
      const a = await tx(h.db, (db) =>
        allocateDocumentNumber(db, {
          actor,
          deviceId: seller.deviceId,
          seriesId: series.id,
          requestKey: crypto.randomUUID(),
          count: 10,
        }),
      );
      allocation = a.allocationId;
      prefix = p;
    }
  }
  await tx(h.db, (db) =>
    postMovement(db, {
      kind: "opening_balance",
      sourceType: "cutover",
      sourceId: location,
      idempotencyKey: "store-opening",
      occurredAt: Date.now(),
      organizationId: "sunpride",
      actor: { profileId: actor.profileId, userId: actor.userId },
      lines: [
        {
          productId: product,
          quantityBase: 5,
          fromLocationId: null,
          toLocationId: location,
          uom: "PC",
          unitCostMinor: 1000,
        },
      ],
    }),
  );
  shift = crypto.randomUUID();
  await push(
    op("store.shift.open", {
      shiftId: shift,
      policyId: policy,
      openingCentavos: "10000",
    }),
  );
  await push(
    op("store.customer", { phone: customerPhone, name: "Sample shopper" }),
  );
}, 30000);
afterAll(async () => h?.close());

test("F-R03/F-R07 shared pricing, controlled benefit, split tender and immutable replay", async () => {
  await sale("cash");
  await sale("gcash", true);
  const replay = await signedPost(h, seller, "/api/sync/push", {
    version: 2,
    app: "van-android",
    deviceId: seller.deviceId,
    scopeId: unit,
    operations: [sales[0]],
  });
  expect(replay.body.results[0].status).toBe("duplicate");
  const [facts] =
    await h.db`select sum(sales_centavos)::text as total from analytics_sales_facts where source_location_id=${location}`;
  expect(facts.total).toBe("8450");
  const [balance] = await h.db`select sum(delta)::text as n from store_points`;
  expect(balance.n).toBe("6");
  const [stock] =
    await h.db`select available_base::text as n from inventory_balances where location_id=${location}`;
  expect(stock.n).toBe("3");
});
test("F-R03 independent void and receipt refund reverse canonical facts, not frozen originals", async () => {
  for (const [operation, kind] of [
    [sales[0], "void"],
    [sales[1], "refund"],
  ]) {
    const request = op(`store.${kind}`, {
      saleId: operation.payload.saleId,
      reason: "SAMPLE customer request",
    });
    await push(request);
    await web("reversals/decide", {
      id: request.clientOpId,
      decision: "approved",
    });
  }
  const [facts] =
    await h.db`select coalesce(sum(sales_centavos),0)::text as n from analytics_sales_facts where source_location_id=${location}`;
  expect(facts.n).toBe("0");
  const [frozen] =
    await h.db`select receipt from store_sales where id=${sales[1].payload.saleId}`;
  expect(frozen.receipt.totalMinor).toBe("3950");
  const [balance] = await h.db`select sum(delta)::text as n from store_points`;
  expect(balance.n).toBe("0");
  await sale("split");
});
test("F-R04/F-R05 canonical cycle count is independently posted and low stock suggests an approved transfer", async () => {
  await push(
    op("store.receive", {
      purchaseOrder: "SAMPLE-PO-1",
      lines: [{ productId: product, quantityBase: 1 }],
    }),
  );
  const rows =
    await h.db`select * from inventory_balances where location_id=${location}`;
  const b = rows[0];
  await push(
    op("store.count", {
      countType: "cycle",
      lines: [
        {
          productId: product,
          version: String(b.version),
          stockStatus: "available",
          countedBase: String(Number(b.available_base) - 1),
        },
        {
          productId: product,
          version: String(b.version),
          stockStatus: "quality_hold",
          countedBase: String(b.quality_hold_base),
        },
      ],
    }),
  );
  const [count] =
    await h.db`select * from stock_count_sessions where location_id=${location}`;
  await tx(h.db, async (db) => {
    const ctx = { db, actor: supervisor, now: Date.now() };
    const body = { sessionId: count.id, idempotencyKey: crypto.randomUUID() };
    const prepared = await inventory["counts/approve"].prepare(ctx, body);
    await inventory["counts/approve"].run(ctx, body, prepared);
  });
  const [posted] =
    await h.db`select status from stock_count_sessions where id=${count.id}`;
  expect(posted.status).toBe("posted");
  await web("reorder/save", {
    productId: product,
    sourceLocationId: warehouse,
    minimumBase: "5",
    targetBase: "10",
  });
  await web("reorder/suggest", {});
  const [suggestion] = await h.db`select * from store_replenishments`;
  await web("replenishments/prepare", {
    id: suggestion.id,
    inTransitLocationId: transit,
  });
  await web(
    "replenishments/decide",
    { id: suggestion.id, decision: "approved" },
    reviewCookie,
  );
  const [transfer] =
    await h.db`select status from stock_transfers where id=(select transfer_id from store_replenishments where id=${suggestion.id})`;
  expect(transfer.status).toBe("approved");
});
test("F-R02/F-R06/F-R01 X/Z sequence, real upload, deposit discrepancy and blind cash escalation", async () => {
  await push(op("store.read", { kind: "x" }));
  await push(op("store.read", { kind: "z" }));
  const [z] = await h.db`select * from store_reads where kind='z'`;
  expect(String(z.sequence)).toBe("1");
  expect(z.snapshot.salesCentavos).toBe("4500");
  const bytes = new Uint8Array(
    await Bun.file(
      import.meta.dir + "/fixtures/sample-return.jpg",
    ).arrayBuffer(),
  );
  const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const claim = await signedPost(h, seller, "/api/media/claims", {
    version: 2,
    app: "van-android",
    deviceId: seller.deviceId,
    purpose: "bank-deposit",
    ownerId: register,
    mime: "image/jpeg",
    size: bytes.length,
    sha256: sha,
  });
  expect(claim.res.status).toBe(200);
  const upload = await h.fetch("/api/media/uploads/" + claim.body.uploadId, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${claim.body.uploadToken}`,
      "content-type": "image/jpeg",
    },
    body: bytes,
  });
  expect(upload.status).toBe(200);
  await push(
    op("store.deposit", {
      zReadId: z.id,
      bank: "SAMPLE bank",
      reference: "SAMPLE-SLIP",
      amountCentavos: "2400",
      photoSha256: sha,
    }),
  );
  const [deposit] = await h.db`select * from store_deposits`;
  expect(deposit.status).toBe("needs_review");
  await web("deposits/decide", {
    id: deposit.id,
    decision: "accepted",
    reason: "SAMPLE reconciliation reviewed",
  });
  await push(op("store.shift.close", { declaredCentavos: "12000" }));
  const res = await h.fetch("/api/v1/storepos/workspace", {
    headers: { authorization: `Bearer ${seller.access}` },
  });
  const body = await res.json();
  expect(body.shifts[0].expectedCentavos).toBeNull();
  expect(body.shifts[0].varianceCentavos).toBeNull();
  expect(body.shifts[0].status).toBe("needs_review");
  const [closure] = await h.db`select * from store_shift_closures`;
  expect(String(closure.expected_centavos)).toBe("12500");
  expect(String(closure.variance_centavos)).toBe("-500");
});
test("F-R08 store KPI uses the canonical warehouse, editable target and posted shrink", async () => {
  const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  await web("targets/save", { from: day, to: day, amountCentavos: "10000" });
  const res = await h.fetch(
    "/api/v1/storepos/report?from=" + day + "&to=" + day,
    { headers: { cookie } },
  );
  expect(res.status).toBe(200);
  const result = await res.json();
  expect(result.source).toBe("analytics_sales_facts");
  expect(result.rows[0].sales).toBe(4500);
  expect(result.rows[0].target).toBe(10000);
  expect(result.rows[0].shrink).toBe(1);
});

test("F-R03 follow-up fully governed zero total does not invent a cash tender", async () => {
  await h.db`update store_register_policies set employee_discount_bps=10000 where id=${policy}`;
  const [a] =
    await h.db`select next_issue from fiscal_allocations where id=${allocation}`;
  const serial = String(a.next_issue),
    id = crypto.randomUUID();
  const [q] =
    await h.db`select pin_key from store_register_policies where id=${policy}`;
  const proof = createHmac("sha256", Buffer.from(q.pin_key, "hex"))
    .update(`${id}|${shift}|0|${policy}`)
    .digest("hex");
  const operation = op("store.sale", {
    saleId: id,
    receiptNumber: `${prefix}-${serial.padStart(9, "0")}`,
    lines: [{ productId: product, uom: "PC", quantity: 1 }],
    totalCentavos: "0",
    fiscal: { allocationId: allocation, serial },
    employeeDiscount: true,
    employeeProof: proof,
    tenders: [],
  });
  await push(operation);
  const [receipt] = await h.db`select receipt from store_sales where id=${id}`;
  expect(receipt.receipt.totalMinor).toBe("0");
  const [tender] =
    await h.db`select count(*)::int as n from store_tenders where sale_id=${id}`;
  expect(tender.n).toBe(0);
});

test("F-R08 follow-up two registers never double-count a store; dated target edits preserve other days", async () => {
  await sale("cash");
  const second = await web("registers/save", {
    locationId: location,
    terminalCode: "SAMPLE-SECOND",
    name: "Second sample terminal",
  });
  const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const before = new Date(Date.parse(day) - 86400000)
      .toISOString()
      .slice(0, 10),
    after = new Date(Date.parse(day) + 86400000).toISOString().slice(0, 10);
  await web("targets/save", {
    from: before,
    to: after,
    amountCentavos: "10000",
  });
  await web("targets/save", { from: day, to: day, amountCentavos: "15000" });
  await web("targets/save", {
    registerId: second.id,
    from: day,
    to: day,
    amountCentavos: "5000",
  });
  const res = await h.fetch(`/api/v1/storepos/report?from=${day}&to=${day}`, {
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  const result = await res.json();
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0].registers).toHaveLength(2);
  expect(result.rows[0].sales).toBe(4500);
  expect(result.rows[0].target).toBe(15000 + 5000);
  const retained =
    await h.db`select amount_centavos::text as n from store_daily_targets where register_id=${register} and (${before}::date between from_date and to_date or ${after}::date between from_date and to_date)`;
  expect(retained).toHaveLength(2);
  expect(retained[0].n).toBe("10000");
  expect(retained[1].n).toBe("10000");
  const [audit] =
    await h.db`select count(*)::int as n from fiscal_audit_events where table_name='store_daily_targets' and action='DELETE' and before_facts->>'amount_centavos'='10000'`;
  expect(audit.n).toBeGreaterThan(0);
});
