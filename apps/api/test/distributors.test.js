import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  startHarness,
  createUser,
  deviceKey,
  registerDevice,
  nativeSignIn,
  bind,
  signedPost,
} from "./harness.js";
import { install as org } from "../src/domains/org/index.js";
import { install as distributors } from "../src/domains/distributors/index.js";
import { install as orders } from "../src/domains/orders/index.js";
import { dayAdd, today } from "../src/domains/distributors/model.js";
import {
  parseSecondaryCsv,
  SECONDARY_HEADERS,
} from "../src/domains/distributors/capture.js";

/** @type {import('./harness.js').Harness} */ let h;
/** @type {any} */ let admin;
/** @type {any} */ let alice;
/** @type {any} */ let bob;
/** @type {any} */ let reader;
/** @type {any} */ let a;
/** @type {any} */ let b;
let unit = "",
  sku = "",
  store = "",
  territory = "",
  warehouse = "",
  van = "";
let version = 0;
const password = "test-only distributor password";
/** @param {string} role @param {string} name */
async function user(role, name) {
  const email = `${name}@distributor.test`;
  const id = await createUser(h, email, password);
  const [p] =
    await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id) values(${id},${id},${name},${email},${role},'active',${unit}) returning id`;
  const res = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  return {
    id: p.id,
    userId: id,
    cookie: res.headers.get("set-cookie")?.split(";")[0],
  };
}
/** @param {any} who @param {string} path @param {any} [body] */
async function api(who, path, body) {
  const res = await h.fetch(`/api/v1/${path}`, {
    method: body ? "POST" : "GET",
    headers: { cookie: who.cookie, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: res.status,
    body: /** @type {any} */ (await res.json()),
    res,
  };
}
/** @param {any} who @param {string} path @param {any} [body] @param {string} [id] */
async function post(who, path, body = {}, id = a.id) {
  return api(who, `distributors/${path}`, {
    distributorId: id,
    requestKey: crypto.randomUUID(),
    ...body,
  });
}
/** @param {any} who @param {string} path @param {string} [id] */
async function get(who, path, id = a.id) {
  return api(
    who,
    `distributors/${path}${path.includes("?") ? "&" : "?"}distributorId=${id}`,
  );
}
function settings() {
  return {
    doiWindowDays: 28,
    stockFreshDays: 1,
    nearExpiryDays: 30,
    understockDays: 7,
    overstockDays: 45,
    creditMaxAgeSeconds: 3600,
    reconciliationToleranceBase: 0,
    requiredDocuments: ["registration", "tax"],
    claimTypes: [
      { kind: "damage", minimumEvidence: 1 },
      { kind: "promotion", minimumEvidence: 1 },
      { kind: "freight", minimumEvidence: 1 },
      { kind: "shortage", minimumEvidence: 1 },
    ],
    scorecardWeights: {
      submission: 15,
      coverage: 15,
      growth: 15,
      stock: 15,
      payment: 15,
      infrastructure: 15,
      manpower: 10,
    },
    secondaryTargetCentavos: 1000000,
  };
}
/** @param {any} [over] @param {any} [d] */
async function sync(over = {}, d = a) {
  version++;
  return post(
    admin,
    "master/sync",
    {
      source: "sample",
      sourceKey: `mock-${d.code}`,
      version,
      effectiveFrom: new Date().toISOString(),
      payload: {
        products: [
          {
            productId: sku,
            uom: "CS",
            unitsPerUom: 24,
            priceCentavos: 24000,
            availableBase: 24000,
          },
        ],
        outlets: [{ outletId: store, territoryId: territory }],
        terms: { paymentTerms: "Sample 30 days", deliveryLeadDays: 2 },
        credit: {
          checkedAt: new Date().toISOString(),
          limitCentavos: 100000000,
          exposureCentavos: 10000,
          ageing: { current: 10000 },
        },
        mockSapCustomerCode: `MOCK-${d.code}`,
        schemes: [],
        ...over,
      },
    },
    d.id,
  );
}
/** @param {any} who @param {string} kind @param {boolean} [published] @param {string} [id] */
async function document(who, kind, published = false, id = a.id) {
  return post(
    who,
    "documents",
    {
      kind,
      title: `Sample ${kind}`,
      version: 1,
      base64: Buffer.from(
        "%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF",
      ).toString("base64"),
      published,
    },
    id,
  );
}
/** @param {any} [over] */
function invoice(over = {}) {
  return {
    invoiceNumber: crypto.randomUUID(),
    lineKey: "1",
    revision: 1,
    date: today(),
    kind: "sale",
    originalInvoiceNumber: "",
    outletCode: "SHOP",
    productCode: "SKU",
    locationCode: "WH",
    batch: "B1",
    uom: "CS",
    quantity: 2,
    amountCentavos: 48000,
    previousHash: "",
    ...over,
  };
}
/** @param {any[]} rows @param {any} [who] @param {string} [id] */
async function ingest(rows, who = alice, id = a.id) {
  const staged = await post(
    who,
    "secondary/stage",
    { adapter: "canonical", sourceKey: crypto.randomUUID(), rows },
    id,
  );
  expect(staged.status).toBe(200);
  return post(who, "secondary/process", { runId: staged.body.id }, id);
}
/** @param {string} day @param {number} qty @param {number} [rev] */
async function stock(day, qty, rev = 1) {
  return post(alice, "stock", {
    stockDate: day,
    revision: rev,
    lines: [
      {
        productId: sku,
        locationId: warehouse,
        batch: "B1",
        quantityBase: qty,
        expiry: dayAdd(today(), 10),
      },
      { productId: sku, locationId: van, batch: "B1", quantityBase: 0 },
    ],
  });
}

beforeAll(async () => {
  h = await startHarness({ installers: [org, orders, distributors] });
  const [u] =
    await h.db`insert into org_units(organization_id,code,name,type_code,status,effective_from) values('sunpride','SUNPRIDE','Sunpride','NATIONAL','active','2020-01-01') returning id`;
  unit = u.id;
  admin = await user("super_admin", "office");
  alice = await user("distributor", "alice");
  bob = await user("distributor", "bob");
  reader = await user("distributor", "reader");
  const [p] =
    await h.db`insert into products(code,name,category,uom,unit_price,active,organization_id,quantity_scale) values('SP-SAMPLE','Sample cans','Canned','PC',0,true,'sunpride',1) returning id`;
  sku = p.id;
  const [t] =
    await h.db`insert into territories(organization_id,code,name,status,effective_from,created_by) values('sunpride','SHARED','Shared Cebu','active','2020-01-01',${admin.userId}) returning id`;
  territory = t.id;
  const [s] =
    await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,channel,created_by) values('sunpride','SHARED','Shared retailer','active',${unit},'gt',${admin.userId}) returning id`;
  store = s.id;
  for (const code of ["A", "B"]) {
    const [d] =
      await h.db`insert into distributors(code,name,org_unit_id,status,sap_customer_code,source) values(${code},${`Sample ${code}`},${unit},'accredited',${`MOCK-${code}`},'sample') returning *`;
    if (code === "A") a = d;
    else b = d;
    expect(
      (
        await post(
          admin,
          "invite",
          {
            email: `${code === "A" ? "alice" : "bob"}@distributor.test`,
            name: code,
            grants: [
              "read",
              "order",
              "stock",
              "secondary",
              "claim",
              "finance",
              "documents",
              "dsr",
              "settlement",
            ],
          },
          d.id,
        )
      ).status,
    ).toBe(200);
    const [scope] =
      await h.db`select device_org_unit_id from distributors where id=${d.id}`;
    d.device_org_unit_id = scope.device_org_unit_id;
    expect(
      (await post(admin, "policy", { settings: settings() }, d.id)).status,
    ).toBe(200);
    expect((await sync({}, d)).status).toBe(200);
    for (const code of ["WH", "VAN"]) {
      const x = await post(
        admin,
        "location",
        {
          code,
          name: `Sample ${code}`,
          kind: code === "WH" ? "warehouse" : "van",
        },
        d.id,
      );
      expect(x.status).toBe(200);
      if (d === a) {
        if (code === "WH") warehouse = x.body.id;
        else van = x.body.id;
      }
    }
  }
  expect(
    (
      await post(admin, "invite", {
        email: "reader@distributor.test",
        name: "Reader",
        grants: ["read"],
      })
    ).status,
  ).toBe(200);
  for (const [kind, externalCode, entityId] of [
    ["product", "SKU", sku],
    ["outlet", "SHOP", store],
    ["location", "WH", warehouse],
  ])
    expect(
      (await post(alice, "maps", { kind, externalCode, entityId })).status,
    ).toBe(200);
}, 180000);
afterAll(async () => {
  if (h) await h.close();
}, 180000);

