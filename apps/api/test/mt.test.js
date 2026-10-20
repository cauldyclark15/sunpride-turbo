import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness, createUser } from "./harness.js";
import { install as org } from "../src/domains/org/index.js";
import { install as orders } from "../src/domains/orders/index.js";
import { install as mt } from "../src/domains/mt/index.js";
import { ensureRoot } from "../src/domains/org/identity.js";
import { resolvePrice } from "../src/domains/orders/pricing.js";
import { parsePurchaseOrder, csv } from "../src/domains/mt/parsers.js";
import { deductionFlow } from "../src/domains/mt/metrics.js";

/** @type {import('./harness.js').Harness} */ let h;
/** @type {any} */ let admin;
/** @type {any} */ let reviewer;
/** @type {any} */ let foreign;
/** @type {any} */ let customer;
/** @type {any} */ let otherCustomer;
/** @type {any[]} */ let branches = [];
let root = "",
  product = "";
const day = () =>
  new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
/** @param {string} role @param {string} name @param {string} unit */
async function person(role, name, unit) {
  const email = `${name}@test.invalid`,
    password = "fixture password only";
  const id = await createUser(h, email, password);
  const [p] =
    await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id,effective_from) values(${id},${id},${name},${email},${role},'active',${unit},'2020-01-01') returning id`;
  const r = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(r.status).toBe(200);
  return {
    userId: id,
    profileId: p.id,
    cookie: r.headers.get("set-cookie")?.split(";")[0],
  };
}
/** @param {string} name @param {string} account */
async function portalUser(name, account) {
  const email = `${name}@test.invalid`,
    password = "fixture password only",
    id = await createUser(h, email, password);
  await h.db`insert into mt_portal_memberships(user_id,name,scope_kind,scope_key,effective_from) values(${id},${name},'account',${account},'2020-01-01')`;
  const r = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(r.status).toBe(200);
  return { userId: id, cookie: r.headers.get("set-cookie")?.split(";")[0] };
}
/** @param {any} who @param {string} path @param {any} [body] */
async function api(who, path, body) {
  const r = await h.fetch(
    path.startsWith("/api/") ? path : `/api/v1/mt/${path}`,
    {
      method: body ? "POST" : "GET",
      headers: {
        cookie: who?.cookie ?? "",
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  return { status: r.status, body: /** @type {any} */ (await r.json()) };
}
/** @param {string} key @param {number} amount @param {string} [kind] @param {string} [from] @param {string|null} [to] */
async function approved(
  key,
  amount,
  kind = "branch",
  from = "2020-01-01T00:00:00Z",
  to = null,
) {
  const [t] =
    await h.db`insert into mt_trade_terms(scope_kind,scope_key,name,status,source,sap_key,source_version,effective_from,effective_to,requested_by,approved_by) values(${kind},${key},'Sample conditions','approved','sample',${crypto.randomUUID()},'v1',${new Date(from)},${to ? new Date(to) : null},${admin.userId},${reviewer.userId}) returning id`;
  await h.db`insert into mt_term_conditions(term_id,ordinal,kind,product_id,uom,amount_centavos) values(${t.id},0,'price',${product},'PC',${amount})`;
  return t.id;
}
/** @param {string} po @param {any} [over] */
async function preview(po, over = {}) {
  return api(admin, "intake/preview", {
    idempotencyKey: crypto.randomUUID(),
    bindingId: branches[0].id,
    filename: "sample.csv",
    format: "csv",
    contentBase64: Buffer.from(
      `po_number,delivery_date,sku,uom,quantity,price_centavos\n${po},${day()},P1,PC,2,1200`,
    ).toString("base64"),
    ...over,
  });
}
beforeAll(async () => {
  h = await startHarness({ installers: [org, orders, mt] });
  root = await ensureRoot(h.db);
  admin = await person("super_admin", "admin", root);
  reviewer = await person("manager", "reviewer", root);
  const [unit] =
    await h.db`insert into org_units(organization_id,code,name,type_code,status,parent_id,effective_from) values('sunpride','OTHER','Other region','REGION','active',${root},'2020-01-01') returning id`;
  foreign = await person("operations", "foreign", unit.id);
  const [p] =
    await h.db`insert into products(code,name,category,uom,unit_price,active,organization_id,quantity_scale) values('P1','Sample meat','Canned','PC',0,true,'sunpride',1) returning id`;
  product = p.id;
  for (const [i, key] of ["A1", "A2", "X1"].entries()) {
    const [c] =
      await h.db`insert into customers(code,name,channel,territory,credit_limit,active) values(${key},${key},'mt','NORTH',1000,true) returning id`;
    const [o] =
      await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,channel,created_by) values('sunpride',${key},${`Sample ${key}`},'active',${root},'mt',${admin.userId}) returning id`;
    await h.db`insert into outlet_customer_links(outlet_id,customer_id,source,effective_from,actor_subject,reason) values(${o.id},${c.id},'office','2020-01-01',${admin.userId},'fixture')`;
    const [b] =
      await h.db`insert into mt_account_bindings(customer_id,outlet_id,account_key,banner_key,branch_key,label,source,source_version,effective_from) values(${c.id},${o.id},${i === 2 ? "X" : "A"},${i === 2 ? "XB" : "AB"},${key},${`Sample ${key}`},'sample','v1','2020-01-01') returning *`;
    branches.push(b);
  }
  customer = await portalUser("customer", "A");
  otherCustomer = await portalUser("other", "X");
  await approved("A", 1000, "account");
  await approved("A1", 1200);
  await approved("X1", 1500);
  await h.db`insert into mt_deduction_types(code,label,sla_days,effective_from) values('SHORT','Short delivery',7,'2020-01-01')`;
});
afterAll(async () => {
  await h?.close();
});

