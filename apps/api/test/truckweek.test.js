import { test, expect } from "bun:test";
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
import { install as masters } from "../src/domains/masters/index.js";
import {
  install as truckweek,
  mondayOf,
  csv,
  csvRows,
  differenceText,
} from "../src/domains/truckweek/index.js";
import { sha256Hex } from "../src/core/util.js";
import { manilaDate } from "../src/domains/visits/shared.js";

test("mondayOf and csv keep numbers readable", () => {
  expect(mondayOf("2026-11-21")).toBe("2026-11-16");
  expect(mondayOf("2026-11-16")).toBe("2026-11-16");
  expect(mondayOf("2026-11-22")).toBe("2026-11-16");
  expect(csv([["-3", "=SUM(A1)", 'a"b']])).toBe(
    '\ufeff-3,"\'=SUM(A1)","a""b"\r\n',
  );
});

test("SP-0227 weekly truck stock: served basis, sold from van sales, Saturday count with editable reasons", async () => {
  const h = await startHarness({ installers: [org, masters, truckweek] });
  try {
    const unit = crypto.randomUUID();
    await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SUNPRIDE','SAMPLE company','national','active','2020-01-01')`;
    const password = "test-only-truckweek-password";
    /** @type {Record<string,{uid:string,id:string}>} */ const people = {};
    for (const [name, role] of [
      ["seller", "sales"],
      ["office", "admin"],
      ["other", "sales"],
    ]) {
      const uid = await createUser(h, name + "@example.test", password);
      const [p] =
        await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id) values(${uid},${uid},${"SAMPLE " + name},${name + "@example.test"},${role},'active',${unit}) returning id`;
      await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},${role},'2020-01-01','SAMPLE','SAMPLE')`;
      people[name] = { uid, id: p.id };
    }
    const token = "sps_sample_truckweek_office";
    await h.db`insert into sessions(user_id,token_hash,app,expires_at) values(${people.office.uid},${sha256Hex(token)},'web',now()+interval '1 day')`;
    const cookie = "sp_session=" + token;
    /** @param {string} path @param {any} [body] @param {string} [key] */
    async function office(path, body, key = crypto.randomUUID()) {
      const res = await h.fetch("/api/v1/" + path, {
        method: body ? "POST" : "GET",
        headers: {
          cookie,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      return {
        status: res.status,
        text,
        body: res.headers.get("content-type")?.includes("csv")
          ? null
          : JSON.parse(text),
      };
    }
    const [a] =
      await h.db`insert into products(code,name,category,uom,unit_price,active,organization_id) values('SAMPLE-A','SAMPLE corned beef','Canned','PC',0,true,'sunpride') returning id`;
    const [b] =
      await h.db`insert into products(code,name,category,uom,unit_price,active,organization_id) values('SAMPLE-B','SAMPLE meat loaf','Canned','PC',0,true,'sunpride') returning id`;

    // Reasons: seeded five, admin can add, rename, deactivate; change log records it; no hard delete.
    const reasons = await office("masters/stock-reasons");
    expect(reasons.body.rows.map((/** @type {any} */ r) => r.name)).toEqual([
      "Unsold",
      "Expired",
      "Damaged",
      "Missing",
      "Returned by customer",
    ]);
    const added = await office("masters/reference/stock-reason-save", {
      name: "SAMPLE spoiled in heat",
      reason: "SAMPLE office request",
    });
    expect(added.status).toBe(200);
    const list = (await office("masters/stock-reasons")).body.rows;
    const extra = list.find((/** @type {any} */ r) => r.id === added.body.id);
    const renamed = await office("masters/reference/stock-reason-save", {
      id: extra.id,
      name: "SAMPLE heat damage",
      active: false,
      baseUpdatedAt: extra.updatedAt,
      reason: "SAMPLE rename and retire",
    });
    expect(renamed.status).toBe(200);
    const log = await office("masters/reference-log?kind=stock_reason");
    expect(log.body.rows.map((/** @type {any} */ r) => r.label)).toEqual([
      "SAMPLE heat damage",
      "SAMPLE spoiled in heat",
    ]);
    let deleted = true;
    try {
      await h.db`delete from truck_stock_reasons where id=${extra.id}`;
    } catch {
      deleted = false;
    }
    expect(deleted).toBe(false);
    const missing = list.find((/** @type {any} */ r) => r.name === "Missing");
    const unsold = list.find((/** @type {any} */ r) => r.name === "Unsold");
    expect(unsold).toBeDefined();

    // Office records request vs served for the seller's week.
    const day = manilaDate(Date.now());
    const week = mondayOf(day);
    const bad = await office("truck-weeks/save", {
      salespersonProfileId: people.seller.id,
      weekStart: day === week ? manilaDate(Date.now() + 86400000) : day,
      lines: [{ productId: a.id, requestedBase: 1, servedBase: 1 }],
    });
    expect(bad.status).toBe(422);
    const truck = crypto.randomUUID(),
      depot = crypto.randomUUID(),
      vehicle = crypto.randomUUID(),
      trip = crypto.randomUUID();
    const t = h.db;
    for (const [id, type] of [
      [truck, "truck"],
      [depot, "warehouse"],
    ])
      await t`insert into inventory_locations(id,organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values (${id},'sunpride',${unit},'CEB',${id},${"SAMPLE " + type},${type},true,true,true,true,false)`;
    await t`insert into vehicles(id,organization_id,org_unit_id,vehicle_code,plate_number,truck_location_id,home_location_id,status,created_by) values (${vehicle},'sunpride',${unit},${vehicle},'SAMPLE',${truck},${depot},'active','fixture')`;
    await t`insert into van_trips(id,organization_id,org_unit_id,trip_number,vehicle_id,truck_location_id,source_location_id,service_date,salesperson_profile_id,salesperson_subject,status,created_by)
      values(${trip},'sunpride',${unit},'SAMPLE-T1',${vehicle},${truck},${depot},${week},${people.seller.id},'s','closed','fixture')`;
    // This is an explicit persisted approval fixture, not a proof of the approval workflow.
    const plan = crypto.randomUUID();
    await t`insert into coverage_plans(id,organization_id,assignee_profile_id,local_month,version,cycle_type,org_unit_id,requested_from,requested_to,effective_from,effective_to,status,prepared_by,prepared_at,content_revision,created_by,updated_by,approval_signature,content_hash)
      values(${plan},'sunpride',${people.seller.id},${week.slice(0, 7)},1,'monthly',${unit},'2020-01-01','2030-01-01','2020-01-01','2030-01-01','approved','SAMPLE',now(),1,'SAMPLE','SAMPLE','SAMPLE-signature','SAMPLE-hash')`;
    for (const product of [a, b]) {
      const payload = {
        data: {
          productCode: product.id === a.id ? "SAMPLE-A" : "SAMPLE-B",
          uom: "PC",
          unitPriceCentavos: 2500,
          precedence: 1,
          taxInclusive: true,
          taxBasisPoints: 0,
          taxCode: "SAMPLE-EXEMPT",
        },
      };
      await t`insert into sap_replicas(organization_id,master_id,kind,sap_key,sap_version,payload,effective_from,source,payload_hash) values('sunpride',${product.id},'condition',${product.id},1,${payload},'2020-01-01','sample','SAMPLE')`;
    }
    const saveKey = crypto.randomUUID();
    const saveBody = {
      salespersonProfileId: people.seller.id,
      weekStart: week,
      vehicleId: vehicle,
      tripIds: [trip],
      lines: [
        { productId: a.id, requestedBase: 100, servedBase: 80 },
        { productId: b.id, requestedBase: 20, servedBase: 20 },
      ],
    };
    await t`update coverage_plans set status='draft' where id=${plan}`;
    expect((await office("truck-weeks/save", saveBody)).status).toBe(400);
    await t`update coverage_plans set status='approved' where id=${plan}`;
    await t`update van_trips set salesperson_profile_id=${people.other.id} where id=${trip}`;
    expect((await office("truck-weeks/save", saveBody)).status).toBe(400);
    await t`update van_trips set salesperson_profile_id=${people.seller.id} where id=${trip}`;
    const saves = await Promise.all([
      office("truck-weeks/save", saveBody, saveKey),
      office("truck-weeks/save", saveBody, saveKey),
    ]);
    const saved = saves[0];
    expect(saves[1].body.id).toBe(saved.body.id);
    expect(saved.status).toBe(200);
    expect((await office("truck-weeks/save", saveBody, saveKey)).body.id).toBe(
      saved.body.id,
    );
    expect(
      (await office("truck-weeks/save", { ...saveBody, lines: [] }, saveKey))
        .status,
    ).toBe(409);

    // Sales recorded through the existing van records during the week.
    {
      const [approval] =
        await t`insert into van_approval_codes(trip_id,kind,facts_hash,facts,issuer_profile_id,issuer_name) values(${trip},'void','x',${{}},${people.office.id},'SAMPLE') returning id`;
      for (const [n, q, voided] of [
        [1, 50, false],
        [2, 5, true],
      ]) {
        const sale = crypto.randomUUID();
        await t`insert into van_sales(id,trip_id,receipt_number,total_centavos,receipt,captured_request) values(${sale},${trip},${"SAMPLE-R" + n},0,${{}},${{}})`;
        await t`insert into van_sale_lines(sale_id,ordinal,product_id,quantity_base,total_centavos,facts) values(${sale},1,${a.id},${q},0,${{}})`;
        if (voided)
          await t`insert into van_sale_voids(sale_id,trip_id,reason,approval_id) values(${sale},${trip},'SAMPLE',${approval.id})`;
      }
      const ret = crypto.randomUUID();
      await t`insert into van_returns(id,trip_id,return_number,captured_request) values(${ret},${trip},'SAMPLE-RET',${{}})`;
      await t`insert into van_return_lines(return_id,ordinal,product_id,quantity_base,stock_status,facts) values(${ret},1,${a.id},2,'available',${{}})`;
    }

    // A second trip for this SAME seller/date is not part of this request.
    const unlinked = crypto.randomUUID(),
      unlinkedSale = crypto.randomUUID();
    await t`insert into van_trips(id,organization_id,org_unit_id,trip_number,vehicle_id,truck_location_id,source_location_id,service_date,salesperson_profile_id,salesperson_subject,status,created_by)
      values(${unlinked},'sunpride',${unit},'SAMPLE-UNLINKED',${vehicle},${truck},${depot},${week},${people.seller.id},'s','closed','fixture')`;
    await t`insert into van_sales(id,trip_id,receipt_number,total_centavos,receipt,captured_request) values(${unlinkedSale},${unlinked},'SAMPLE-UNLINKED-R',999999,${{}},${{}})`;
    await t`insert into van_sale_lines(sale_id,ordinal,product_id,quantity_base,total_centavos,facts) values(${unlinkedSale},1,${a.id},100,999999,${{}})`;

    // Field app: signed own bundle shows served stock and active reasons only.
    const key = await deviceKey();
    const deviceId = await registerDevice(h, {
      profileId: people.seller.id,
      orgUnitId: unit,
      key,
    });
    const login = await nativeSignIn(
      h,
      "seller@example.test",
      password,
      "field-android",
      {
        keyId: key.keyId,
        publicKeySpki: key.publicKeySpki,
      },
    );
    const access = login.body.accessToken;
    expect((await bind(h, access, deviceId, key)).body.bindingStatus).toBe(
      "bound",
    );
    const me = await (
      await h.fetch("/api/me", {
        headers: {
          authorization: "Bearer " + access,
          "x-app": "field-android",
          "x-device-key-id": key.keyId,
        },
      })
    ).json();
    const who = { access, deviceId, key };
    const pulled = await signedPost(h, who, "/api/sync/pull", {
      version: 2,
      app: "field-android",
      deviceId,
      since: null,
      pageCursor: null,
      scopes: [
        {
          scopeId: me.scope.id,
          projection: "field.truckweek",
          params: { serviceDate: day },
        },
      ],
      limit: 128,
    });
    expect(pulled.res.status).toBe(200);
    const bundle = pulled.body.bundles[0].data;
    expect(bundle.week.id).toBe(saved.body.id);
    const lineA = bundle.week.lines.find(
      (/** @type {any} */ l) => l.productId === a.id,
    );
    expect(lineA).toMatchObject({
      requestedBase: 100,
      servedBase: 80,
      shortfallBase: 20,
      soldBase: 48,
      expectedLeftBase: 32,
    });
    expect(bundle.reasons.map((/** @type {any} */ r) => r.name)).not.toContain(
      "SAMPLE heat damage",
    );

    /** @param {any} payload @param {string} [id] */
    async function push(payload, id = crypto.randomUUID(), at = Date.now()) {
      const r = await signedPost(h, who, "/api/sync/push", {
        version: 2,
        app: "field-android",
        deviceId,
        scopeId: me.scope.id,
        operations: [
          {
            clientOpId: id,
            opType: "truckweek.capture",
            clientTime: at,
            dependsOn: [],
            payload,
          },
        ],
      });
      expect(r.res.status).toBe(200);
      return r.body.results[0];
    }
    expect(
      (
        await push({
          weekId: saved.body.id,
          lines: [{ productId: a.id, countedBase: 30 }],
        })
      ).status,
    ).toBe("rejected");
    const countId = crypto.randomUUID();
    const count = {
      weekId: saved.body.id,
      deviceTime: Date.now(),
      lines: [
        {
          productId: a.id,
          countedBase: 30,
          reasonId: missing.id,
          note: "SAMPLE two short",
        },
        // Balanced with stock left: no reason needed (SP-0227 QA).
        { productId: b.id, countedBase: 20, reasonId: null },
      ],
    };
    const at = Date.now();
    expect((await push(count, countId, at)).status).toBe("applied");
    expect((await push(count, countId, at)).status).toBe("duplicate");

    const detail = await office(`truck-weeks?id=${saved.body.id}`);
    expect(detail.body.status).toBe("counted");
    expect(detail.body.pos.invoicesMinor).toBe("0");
    await t`update van_trips set status='active' where id=${trip}`;
    expect(
      (
        await office("truck-weeks/review", {
          id: saved.body.id,
          baseUpdatedAt: detail.body.updatedAt,
        })
      ).status,
    ).toBe(422);
    await t`update van_trips set status='closed' where id=${trip}`;
    // Actually served 100 - counted 50 = 50 units at PHP25; requested 120 is not the basis.
    expect(detail.body.cashier.amountMinor).toBe("125000");
    expect(
      detail.body.lines.find((/** @type {any} */ l) => l.productId === a.id)
        .accountableMinor,
    ).toBe("125000");
    for (const kind of ["request", "loading", "count", "cashier"]) {
      const print = await h.fetch(
        `/api/v1/truck-weeks?id=${saved.body.id}&format=print&report=${kind}`,
        { headers: { cookie } },
      );
      expect(print.status).toBe(200);
      expect(print.headers.get("content-security-policy")).toContain(
        "default-src 'none'",
      );
      const html = await print.text();
      expect(html).toContain("QUANTITY RECORD ONLY");
      expect(html).toContain("SAMPLE-T1");
      if (kind === "cashier") {
        expect(html).toContain("PHP 1250.00");
        if (process.env.SP_REPORT_PROOF_PATH)
          await Bun.write(process.env.SP_REPORT_PROOF_PATH, html);
      }
    }
    const rA = detail.body.lines.find(
      (/** @type {any} */ l) => l.productId === a.id,
    );
    expect(rA).toMatchObject({
      servedBase: 80,
      soldBase: 48,
      countedBase: 30,
      varianceBase: 2,
      reasonName: "Missing",
    });
    expect(detail.body.totals).toMatchObject({
      servedBase: 100,
      soldBase: 48,
      countedBase: 50,
      varianceBase: 2,
      missingReasons: 0,
    });

    expect(
      (
        await h.fetch(
          `/api/v1/truck-weeks?id=${saved.body.id}&format=print&report=cashier`,
        )
      ).status,
    ).toBe(401);
    const csvAll = await office(`truck-weeks?weekStart=${week}&format=csv`);
    expect(csvAll.status).toBe(200);
    expect(csvAll.text).toContain("Counted, office to check");
    expect(csvAll.text).not.toMatch(/,"?counted"?,/);
    expect(csvAll.text).toContain(
      '"SAMPLE corned beef","PC",100,80,20,48,32,30,"2 missing","Missing","SAMPLE two short"',
    );
    expect(csvAll.text).toContain(
      '"Requested","Loaded","Short","Sold","Should be left","Counted","Difference"',
    );

    // Office review closes the week; the generic own-seller bundle above did not infer other trips.
    const listed = await office(`truck-weeks?weekStart=${week}`);
    expect(listed.body.rows).toHaveLength(1);
    expect(listed.body.sellers.map((/** @type {any} */ s) => s.name)).toContain(
      "SAMPLE other",
    );
    const reviewed = await office("truck-weeks/review", {
      id: saved.body.id,
      baseUpdatedAt: detail.body.updatedAt,
    });
    expect(reviewed.status).toBe(200);
    const frozen = await office(`truck-weeks?id=${saved.body.id}`);
    await t`update products set name='RENAMED' where id=${a.id}`;
    await t`update sap_replicas set payload=jsonb_set(payload,'{data,unitPriceCentavos}','9999') where kind='condition'`;
    expect((await office(`truck-weeks?id=${saved.body.id}`)).body).toEqual(
      frozen.body,
    );
    const events =
      await t`select kind from truck_week_report_events where week_id=${saved.body.id} order by created_at,id`;
    expect(events.map((/** @type {any} */ e) => e.kind)).toEqual([
      "request_saved",
      "counted",
      "reviewed",
    ]);
    expect((await push({ ...count, deviceTime: Date.now() })).status).toBe(
      "rejected",
    );
    const after = await office(`truck-weeks?id=${saved.body.id}`);
    expect(
      (
        await office("truck-weeks/save", {
          ...saveBody,
          baseUpdatedAt: after.body.updatedAt,
        })
      ).status,
    ).toBe(422);
  } finally {
    await h.close();
  }
});

test("SP-0227 CSV uses the screen's words; sold-but-not-loaded goes to the office", () => {
  const rows = csvRows({
    weekStart: "2026-11-16",
    seller: "S",
    status: "counted",
    lines: [
      { code: "A", name: "A", uom: "PC", requestedBase: 10, servedBase: 8, shortfallBase: 2, soldBase: 32, expectedLeftBase: -24, countedBase: 3, varianceBase: -27, reasonName: "Damaged", needsReason: false },
      { code: "B", name: "B", uom: "PC", requestedBase: 0, servedBase: 0, shortfallBase: 0, soldBase: 5, expectedLeftBase: -5, countedBase: 0, varianceBase: -5, reasonName: null, needsReason: false, notLoaded: true },
    ],
  });
  expect(rows[0][12]).toBe("27 extra");
  expect(rows[1][13]).toBe("Sold but not loaded — check loading");
  expect(differenceText(4)).toBe("4 missing");
  expect(differenceText(0)).toBe("Balanced");
});