describe("W4 partner boundaries", () => {
  test("F-402 two authentic portal logins see only their own organizations", async () => {
    expect(
      (await api(alice, "distributors")).body.rows.map(
        (/** @type {any} */ x) => x.id,
      ),
    ).toEqual([a.id]);
    expect(
      (await api(bob, "distributors")).body.rows.map(
        (/** @type {any} */ x) => x.id,
      ),
    ).toEqual([b.id]);
    expect((await get(alice, "workspace", b.id)).status).toBe(403);
  });
  test("F-402 partner sessions cannot use employee order reads or exports", async () => {
    for (const path of [
      "orders",
      "orders?format=csv",
      "people/list",
      "catalog/products",
    ])
      expect((await api(alice, path)).status).not.toBe(200);
    const me = await h.fetch("/api/me", { headers: { cookie: alice.cookie } });
    expect((await me.json()).capabilities).toEqual([]);
  });
  test("F-402 partner grants gate every query, command and export family", async () => {
    for (const path of [
      "orders",
      "finance",
      "stock-health",
      "secondary",
      "claims",
      "documents",
      "callflow-config",
      "van-context",
    ])
      expect((await get(reader, path)).status).toBe(403);
    expect(
      (
        await post(reader, "quote", {
          lines: [{ productId: sku, quantity: 1 }],
        })
      ).status,
    ).toBe(403);
    const x = await h.fetch(
      `/api/v1/distributors/orders?distributorId=${b.id}&format=csv`,
      { headers: { cookie: alice.cookie } },
    );
    expect(x.status).toBe(403);
  });
  test("F-402 membership withdrawal is rechecked before idempotent replay", async () => {
    const key = crypto.randomUUID(),
      body = { requestKey: key, lines: [{ productId: sku, quantity: 1 }] };
    expect((await post(alice, "quote", body)).status).toBe(200);
    await h.db`update distributor_users set effective_to=now() where distributor_id=${a.id} and profile_id=${alice.id} and effective_to is null`;
    expect((await post(alice, "quote", body)).status).toBe(403);
    await h.db`insert into distributor_users(distributor_id,profile_id,grants) values(${a.id},${alice.id},${h.db.array(["read", "order", "stock", "secondary", "claim", "finance", "documents", "dsr", "settlement"], "TEXT")})`;
  });
  test("F-402 immutable master replay rejects altered and older versions", async () => {
    const [m] =
      await h.db`select * from distributor_master_versions where distributor_id=${a.id} order by version desc limit 1`;
    const body = {
      source: m.source,
      sourceKey: m.source_key,
      version: Number(m.version),
      effectiveFrom: m.effective_from.toISOString(),
      payload: m.payload,
    };
    expect((await post(admin, "master/sync", body)).body.duplicate).toBe(true);
    expect(
      (
        await post(admin, "master/sync", {
          ...body,
          payload: {
            ...body.payload,
            terms: { paymentTerms: "changed", deliveryLeadDays: 1 },
          },
        })
      ).status,
    ).toBe(409);
  });
  test("F-401 partner invitation uses existing sign-up without employee grants", async () => {
    const email = `new-${crypto.randomUUID()}@test.invalid`;
    const invited = await post(admin, "invite", {
      email,
      name: "New partner clerk",
      grants: ["read", "documents"],
    });
    expect(invited.status).toBe(200);
    const signup = await h.fetch("/api/auth/sign-up", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, name: "New partner clerk" }),
    });
    expect(signup.status).toBe(201);
    const me = await h.fetch("/api/me", {
      headers: {
        cookie: signup.headers.get("set-cookie")?.split(";")[0] ?? "",
      },
    });
    const body = await me.json();
    expect(body.profile.role).toBe("distributor");
    expect(body.capabilities).toEqual([]);
    const [member] =
      await h.db`select profile_id from distributor_users where id=${invited.body.id}`;
    expect(member.profile_id).toBe(invited.body.profileId);
  });
  test("F-402 employee account cannot be adopted as a partner login", async () => {
    expect(
      (
        await post(admin, "invite", {
          email: "office@distributor.test",
          name: "No",
          grants: ["read"],
        })
      ).status,
    ).toBe(409);
  });
});