test("F-306 F-309 field sales cannot bypass office queues through direct HTTP calls", async () => {
  const seller = await person("sales", "field-seller", root);
  for (const path of ["options", "intake", "terms", "deductions"])
    expect((await api(seller, path)).status).toBe(403);
});

test("F-306 sample PDF retains its actual bytes and requires manual OCR review without invented facts", async () => {
  const bytes = new Uint8Array(
    await Bun.file(
      new URL("./fixtures/mt/sample-po.pdf", import.meta.url),
    ).arrayBuffer(),
  );
  const parsed = await parsePurchaseOrder("ocr", bytes);
  expect(parsed.lines).toEqual([]);
  expect(parsed.poNumber).toBe("");
  expect(parsed.exceptions[0]).toContain("not connected");
});

test("F-307 immutable contract original is captured with a proposed version, replayed once and scoped on download", async () => {
  const contentBase64 = Buffer.from(
    await Bun.file(
      new URL("./fixtures/mt/sample-po.pdf", import.meta.url),
    ).arrayBuffer(),
  ).toString("base64");
  const input = {
    idempotencyKey: crypto.randomUUID(),
    name: "SAMPLE attachment proposal",
    scopeKind: "branch",
    scopeKey: branches[0].branch_key,
    effectiveFrom: "2039-01-01T00:00:00Z",
    conditions: [{ kind: "listing_fee", amountCentavos: 1000 }],
    attachment: { filename: "SAMPLE-contract-evidence.pdf", contentBase64 },
  };
  const saved = await api(admin, "terms/save", input);
  expect(saved.status).toBe(200);
  expect((await api(admin, "terms/save", input)).body.id).toBe(saved.body.id);
  const q = await api(reviewer, "terms");
  expect(
    q.body.rows.find((/** @type {any} */ t) => t.id === saved.body.id)
      .attachment.filename,
  ).toBe(input.attachment.filename);
  const path = "/api/v1/mt/terms/document?id=" + saved.body.id;
  expect((await api(reviewer, path)).body.content_base64).toBe(contentBase64);
  expect((await api(foreign, path)).status).toBe(403);
  expect((await api(customer, path)).status).toBe(401);
  expect(
    (
      await h.db`select count(*)::int n from mt_term_documents where term_id=${saved.body.id}`
    )[0].n,
  ).toBe(1);
  await expect(
    (async () => {
      await h.db`update mt_term_documents set filename='overwritten.pdf' where term_id=${saved.body.id}`;
    })(),
  ).rejects.toThrow("immutable");
});