describe("W4 commercial flow", () => {
  test("F-403 portal quotation uses stock, centavos, terms and mock SAP credit", async () => {
    const q = await post(alice, "quote", {
      lines: [{ productId: sku, quantity: 2 }],
    });
    expect(q.status).toBe(200);
    expect(q.body.totalCentavos).toBe(48000);
    expect(q.body.credit.source).toBe("sample");
    expect(q.body.canConfirm).toBe(true);
  });
  test("F-403 primary PO lands once on canonical orders and lines with acknowledgement/date", async () => {
    const requestKey = crypto.randomUUID(),
      poNumber = crypto.randomUUID(),
      body = { requestKey, poNumber, lines: [{ productId: sku, quantity: 2 }] };
    const x = await post(alice, "orders", body);
    expect(x.status).toBe(200);
    expect(x.body.promised_delivery_date.slice(0, 10)).toBe(dayAdd(today(), 2));
    expect((await post(alice, "orders", body)).body.duplicate).toBe(true);
    const [row] =
      await h.db`select purchasing_distributor_id,total_centavos from orders where id=${x.body.id}`;
    expect(row.purchasing_distributor_id).toBe(a.id);
    expect(Number(row.total_centavos)).toBe(48000);
    const [sum] =
      await h.db`select sum(line_total_centavos)::text as n from order_lines where order_id=${x.body.id}`;
    expect(Number(sum.n)).toBe(48000);
    expect(
      (
        await post(alice, "orders", {
          ...body,
          requestKey: crypto.randomUUID(),
        })
      ).status,
    ).toBe(409);
    expect((await get(bob, "orders", b.id)).body.rows).toHaveLength(0);
  });
  test("F-403 stock is reserved by accepted mock orders, not independently oversold", async () => {
    const q = await post(alice, "orders", {
      poNumber: crypto.randomUUID(),
      lines: [{ productId: sku, quantity: 100000 }],
    });
    expect(q.status).toBe(422);
  });
  test("F-404 breach, stale and unknown SAP credit block confirmation", async () => {
    for (const credit of [
      {
        checkedAt: new Date().toISOString(),
        limitCentavos: 1,
        exposureCentavos: 0,
      },
      {
        checkedAt: "2020-01-01T00:00:00Z",
        limitCentavos: 100000,
        exposureCentavos: 0,
      },
      null,
    ]) {
      expect((await sync({ credit })).status).toBe(200);
      expect(
        (
          await post(alice, "orders", {
            poNumber: crypto.randomUUID(),
            lines: [{ productId: sku, quantity: 1 }],
          })
        ).status,
      ).toBe(422);
    }
    expect((await sync()).status).toBe(200);
  });
  test("F-410 basic schemes use the existing engine with explicit partner eligibility", async () => {
    const [p] =
      await h.db`insert into promotions(organization_id,code,name,rule_kind,rule,status,source,effective_from) values('sunpride','SAMPLE-PARTNER','Sample five percent','percent_off',${{ kind: "percent_off", item: { productId: sku, uom: "CS", quantity: 1 }, percentOffBasisPoints: 500 }},'active','sample','2020-01-01') returning id`;
    expect(
      (
        await sync({
          schemes: [
            {
              promotionId: p.id,
              distributorIds: [a.id],
              channelKeys: ["distributor"],
            },
          ],
        })
      ).status,
    ).toBe(200);
    const q = await post(alice, "quote", {
      lines: [{ productId: sku, quantity: 1 }],
    });
    expect(q.body.totalCentavos).toBe(22800);
    expect(q.body.lines[0].lineTotalCentavos).toBe(22800);
    expect(q.body.schemes[0].applied).toBe(true);
    expect(
      (await sync({ schemes: [{ promotionId: p.id, distributorIds: [b.id] }] }))
        .status,
    ).toBe(200);
    expect(
      (await post(alice, "quote", { lines: [{ productId: sku, quantity: 1 }] }))
        .body.totalCentavos,
    ).toBe(24000);
  });
  test("F-405 complete declarations retain SKU/batch/warehouse/van grain and revisions", async () => {
    expect((await stock(dayAdd(today(), -1), 1000)).status).toBe(200);
    const current = await stock(today(), 1200);
    expect(current.status).toBe(200);
    expect((await stock(today(), 1200)).status).toBe(409);
    expect((await stock(today(), 1200, 2)).status).toBe(200);
    const [n] =
      await h.db`select count(*)::integer as n from distributor_stock_declarations where distributor_id=${a.id} and stock_date=${today()}`;
    expect(n.n).toBe(2);
    expect(
      (
        await post(
          bob,
          "stock",
          {
            stockDate: today(),
            revision: 1,
            lines: [
              {
                productId: sku,
                locationId: warehouse,
                batch: "B1",
                quantityBase: 0,
              },
            ],
          },
          b.id,
        )
      ).status,
    ).toBe(403);
  });
  test("F-405 omitted location or catalog SKU is not silently treated as zero", async () => {
    expect(
      (
        await post(alice, "stock", {
          stockDate: today(),
          revision: 3,
          lines: [
            {
              productId: sku,
              locationId: warehouse,
              batch: "B1",
              quantityBase: 1,
            },
          ],
        })
      ).status,
    ).toBe(422);
  });
});