test("F-309 flow compares received deduction value, not reconstructed outstanding balances", () => {
  const flow = deductionFlow(
    [
      { received_on: "2026-10-20", amountCentavos: 1000 },
      { received_on: "2026-10-01", amountCentavos: 2000 },
      { received_on: "2026-09-10", amountCentavos: 500 },
    ],
    Date.parse("2026-10-20T12:00:00+08:00"),
  );
  expect(flow.last28Centavos).toBe(3000);
  expect(flow.prior28Centavos).toBe(500);
  expect(flow.weekly.reduce((n, w) => n + w.count, 0)).toBe(3);
});
test("F-306 shipped sample files exercise each concrete document adapter", async () => {
  for (const [format, ext] of [
    ["csv", "csv"],
    ["edi", "edi"],
    ["email", "eml"],
  ]) {
    const content = await Bun.file(
      new URL(`./fixtures/mt/sample-po.${ext}`, import.meta.url),
    ).arrayBuffer();
    const parsed = await parsePurchaseOrder(format, new Uint8Array(content));
    expect(parsed.lines[0].productCode).toBe("P1");
    expect(parsed.lines[0].quantity).toBe(2);
  }
});

test("F-306 rounded invalid quantities require an explicit fix; duplicate business POs roll back the canonical order", async () => {
  const bad = await preview("PRECISION", {
    contentBase64: Buffer.from(
      `po_number,delivery_date,sku,uom,quantity\nPRECISION,${day()},P1,PC,1.0004`,
    ).toString("base64"),
  });
  const detail = await api(admin, `intake?id=${bad.body.id}`);
  expect(detail.body.lines[0].exceptions.length).toBeGreaterThan(0);
  expect(
    (
      await api(admin, "intake/confirm", {
        id: bad.body.id,
        revision: 1,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(422);
  const first = await preview("BUSINESS-KEY");
  expect(
    (
      await api(admin, "intake/confirm", {
        id: first.body.id,
        revision: 1,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(200);
  const duplicate = await preview("BUSINESS-KEY", {
    filename: "changed.csv",
    contentBase64: Buffer.from(
      `po_number,delivery_date,sku,uom,quantity\nBUSINESS-KEY,${day()},P1,PC,3`,
    ).toString("base64"),
  });
  const [before] = await h.db`select count(*)::int n from orders`;
  expect(
    (
      await api(admin, "intake/confirm", {
        id: duplicate.body.id,
        revision: 1,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
  expect((await h.db`select count(*)::int n from orders`)[0].n).toBe(before.n);
});

test("F-306 CSV quoted cells, sample EDI and structured email normalize; mixed PO and malformed files do not invent facts", async () => {
  expect(csv('sku,note\nP1,"a,b"\n')).toEqual([
    ["sku", "note"],
    ["P1", "a,b"],
  ]);
  expect(() => csv('x\n"unterminated')).toThrow();
  const bytes = (/** @type {string} */ s) => new TextEncoder().encode(s);
  expect(
    (
      await parsePurchaseOrder(
        "edi",
        bytes(`PO|E1|${day()}~LINE|P1|PC|2|1200~`),
      )
    ).lines[0].quantity,
  ).toBe(2);
  expect(
    (
      await parsePurchaseOrder(
        "email",
        bytes(
          `Subject: Sample PO\nPO-Number: MAIL1\nDelivery-Date: ${day()}\nLines:\nsku,uom,quantity\nP1,PC,2`,
        ),
      )
    ).poNumber,
  ).toBe("MAIL1");
  expect(
    (await parsePurchaseOrder("ocr", bytes("not OCR"))).exceptions.length,
  ).toBe(1);
  expect(
    (
      await parsePurchaseOrder(
        "csv",
        bytes(
          `po_number,delivery_date,sku,uom,quantity\nONE,${day()},P1,PC,1\nTWO,${day()},P1,PC,1`,
        ),
      )
    ).exceptions.length,
  ).toBe(1);
});

test("F-307 a shared accounting customer resolves only the supplied branch; missing branch context fails closed", async () => {
  const [store] =
    await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,channel,created_by) values('sunpride','SHARED-STORE','Shared account second store','active',${root},'mt',${admin.userId}) returning id`;
  const [binding] =
    await h.db`insert into mt_account_bindings(customer_id,outlet_id,account_key,banner_key,branch_key,label,source,source_version,effective_from) values(${branches[0].customer_id},${store.id},'A','AB','A-SHARED','Shared sample branch','sample','v1','2020-01-01') returning id`;
  try {
    const q = {
      organizationId: "sunpride",
      productId: product,
      uom: "PC",
      channelKey: "mt",
      customerCode: "A1",
      at: Date.now(),
    };
    expect((await resolvePrice(h.db, q)).unitPriceCentavos).toBeNull();
    expect(
      (await resolvePrice(h.db, { ...q, outletId: branches[0].outlet_id }))
        .unitPriceCentavos,
    ).toBe(1200);
    expect(
      (await resolvePrice(h.db, { ...q, outletId: store.id }))
        .unitPriceCentavos,
    ).toBe(1000);
  } finally {
    await h.db`delete from mt_account_bindings where id=${binding.id}`;
  }
});

test("F-307 approved branch outranks banner/account; exact effective boundary and missing-price fail closed", async () => {
  const quote = (/** @type {string} */ customerCode, at = Date.now()) =>
    resolvePrice(h.db, {
      organizationId: "sunpride",
      productId: product,
      uom: "PC",
      channelKey: "mt",
      customerCode,
      at,
    });
  expect((await quote("A1")).unitPriceCentavos).toBe(1200);
  expect((await quote("A2")).unitPriceCentavos).toBe(1000);
  const term = await approved("AB", 1100, "banner", "2030-01-01T00:00:00Z");
  expect(
    (await quote("A2", Date.parse("2029-12-31T23:59:59Z"))).unitPriceCentavos,
  ).toBe(1000);
  expect(
    (await quote("A2", Date.parse("2030-01-01T00:00:00Z"))).unitPriceCentavos,
  ).toBe(1100);
  expect(
    (
      await resolvePrice(h.db, {
        organizationId: "sunpride",
        productId: product,
        uom: "CASE",
        channelKey: "mt",
        customerCode: "A1",
        at: Date.now(),
      })
    ).unitPriceCentavos,
  ).toBeNull();
  await h.db`update mt_trade_terms set source='sap' where id=${term}`;
  expect(
    (await quote("A2", Date.parse("2030-01-01T00:00:00Z"))).unitPriceCentavos,
  ).toBeNull();
});

test("F-307 price, listing fee, rebate, logistics terms require independent approval and reject overlap and out-of-scope writes", async () => {
  const input = {
    idempotencyKey: crypto.randomUUID(),
    name: "Sample next-year terms",
    scopeKind: "branch",
    scopeKey: "A2",
    effectiveFrom: "2035-01-01T00:00:00Z",
    conditions: [
      { kind: "price", productCode: "P1", uom: "PC", amountCentavos: 1300 },
      { kind: "listing_fee", amountCentavos: 100000 },
      { kind: "rebate", rateBps: 200 },
      { kind: "logistics_allowance", rateBps: 100 },
    ],
  };
  const draft = await api(admin, "terms/save", input);
  expect(draft.status).toBe(200);
  const id = draft.body.id;
  expect(
    (
      await api(admin, "terms/submit", {
        id,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await api(admin, "terms/approve", {
        id,
        note: "own",
        idempotencyKey: crypto.randomUUID(),
      })
    ).body.error.code,
  ).toBe("self_approval");
  expect(
    (
      await api(reviewer, "terms/approve", {
        id,
        note: "Reviewed sample contract",
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(200);
  const overlap = await api(admin, "terms/save", {
    ...input,
    idempotencyKey: crypto.randomUUID(),
  });
  await api(admin, "terms/submit", {
    id: overlap.body.id,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(
    (
      await api(reviewer, "terms/approve", {
        id: overlap.body.id,
        note: "Overlap",
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await api(foreign, "terms/save", {
        ...input,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await h.db`select count(*)::int n from mt_term_events where term_id=${id}`
    )[0].n,
  ).toBe(3);
});

test("F-306 preview, fix, revalidate, confirm create ONE canonical order, preserve original, survive parallel retries and refuse stale edits", async () => {
  const r = await preview("PO-ONE");
  expect(r.status).toBe(200);
  const id = r.body.id;
  const d = await api(admin, `intake?id=${id}`);
  expect(d.body.lines[0].exceptions).toEqual([]);
  const confirm = { id, revision: 1, idempotencyKey: crypto.randomUUID() };
  const results = await Promise.all([
    api(admin, "intake/confirm", confirm),
    api(admin, "intake/confirm", confirm),
  ]);
  expect(results.map((x) => x.status)).toEqual([200, 200]);
  expect(results[0].body.orderId).toBe(results[1].body.orderId);
  const [order] =
    await h.db`select * from orders where id=${results[0].body.orderId}`;
  expect(order.order_type).toBe("modern_trade");
  expect(
    (
      await h.db`select count(*)::int n from jobs where kind='analytics.refresh' and payload->>'date'=${day()}`
    )[0].n,
  ).toBeGreaterThan(0);
  expect(Number(order.total_centavos)).toBe(2400);
  expect(
    (await h.db`select count(*)::int n from outside_call_orders`)[0].n,
  ).toBe(0);
  expect((await preview("PO-ONE")).body.id).toBe(id);
  expect((await api(foreign, `intake/document?id=${id}`)).status).toBe(403);
  const source = await api(admin, `intake/document?id=${id}`);
  expect(source.body.sha256.length).toBe(64);
  let immutable = false;
  try {
    await h.db`update mt_po_documents set filename='tamper' where id=${d.body.document_id}`;
  } catch {
    immutable = true;
  }
  expect(immutable).toBe(true);
  const bad = await preview("FIX", {
    contentBase64: Buffer.from(
      `po_number,delivery_date,sku,uom,quantity\nFIX,not-date,BOGUS,PC,-1`,
    ).toString("base64"),
  });
  expect(
    (
      await api(admin, "intake/confirm", {
        id: bad.body.id,
        revision: 1,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(422);
  const fix = {
    id: bad.body.id,
    revision: 1,
    poNumber: "FIX",
    serviceDate: day(),
    lines: [
      {
        productCode: "P1",
        uom: "PC",
        quantity: 2,
        requestedPriceCentavos: 1200,
      },
    ],
    idempotencyKey: crypto.randomUUID(),
  };
  expect((await api(admin, "intake/fix", fix)).status).toBe(200);
  expect(
    (
      await api(admin, "intake/fix", {
        ...fix,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await api(admin, "intake/confirm", {
        id: bad.body.id,
        revision: 2,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(200);
});

test("F-306 confirmation rechecks withdrawn prices and account scope before even a receipt replay", async () => {
  const p = await preview("WITHDRAW");
  const [t] =
    await h.db`select * from mt_trade_terms where scope_kind='branch' and scope_key='A1' and status='approved'`;
  await h.db`update mt_trade_terms set status='rejected' where id=${t.id}`;
  // Account fallback is 1000, but PO requests 1200.
  expect(
    (
      await api(admin, "intake/confirm", {
        id: p.body.id,
        revision: 1,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(422);
  await h.db`update mt_trade_terms set status='approved' where id=${t.id}`;
  expect((await api(null, "intake")).status).toBe(401);
});

test("F-309 remittance balances, invoice isolation, ownership/SLA and claim ageing are transactionally enforced", async () => {
  const [type] = await h.db`select id from mt_deduction_types limit 1`;
  const [invoice] =
    await h.db`insert into mt_invoice_replicas(binding_id,invoice_number,amount_centavos,issued_on,due_on,source,sap_key,source_version) values(${branches[0].id},'SAMPLE-INV',10000,'2020-01-01','2020-01-31','sample','INV1','v1') returning id`;
  const input = {
    idempotencyKey: crypto.randomUUID(),
    bindingId: branches[0].id,
    reference: "REM1",
    receivedOn: "2026-01-01",
    grossCentavos: 10000,
    paidCentavos: 9000,
    deductions: [
      {
        typeId: type.id,
        invoiceId: invoice.id,
        amountCentavos: 1000,
        claimReference: "CLAIM-SAMPLE",
      },
    ],
  };
  expect(
    (await api(admin, "remittances/capture", { ...input, grossCentavos: 9999 }))
      .body.error.code,
  ).toBe("unbalanced_remittance");
  expect((await api(admin, "remittances/capture", input)).status).toBe(200);
  expect((await api(admin, "remittances/capture", input)).status).toBe(200);
  const q = await api(admin, "deductions");
  expect(q.body.rows[0].age_days).toBeGreaterThan(0);
  expect(q.body.summary.overdue).toBe(1);
  expect(q.body.rows[0].owner_name).toBe("admin");
  expect((await api(foreign, "deductions")).body.rows).toEqual([]);
  expect(
    (
      await api(admin, "remittances/capture", {
        ...input,
        idempotencyKey: crypto.randomUUID(),
        reference: "FOREIGN",
        bindingId: branches[2].id,
      })
    ).status,
  ).toBe(403);
});

test("F-611 external customer has no office capabilities; chain sees sibling branches but not foreign POs/invoices/deductions; disputes persist and revoked membership blocks replay", async () => {
  const [deduction] = await h.db`select id from mt_deductions limit 1`;
  const overview = await api(customer, "/api/v1/portal/overview");
  expect(overview.status).toBe(200);
  expect(
    overview.body.purchaseOrders.some(
      (/** @type {any} */ p) => p.poNumber === "PO-ONE",
    ),
  ).toBe(true);
  expect(overview.body.invoices.length).toBe(1);
  expect(overview.body.deductions.length).toBe(1);
  expect(overview.body.deductions[0].owner_profile_id).toBeUndefined();
  expect(
    (await api(otherCustomer, "/api/v1/portal/overview")).body.invoices,
  ).toEqual([]);
  expect((await api(customer, "/api/v1/orders/list")).status).toBe(401);
  expect((await api(customer, "/api/v1/org/tree")).status).toBe(401);
  const dispute = {
    idempotencyKey: crypto.randomUUID(),
    deductionId: deduction.id,
    reference: "D-SAMPLE",
    message: "The goods were received in full. Please review.",
  };
  expect(
    (await api(otherCustomer, "/api/v1/portal/disputes/submit", dispute))
      .status,
  ).toBe(403);
  const r = await api(customer, "/api/v1/portal/disputes/submit", dispute);
  expect(r.status).toBe(200);
  expect(
    (await api(customer, "/api/v1/portal/disputes/submit", dispute)).body.id,
  ).toBe(r.body.id);
  expect(
    (
      await api(reviewer, "disputes/respond", {
        id: r.body.id,
        deductionId: deduction.id,
        status: "accepted",
        response: "Sample claim accepted for SAP review",
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(200);
  expect(
    (await api(customer, "/api/v1/portal/overview")).body.deductions[0]
      .disputes[0].response,
  ).toBe("Sample claim accepted for SAP review");
  await h.db`update mt_portal_memberships set effective_to=now() where user_id=${customer.userId}`;
  expect(
    (await api(customer, "/api/v1/portal/disputes/submit", dispute)).status,
  ).toBe(403);
  expect((await api(customer, "/api/v1/portal/overview")).status).toBe(403);
});