describe("W4 distributor connectors and immutable facts", () => {
  test("F-412 strict CSV supports quoted identifiers and rejects malformed headers", () => {
    const row = invoice({ invoiceNumber: 'Invoice, "A"' });
    const csv = [
      SECONDARY_HEADERS.join(","),
      SECONDARY_HEADERS.map(
        (k) => `"${String(row[k] ?? "").replaceAll('"', '""')}"`,
      ).join(","),
    ].join("\r\n");
    expect(parseSecondaryCsv(csv)[0].invoiceNumber).toBe('Invoice, "A"');
    expect(() => parseSecondaryCsv("wrong,header\n1,2")).toThrow();
    expect(() =>
      parseSecondaryCsv(SECONDARY_HEADERS.join(",") + '\n"bad'),
    ).toThrow();
  });
  test("F-406 staged invoice lines preserve exact shared outlet attribution", async () => {
    const row = invoice();
    const x = await ingest([row]);
    expect(x.body.posted).toBe(1);
    const [f] =
      await h.db`select * from distributor_secondary_current where distributor_id=${a.id} and invoice_number=${row.invoiceNumber}`;
    expect(f.outlet_id).toBe(store);
    expect(Number(f.quantity_base)).toBe(48);
    expect(Number(f.amount_centavos)).toBe(48000);
    expect((await get(bob, "secondary", b.id)).body.rows).toHaveLength(0);
  });
  test("F-406 file/API retry deduplicates the same invoice-line fact across source keys", async () => {
    const row = invoice();
    expect((await ingest([row])).body.posted).toBe(1);
    expect((await ingest([row])).body.duplicate).toBe(1);
  });
  test("F-406 changed payload needs explicit next revision and previous hash", async () => {
    const row = invoice();
    await ingest([row]);
    expect((await ingest([{ ...row, quantity: 3 }])).body.rejected).toBe(1);
    const [f] =
      await h.db`select * from distributor_secondary_current where distributor_id=${a.id} and invoice_number=${row.invoiceNumber}`;
    expect(
      (
        await ingest([
          { ...row, quantity: 3, revision: 2, previousHash: f.payload_hash },
        ])
      ).body.posted,
    ).toBe(1);
    const facts =
      await h.db`select * from distributor_secondary_lines where invoice_number=${row.invoiceNumber}`;
    expect(facts).toHaveLength(2);
    const current =
      await h.db`select * from distributor_secondary_current where invoice_number=${row.invoiceNumber}`;
    expect(current).toHaveLength(1);
    expect(Number(current[0].quantity_base)).toBe(72);
  });
  test("F-412 mapping queue is correctable without rewriting source rows", async () => {
    const row = invoice({ outletCode: "NEW-SHOP" }),
      s = await post(alice, "secondary/stage", {
        adapter: "canonical",
        sourceKey: crypto.randomUUID(),
        rows: [row],
      });
    expect(
      (await post(alice, "secondary/process", { runId: s.body.id })).body
        .mapping,
    ).toBe(1);
    expect(
      (
        await post(alice, "maps", {
          kind: "outlet",
          externalCode: "NEW-SHOP",
          entityId: store,
        })
      ).status,
    ).toBe(200);
    expect(
      (await post(alice, "secondary/process", { runId: s.body.id })).body
        .posted,
    ).toBe(1);
    const [raw] =
      await h.db`select raw from distributor_staging_lines where run_id=${s.body.id}`;
    expect(raw.raw).toEqual(row);
  });
  test("F-406 partner cannot process another distributor import", async () => {
    const s = await post(alice, "secondary/stage", {
      adapter: "canonical",
      sourceKey: crypto.randomUUID(),
      rows: [invoice()],
    });
    expect(
      (await post(bob, "secondary/process", { runId: s.body.id }, b.id)).status,
    ).toBe(403);
  });
  test("F-406 returned quantities are linked to the original retailer invoice and bounded", async () => {
    const row = invoice({ quantity: 2 });
    await ingest([row]);
    const returned = invoice({
      kind: "return",
      originalInvoiceNumber: row.invoiceNumber,
      quantity: 1,
    });
    expect((await ingest([returned])).body.posted).toBe(1);
    expect(
      (
        await ingest([
          invoice({
            kind: "return",
            originalInvoiceNumber: row.invoiceNumber,
            quantity: 2,
          }),
        ])
      ).body.rejected,
    ).toBe(1);
    expect(
      (
        await ingest([
          invoice({
            kind: "return",
            originalInvoiceNumber: "FOREIGN",
            quantity: 1,
          }),
        ])
      ).body.rejected,
    ).toBe(1);
  });
  test("F-412 nested distributor-system API adapter emits the same canonical line", async () => {
    const row = invoice();
    const staged = await post(alice, "secondary/stage", {
      adapter: "invoice_json",
      sourceKey: crypto.randomUUID(),
      invoices: [
        {
          number: row.invoiceNumber,
          date: row.date,
          retailer: row.outletCode,
          lines: [row],
        },
      ],
    });
    expect(staged.status).toBe(200);
    expect(
      (await post(alice, "secondary/process", { runId: staged.body.id })).body
        .posted,
    ).toBe(1);
  });
});

describe("W4 claims, AR and controlled documents", () => {
  test("F-409 claim intake requires partner-owned evidence and exposes tracking", async () => {
    expect(
      (
        await post(alice, "claims", {
          claimNumber: "NO-EVIDENCE",
          kind: "damage",
          from: today(),
          to: today(),
          amountCentavos: 100,
          reason: "Sample",
          evidenceIds: [],
        })
      ).status,
    ).toBe(422);
    const doc = await document(alice, "claim");
    expect(doc.status).toBe(200);
    const x = await post(alice, "claims", {
      claimNumber: "DAMAGE-1",
      kind: "damage",
      from: today(),
      to: today(),
      amountCentavos: 100,
      reason: "Sample damage",
      evidenceIds: [doc.body.id],
    });
    expect(x.status).toBe(200);
    expect(
      (await get(alice, "claims")).body.rows.some(
        (/** @type {any} */ r) => r.id === x.body.id,
      ),
    ).toBe(true);
    expect(
      (
        await post(
          bob,
          "claims",
          {
            claimNumber: "FOREIGN",
            kind: "damage",
            from: today(),
            to: today(),
            amountCentavos: 100,
            reason: "No",
            evidenceIds: [doc.body.id],
          },
          b.id,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await post(admin, "claims/review", {
          claimId: x.body.id,
          status: "under_review",
          reason: "Checking sample photos",
        })
      ).body.status,
    ).toBe("under_review");
  });
  test("F-414 versioned private documents read back exact bytes and version-bound receipts", async () => {
    const doc = await document(admin, "circular", true);
    expect(doc.status).toBe(200);
    const res = await h.fetch(
      `/api/v1/distributors/documents/${doc.body.id}?distributorId=${a.id}`,
      { headers: { cookie: alice.cookie } },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("%PDF-1.4");
    const denied = await h.fetch(
      `/api/v1/distributors/documents/${doc.body.id}?distributorId=${b.id}`,
      { headers: { cookie: bob.cookie } },
    );
    expect(denied.status).toBe(403);
    expect(
      (
        await post(alice, "documents/read", {
          documentId: doc.body.id,
          sha256: doc.body.sha256,
        })
      ).body.read,
    ).toBe(true);
    const revised = await post(admin, "documents", {
      kind: "circular",
      title: "Sample circular",
      version: 2,
      supersedesId: doc.body.id,
      base64: Buffer.from("%PDF-1.4\nRevision 2\n%%EOF").toString("base64"),
      published: true,
    });
    expect(revised.status).toBe(200);
    const read =
      await h.db`select id from distributor_document_reads where document_id=${revised.body.id}`;
    expect(read).toHaveLength(0);
    expect(
      (
        await post(alice, "documents/read", {
          documentId: revised.body.id,
          sha256: doc.body.sha256,
        })
      ).status,
    ).toBe(422);
  });
  test("F-415 SAP AR replica, advice, matching, dispute and acknowledgement do not rewrite debt", async () => {
    expect(
      (
        await post(admin, "financial/sync", {
          source: "sample",
          version: 1,
          arItems: [
            {
              sourceKey: "AR1",
              invoiceNumber: "PRIMARY-1",
              dueDate: dayAdd(today(), -10),
              balanceCentavos: 10000,
            },
          ],
        })
      ).status,
    ).toBe(200);
    const doc = await document(alice, "deposit");
    const r = await post(alice, "remittances", {
      depositReference: "DEPOSIT-1",
      depositDate: today(),
      amountCentavos: 5000,
      evidenceId: doc.body.id,
    });
    expect(r.status).toBe(200);
    const f = await get(alice, "finance"),
      item = f.body.items[0];
    expect(
      (
        await post(admin, "remittances/match", {
          remittanceId: r.body.id,
          allocations: [{ itemId: item.id, amountCentavos: 5000 }],
        })
      ).body.status,
    ).toBe("acknowledged");
    expect(
      Number((await get(alice, "finance")).body.items[0].balance_centavos),
    ).toBe(10000);
    expect(
      (
        await post(alice, "remittances", {
          depositReference: "DEPOSIT-1",
          depositDate: today(),
          amountCentavos: 5000,
          evidenceId: doc.body.id,
        })
      ).status,
    ).toBe(409);
    const second = await post(alice, "remittances", {
      depositReference: "DEPOSIT-2",
      depositDate: today(),
      amountCentavos: 8000,
      evidenceId: doc.body.id,
    });
    expect(
      (
        await post(admin, "remittances/match", {
          remittanceId: second.body.id,
          allocations: [{ itemId: item.id, amountCentavos: 8000 }],
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await post(alice, "remittances/dispute", {
          remittanceId: second.body.id,
          reason: "Bank reference requires review",
        })
      ).body.status,
    ).toBe("disputed");
  });
  test("F-401 application validates documents, independently assesses credit, binds agreement then requests SAP code", async () => {
    const [d] =
      await h.db`insert into distributors(code,name,org_unit_id,source) values('APPLICANT','Sample applicant',${unit},'sample') returning *`;
    const applicant = await user("distributor", "applicant");
    expect(
      (
        await post(
          admin,
          "invite",
          {
            email: "applicant@distributor.test",
            name: "Applicant",
            grants: ["read", "documents"],
          },
          d.id,
        )
      ).status,
    ).toBe(200);
    expect(
      (await post(admin, "policy", { settings: settings() }, d.id)).status,
    ).toBe(200);
    expect((await sync({}, d)).status).toBe(200);
    expect(
      (
        await post(
          applicant,
          "apply",
          {
            legalName: "Sample legal company",
            taxReference: "SAMPLE-TAX",
            contact: "sample@example.invalid",
          },
          d.id,
        )
      ).status,
    ).toBe(200);
    expect(
      (await post(admin, "application/review", { action: "validate" }, d.id))
        .status,
    ).toBe(422);
    await document(applicant, "registration", false, d.id);
    await document(applicant, "tax", false, d.id);
    expect(
      (await post(admin, "application/review", { action: "validate" }, d.id))
        .body.stage,
    ).toBe("validated");
    expect(
      (
        await post(
          admin,
          "application/review",
          { action: "assess_credit" },
          d.id,
        )
      ).body.stage,
    ).toBe("credit_assessed");
    const agreement = await document(admin, "agreement", true, d.id);
    expect(
      (
        await post(
          applicant,
          "agreement/accept",
          {
            documentId: agreement.body.id,
            sha256: agreement.body.sha256,
            accepted: true,
          },
          d.id,
        )
      ).body.stage,
    ).toBe("agreement");
    expect(
      (
        await post(
          admin,
          "application/review",
          { action: "request_code" },
          d.id,
        )
      ).body.stage,
    ).toBe("accredited");
    const [actual] =
      await h.db`select status,sap_customer_code from distributors where id=${d.id}`;
    expect(actual.status).toBe("accredited");
    expect(actual.sap_customer_code).toBe("MOCK-APPLICANT");
  });
});

describe("W4 health, reconciliation and shared-engine seams", () => {
  test("F-411 DOI reconciles declared stock to net retailer offtake with zero-sales unknown", async () => {
    const incomplete = await get(alice, "stock-health");
    expect(incomplete.body.rows[0].daysOfInventory).toBeNull();
    expect(incomplete.body.offtakeComplete).toBe(false);
    expect(
      (
        await post(alice, "secondary/stage", {
          adapter: "canonical",
          sourceKey: "complete-window",
          rows: [],
          complete: true,
          from: dayAdd(today(), -27),
          to: today(),
        })
      ).status,
    ).toBe(200);
    const hlt = await get(alice, "stock-health");
    expect(hlt.status).toBe(200);
    expect(hlt.body.rows[0].onHandBase).toBe(1200);
    expect(hlt.body.rows[0].daysOfInventory).toBeGreaterThan(0);
    expect(hlt.body.rows[0].nearExpiryBase).toBe(1200);
    const empty = await get(bob, "stock-health", b.id);
    expect(empty.body.stale).toBe(true);
    expect(empty.body.rows).toHaveLength(0);
  });
  test("F-416 exact opening/primary/secondary/closing bridge flags variances and stale explanations", async () => {
    const net =
      await h.db`select coalesce(sum(case when kind='sale' then quantity_base else -quantity_base end),0)::text as n from distributor_secondary_current where distributor_id=${a.id} and product_id=${sku} and sale_date=${today()}`;
    const shipment = 200 + Number(net[0].n);
    expect(
      (
        await post(admin, "financial/sync", {
          source: "sample",
          version: 1,
          complete: true,
          sourceKey: "primary-complete",
          from: today(),
          to: today(),
          movements: [
            {
              sourceKey: "SHIP1",
              date: today(),
              productId: sku,
              quantityBase: shipment,
              kind: "shipment",
            },
          ],
        })
      ).status,
    ).toBe(200);
    const r = await get(alice, `reconciliation?from=${today()}&to=${today()}`);
    expect(r.status).toBe(200);
    expect(r.body.rows[0].varianceBase).toBe(0);
    expect(r.body.rows[0].status).toBe("balanced");
    const line = r.body.rows[0];
    expect(
      (
        await post(alice, "reconciliation/review", {
          from: today(),
          to: today(),
          productId: sku,
          contentHash: line.contentHash,
          explanation: "Sample balanced",
          assignedTo: alice.id,
          status: "accepted",
        })
      ).status,
    ).toBe(200);
    expect((await stock(today(), 1201, 3)).status).toBe(200);
    const changed = await get(
      alice,
      `reconciliation?from=${today()}&to=${today()}`,
    );
    expect(changed.body.rows[0].varianceBase).toBe(1);
    expect(changed.body.rows[0].review.stale).toBe(true);
    const missing = await get(
      bob,
      `reconciliation?from=${today()}&to=${today()}`,
      b.id,
    );
    expect(missing.body.openingPresent).toBe(false);
    expect(missing.body.closingPresent).toBe(false);
  });
  test("F-413 scorecard preserves missing audit as unknown and accepts effective weights", async () => {
    const x = await get(alice, "scorecard");
    expect(x.status).toBe(200);
    expect(x.body.complete).toBe(false);
    expect(x.body.score).toBeNull();
    expect(
      (
        await post(admin, "audit", {
          auditDate: today(),
          infrastructureScore: 80,
          manpowerScore: 90,
          findings: "Sample cold storage and trained clerks",
        })
      ).status,
    ).toBe(200);
    expect((await get(alice, "scorecard")).body.components.infrastructure).toBe(
      80,
    );
    const policy = settings();
    policy.scorecardWeights = {
      submission: 100,
      coverage: 0,
      growth: 0,
      stock: 0,
      payment: 0,
      infrastructure: 0,
      manpower: 0,
    };
    expect((await post(admin, "policy", { settings: policy })).status).toBe(
      200,
    );
    const weighted = await get(alice, "scorecard");
    expect(weighted.body.complete).toBe(true);
    expect(weighted.body.score).toBeCloseTo(
      weighted.body.components.submission,
      10,
    );
    expect(weighted.body.nextAction).toContain("Review submission:");
    expect(weighted.body.nextAction).not.toContain("undefined");
    expect((await post(admin, "policy", { settings: settings() })).status).toBe(
      200,
    );
  });
  test("F-407 DSR server configuration reuses the engine and shared outlet, finance omitted", async () => {
    const x = await get(alice, "callflow-config");
    expect(x.status).toBe(200);
    expect(x.body.engine).toBe("callflow");
    expect(x.body.outlets[0].id).toBe(store);
    expect(x.body.nativeReady).toBe(false);
    expect(x.body).not.toHaveProperty("credit");
    expect((await get(alice, "callflow-config", b.id)).status).toBe(403);
  });
  test("F-408 van adapter exposes only owned vans and refuses to pretend settlement is integrated", async () => {
    const x = await get(alice, "van-context");
    expect(x.body.engine).toBe("van");
    expect(x.body.vans.map((/** @type {any} */ v) => v.id)).toEqual([van]);
    expect(x.body.ready).toBe(false);
  });
});

describe("W4 hardening counterexamples", () => {
  test("F-407 signed core sync uses the partner-only device scope and rechecks empty deltas", async () => {
    const key = await deviceKey(),
      deviceId = await registerDevice(h, {
        profileId: alice.id,
        orgUnitId: a.device_org_unit_id,
        key,
      });
    const signed = await nativeSignIn(
      h,
      "alice@distributor.test",
      password,
      "field-android",
      { keyId: key.keyId, publicKeySpki: key.publicKeySpki },
    );
    expect(signed.res.status).toBe(200);
    const who = { access: signed.body.accessToken, deviceId, key };
    expect((await bind(h, who.access, deviceId, key)).res.status).toBe(200);
    const payload = {
      version: 2,
      scopes: [
        {
          scopeId: a.device_org_unit_id,
          projection: "distributor.bundle",
          params: { distributorId: a.id },
        },
      ],
      limit: 100,
    };
    const snapshot = await signedPost(h, who, "/api/sync/pull", payload);
    expect(snapshot.res.status).toBe(200);
    expect(snapshot.body.bundles[0].data.configuration.distributorId).toBe(
      a.id,
    );
    expect(snapshot.body.bundles[0].data).not.toHaveProperty("credit");
    const nativeMe = await h.fetch("/api/me", {
      headers: {
        authorization: `Bearer ${who.access}`,
        "x-app": "field-android",
        "x-device-key-id": key.keyId,
      },
    });
    expect((await nativeMe.json()).scope.orgUnitIds).toEqual([
      a.device_org_unit_id,
    ]);
    const foreign = await signedPost(h, who, "/api/sync/pull", {
      ...payload,
      scopes: [{ ...payload.scopes[0], params: { distributorId: b.id } }],
    });
    expect(foreign.res.status).toBe(403);
    const delta = await signedPost(h, who, "/api/sync/pull", {
      ...payload,
      since: snapshot.body.nextCursor,
    });
    expect(delta.res.status).toBe(409);
    expect(delta.body.error.code).toBe("rebootstrap_required");
    const [membership] =
      await h.db`select id from distributor_users where distributor_id=${a.id} and profile_id=${alice.id} and effective_to is null`;
    expect(
      (await post(admin, "revoke", { membershipId: membership.id })).status,
    ).toBe(200);
    const denied = await signedPost(h, who, "/api/sync/pull", payload);
    expect(denied.res.status).toBe(403);
    expect(
      (
        await post(admin, "invite", {
          email: "alice@distributor.test",
          name: "Alice",
          grants: [
            "read",
            "order",
            "stock",
            "secondary",
            "claim",
            "finance",
            "documents",
            "dsr",
            "settlement",
          ],
        })
      ).status,
    ).toBe(200);
  });
  test("F-402 office staff are still restricted by the partner supervising unit", async () => {
    const [u] =
      await h.db`insert into org_units(organization_id,code,name,type_code,parent_id,status,effective_from) values('sunpride','OTHER','Other area','REGION',${unit},'active','2020-01-01') returning id`;
    const clerk = await user("operations", "other-area");
    await h.db`update profiles set org_unit_id=${u.id} where id=${clerk.id}`;
    expect((await api(clerk, "distributors")).body.rows).toHaveLength(0);
    expect((await get(clerk, "workspace")).status).toBe(403);
  });
  test("F-406 received facts cannot be edited and source replay survives a changed pack", async () => {
    const row = invoice({ quantity: 2 });
    expect((await ingest([row])).body.posted).toBe(1);
    const [original] =
      await h.db`select * from distributor_secondary_current where distributor_id=${a.id} and invoice_number=${row.invoiceNumber}`;
    await expect(
      Promise.resolve(
        h.db`update distributor_secondary_lines set quantity_base=1 where id=${original.id}`,
      ),
    ).rejects.toThrow();
    expect(
      (
        await sync({
          products: [
            {
              productId: sku,
              uom: "CS",
              unitsPerUom: 12,
              priceCentavos: 12000,
              availableBase: 24000,
            },
          ],
        })
      ).status,
    ).toBe(200);
    expect((await ingest([row])).body.duplicate).toBe(1);
    const returned = invoice({
      kind: "return",
      originalInvoiceNumber: row.invoiceNumber,
      quantity: 1,
    });
    expect((await ingest([returned])).body.posted).toBe(1);
    const [fact] =
      await h.db`select * from distributor_secondary_current where distributor_id=${a.id} and invoice_number=${returned.invoiceNumber}`;
    expect(Number(fact.quantity_base)).toBe(24);
    expect(Number(fact.units_per_uom)).toBe(24);
    expect(
      (
        await ingest([
          {
            ...row,
            revision: 2,
            previousHash: original.payload_hash,
            quantity: 1,
          },
        ])
      ).body.rejected,
    ).toBe(1);
    expect((await sync()).status).toBe(200);
  });
  test("F-405 received declaration quantities and document bytes are append-only", async () => {
    const [line] =
      await h.db`select l.id from distributor_stock_lines l join distributor_stock_declarations d on d.id=l.declaration_id where d.distributor_id=${a.id} limit 1`;
    await expect(
      Promise.resolve(
        h.db`update distributor_stock_lines set quantity_base=1 where id=${line.id}`,
      ),
    ).rejects.toThrow();
    const doc = await document(alice, "claim");
    await expect(
      Promise.resolve(
        h.db`update distributor_documents set content=${Buffer.from("changed")} where id=${doc.body.id}`,
      ),
    ).rejects.toThrow();
  });
  test("F-403 F-404 concurrent confirmation cannot overrun stock or credit after a master refresh", async () => {
    const [pending] =
      await h.db`select coalesce(sum(total_centavos),0)::text as n from orders where purchasing_distributor_id=${a.id} and status not in ('rejected','voided','fulfilled','posted')`;
    expect(
      (
        await sync({
          credit: {
            checkedAt: new Date().toISOString(),
            limitCentavos: Number(pending.n) + 34000,
            exposureCentavos: 10000,
          },
        })
      ).status,
    ).toBe(200);
    const [x, y] = await Promise.all([
      post(alice, "orders", {
        poNumber: crypto.randomUUID(),
        lines: [{ productId: sku, quantity: 1 }],
      }),
      post(alice, "orders", {
        poNumber: crypto.randomUUID(),
        lines: [{ productId: sku, quantity: 1 }],
      }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 422]);
    const before = await get(alice, "credit");
    expect((await sync()).status).toBe(200);
    const after = await get(alice, "credit");
    expect(after.body.exposureCentavos).toBe(before.body.exposureCentavos);
  });
  test("F-416 incomplete source periods never assert a balanced bridge", async () => {
    const x = await get(
      alice,
      `reconciliation?from=${dayAdd(today(), -1)}&to=${dayAdd(today(), -1)}`,
    );
    expect(x.status).toBe(200);
    expect(x.body.feeds.primaryComplete).toBe(false);
    expect(
      x.body.rows.every((/** @type {any} */ r) => r.status === "incomplete"),
    ).toBe(true);
  });
  test("F-412 a source key conflict never mutates staged raw rows", async () => {
    const sourceKey = crypto.randomUUID(),
      row = invoice();
    const first = await post(alice, "secondary/stage", {
      sourceKey,
      adapter: "canonical",
      rows: [row],
    });
    expect(first.status).toBe(200);
    expect(
      (
        await post(alice, "secondary/stage", {
          sourceKey,
          adapter: "canonical",
          rows: [{ ...row, amountCentavos: 1 }],
        })
      ).status,
    ).toBe(409);
    const [retained] =
      await h.db`select raw from distributor_staging_lines where run_id=${first.body.id}`;
    expect(retained.raw).toEqual(row);
  });
});
