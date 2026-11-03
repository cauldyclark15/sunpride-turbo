import { afterAll, beforeAll, expect, test } from "bun:test";
import { seedDemo } from "./index.js";
import { copyTrialRow } from "./trial-wiring.js";
import { rowId } from "./store.js";
import {
  applyKickoffVan,
  KickoffVanConflict,
  loadDomain,
  manilaDate,
  planKickoffVan,
} from "./kickoff-van.js";
import { domainInstallers } from "../../../apps/api/src/domains/index.js";
import { ingestMaster } from "../../../apps/api/src/domains/integration/replicas.js";
import { sampleMaster } from "../../../apps/sap-mock/src/sample.js";
import {
  bind,
  deviceKey,
  nativeSignIn,
  signedPost,
  startHarness,
} from "../../../apps/api/test/harness.js";

/**
 * Additive-safety proof for `kickoff-van.js` on a DISPOSABLE harness database (never live): every refusal is proven with a
 * whole-state fingerprint (trips, loads, command ledger, audit, fiscal rows, markers, stock, identities) taken before and
 * after BOTH the dry run and the apply. The success paths (mixed fiscal, replay, progressed trip) run last, in order.
 * Fiscal ranges cannot be deleted through the product (guard trigger), so this disposable DB truncates its fiscal tables
 * between scenarios; nothing of the sort exists in the helper.
 */
/** @type {import('../../../apps/api/test/harness.js').Harness} */ let h;
const PASSWORD = "kickoff-van-safety-password";
const now = Date.now();
const today = manilaDate(now);
const DAY = 86_400_000;
const SELLER = "van@sunpride.test";
const OPEN = [
  "planned",
  "loading",
  "loaded",
  "active",
  "closing",
  "reconciling",
  "review_required",
];
/** @type {any} */ let seller;
/** @type {any} */ let veh;
/** @type {any} */ let admin;
/** @type {any} */ let device;
/** @type {any} */ let real;
/** @type {any} */ let otherDeviceId;
const codes = (/** @type {any} */ r) =>
  r.conflicts.map((/** @type {any} */ c) => c.code);
const opts = () => ({
  sellerProfileId: seller.id,
  now,
  date: today,
  withFiscalSample: true,
});
const TABLES = [
  "van_trips",
  "van_trip_loads",
  "van_trip_load_lines",
  "van_web_commands",
  "van_audit_events",
  "fiscal_registrations",
  "fiscal_series",
  "fiscal_allocations",
  "fiscal_tender_rules",
  "fiscal_audit_events",
  "sample_data_rows",
  "inventory_balances",
  "inventory_lot_balances",
  "profiles",
  "employee_assignments",
  "registered_devices",
  "vehicles",
  "inventory_locations",
];

async function snap() {
  /** @type {Record<string,string>} */ const out = {};
  for (const t of TABLES)
    out[t] = (
      await h.db.unsafe(
        `select md5(coalesce(string_agg(to_jsonb(x)::text,'|' order by to_jsonb(x)::text),'')) as h, count(*)::int as n from ${t} x`,
      )
    )[0].h;
  return out;
}
/** @param {string} table @param {string} id @param {() => Promise<any>} fn */
async function withoutMarker(table, id, fn) {
  const rows =
    await h.db`select batch,table_name,row_id,key,id from sample_data_rows where table_name=${table} and row_id=${id}`;
  expect(rows.length).toBe(1);
  await h.db`delete from sample_data_rows where table_name=${table} and row_id=${id}`;
  try {
    return await fn();
  } finally {
    await h.db`insert into sample_data_rows(id,batch,table_name,row_id,key) values(${rows[0].id},${rows[0].batch},${rows[0].table_name},${rows[0].row_id},${rows[0].key})`;
  }
}
/** Dry run AND apply must both refuse with `code`, and neither may write one byte.
 * @param {any} options @param {string} code @param {any} [deps] */
async function refuses(options, code, deps) {
  const before = await snap();
  const plan = await planKickoffVan(h.db, options, deps);
  expect(plan.ok).toBe(false);
  expect(codes(plan)).toContain(code);
  /** @type {any} */ let err;
  try {
    await applyKickoffVan(h.db, options, deps);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(KickoffVanConflict);
  expect(codes(err.report)).toContain(code);
  expect(await snap()).toEqual(before);
  return { plan, report: err.report };
}
async function resetFiscal() {
  await h.db`truncate fiscal_series, fiscal_registrations cascade`;
  await h.db`delete from fiscal_tender_rules`;
  await h.db`delete from sample_data_rows where batch='sunpride-fiscal-sample'`;
}
/** @param {{type?:string, vehicleId?:string|null, prefix:string, status?:string, sample?:boolean, to?:Date|null, deviceId?:string|null, seriesFrom?:Date|string, next?:number, last?:number, noSeries?:boolean}} p */
async function insertFiscal(p) {
  const type = p.type ?? "sales_invoice";
  const sample = p.sample ?? true;
  const [reg] =
    await h.db`insert into fiscal_registrations(org_unit_id,entity_name,branch_name,tin,address,device_id,document_type,status,effective_from,effective_to,entered_by,sample,tax_basis_points)
    values(${seller.org_unit_id},'KVT existing','KVT','KVT-TIN','KVT address',${p.deviceId ?? null},${type},${p.status ?? "sample_not_filed"},'2026-01-01',${p.to ?? null},${admin.id},${sample},1200) returning id`;
  if (!p.noSeries)
    await h.db`insert into fiscal_series(registration_id,vehicle_id,prefix,first_serial,last_serial,next_allocate,effective_from) values(${reg.id},${p.vehicleId ?? null},${p.prefix},1,${p.last ?? 999999},${p.next ?? 1},${p.seriesFrom ?? "2026-01-01"})`;
  return reg.id;
}
const insertCash = (
  /** @type {{enabled?:boolean, from?:Date|string, to?:Date|null, method?:string}} */ p = {},
) =>
  h.db`insert into fiscal_tender_rules(org_unit_id,method,label,enabled,effective_from,effective_to,sample,entered_by) values(${seller.org_unit_id},${p.method ?? "cash"},'Cash',${p.enabled ?? true},${p.from ?? "2026-01-01"},${p.to ?? null},false,${admin.id})`;
const trip = (
  /** @type {{date:string, vehicleId:string, profileId:string, status?:string, n:string}} */ p,
) =>
  h.db`insert into van_trips(organization_id,org_unit_id,trip_number,vehicle_id,truck_location_id,source_location_id,service_date,salesperson_profile_id,salesperson_subject,status,created_by)
    select organization_id,org_unit_id,${p.n},id,truck_location_id,home_location_id,${p.date},${p.profileId},(select user_id from profiles where id=${p.profileId}),${p.status ?? "planned"},'someone-else' from vehicles where id=${p.vehicleId} returning id`;
const spy = () => {
  const calls = { actor: 0, command: 0 };
  return {
    calls,
    domain: {
      ...real,
      actorFor: (/** @type {any} */ p) => (calls.actor++, real.actorFor(p)),
      command: (/** @type {any[]} */ ...a) => (
        calls.command++,
        real.command(...a)
      ),
    },
  };
};

beforeAll(async () => {
  h = await startHarness({ installers: domainInstallers });
  await seedDemo(h.db, {
    anchorDate: manilaDate(now - 90 * 86_400_000),
    days: 7,
  });
  real = await loadDomain();
  [seller] =
    await h.db`select id,user_id,email,org_unit_id from profiles where email=${SELLER}`;
  [admin] =
    await h.db`select id,user_id,org_unit_id from profiles where email='admin@sunpride.test'`;
  const [vehicle] =
    await h.db`select * from vehicles where org_unit_id=${seller.org_unit_id} and vehicle_code='SMP-VAN-1'`;
  const [loc] =
    await h.db`select * from inventory_locations where id=${vehicle.truck_location_id}`;
  const truck = await copyTrialRow(h.db, "inventory_locations", loc, "kvsafe", {
    code: "SMP-TRIAL-KVSAFE",
    name: "Sample trial truck kvsafe",
    org_unit_id: seller.org_unit_id,
  });
  await copyTrialRow(h.db, "vehicles", vehicle, "kvsafe", {
    vehicle_code: "SMP-TRIAL-KVSAFE",
    plate_number: "TRIAL-KVSAFE",
    name: "Sample trial truck kvsafe",
    truck_location_id: truck.id,
    org_unit_id: seller.org_unit_id,
  });
  [veh] =
    await h.db`select * from vehicles where vehicle_code='SMP-TRIAL-KVSAFE'`;
  const stocked =
    await h.db`select p.code from inventory_balances b join products p on p.id=b.product_id where b.location_id=${vehicle.home_location_id} and b.physical_base>=24 order by p.code limit 3`;
  for (const [i, p] of stocked.entries())
    await ingestMaster(
      h.db,
      sampleMaster("condition", `KVS-PRICE-${i}`, {
        productCode: p.code,
        uom: "PC",
        customerCode: null,
        channelKey: null,
        unitPriceCentavos: 1000 + i * 100,
        currency: "PHP",
        taxCode: "SAMPLE-VAT",
        taxBasisPoints: 1200,
        taxInclusive: true,
        priceListCode: "KVS-SAP-CONTROL",
        precedence: 1,
      }),
    );
  await h.db`update users set password_hash=${await Bun.password.hash(PASSWORD, { algorithm: "argon2id" })} where email=${SELLER}`;
  const phone = await deviceKey();
  const signIn = await nativeSignIn(h, SELLER, PASSWORD, "van-android", {
    keyId: phone.keyId,
    publicKeySpki: phone.publicKeySpki,
  });
  expect(signIn.res.status).toBe(200);
  const [row] =
    await h.db`select id from registered_devices where profile_id=${seller.id} and app='van-android'`;
  expect(
    (await bind(h, signIn.body.accessToken, row.id, phone)).body.bindingStatus,
  ).toBe("bound");
  device = {
    access: signIn.body.accessToken,
    deviceId: row.id,
    key: phone,
    app: "van-android",
    userId: seller.user_id,
  };
  // The plain seed leaves this seller a stale ACTIVE trip; the fixture refuses any open trip, so retire it in this disposable DB.
  await h.db`update van_trips set status='closed' where salesperson_profile_id=${seller.id} and status in ${h.db(OPEN)}`;
  // A second registered device (another profile) to prove a device-bound registration is not usable by the seller's phone.
  const [other] =
    await h.db`select id from profiles where email='field4@sunpride.test'`;
  const otherKey = await deviceKey();
  [{ id: otherDeviceId }] =
    await h.db`insert into registered_devices(profile_id,app,platform,inventory_tag,public_key_spki,key_id,status) values(${other.id},'van-android','android','KVS-OTHER-DEVICE',${otherKey.publicKeySpki},${otherKey.keyId},'revoked') returning id`;
}, 240_000);
afterAll(async () => {
  await h?.close();
});

// ------------------------------------------------------------------------------------------------ F2: dates and open trips
test("F2: only today (Manila) is accepted; syntax is still checked; past/future/far-future write nothing", async () => {
  await expect(
    planKickoffVan(h.db, { ...opts(), date: "2026-02-30" }),
  ).rejects.toThrow("real YYYY-MM-DD");
  await expect(
    planKickoffVan(h.db, { ...opts(), date: "tomorrow" }),
  ).rejects.toThrow("real YYYY-MM-DD");
  expect(
    (
      await refuses(
        { ...opts(), date: manilaDate(now + DAY) },
        "date_not_current_day",
      )
    ).plan.conflicts,
  ).toHaveLength(1);
  await refuses(
    { ...opts(), date: manilaDate(now + 14 * DAY) },
    "date_not_current_day",
  );
  await refuses({ ...opts(), date: "2099-01-01" }, "date_not_current_day");
  await refuses({ ...opts(), date: manilaDate(now - DAY) }, "date_in_past");
});
test("F8: a real selected load x route that the phone could never download is refused before any write; historical zero truck rows are not counted", async () => {
  const [route] =
    await h.db`select r.id from route_salespeople s join routes r on r.id=s.route_id where s.profile_id=${seller.id} and s.deleted_at is null and s.effective_to is null`;
  const onRoute = async () =>
    (
      await h.db`select count(*)::int n from outlets o join outlet_assignments a on a.outlet_id=o.id and a.deleted_at is null and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now()) where a.route_id=${route.id} and o.status='active' and o.deleted_at is null`
    )[0].n;
  const outlets0 = await onRoute();
  // (a) 40 historical ALL-ZERO truck rows must not change the verdict (the bundle does not count them either)
  const dead =
    await h.db`insert into inventory_balances(product_code,warehouse_code,on_hand,reserved,available,as_of,organization_id,product_id,location_id,physical_base,available_stock_base,reserved_base,available_base,quality_hold_base,damaged_base,in_transit_base)
    select p.code,'TRUCK',0,0,0,now(),p.organization_id,p.id,${veh.truck_location_id},0,0,0,0,0,0,0 from products p where p.active order by p.code limit 40 returning id`;
  expect(dead).toHaveLength(40);
  try {
    const ok = await planKickoffVan(h.db, opts());
    expect(codes(ok)).not.toContain("van_projection_too_large");
    expect(codes(ok)).not.toContain("no_dedicated_empty_vehicle");
    expect(ok.ok).toBe(true);
    expect(ok.products).toHaveLength(3);
    // (b) enough extra sample outlets on the route that 3 chosen products x outlets > 600 price lines
    const [src] =
      await h.db`select o.* from outlets o join outlet_assignments a on a.outlet_id=o.id where a.route_id=${route.id} and o.status='active' and o.deleted_at is null order by o.code limit 1`;
    const [srcAssign] =
      await h.db`select * from outlet_assignments where outlet_id=${src.id} and route_id=${route.id} and deleted_at is null limit 1`;
    const extra = Math.floor(600 / 3) + 1 - outlets0;
    expect(extra).toBeGreaterThan(0);
    try {
      for (let i = 0; i < extra; i++) {
        const added = await copyTrialRow(
          h.db,
          "outlets",
          src,
          `kvsguard-${i}`,
          {
            code: `KVSG-${i}`,
            name: `Sample guard outlet ${i}`,
          },
        );
        await copyTrialRow(
          h.db,
          "outlet_assignments",
          srcAssign,
          `kvsguard-a${i}`,
          {
            outlet_id: added.id,
            sequence: 1000 + i,
          },
        );
      }
      expect(await onRoute()).toBe(201);
      const { plan, report } = await refuses(
        opts(),
        "van_projection_too_large",
      );
      for (const r of [plan, report]) {
        const c = r.conflicts.find(
          (/** @type {any} */ x) => x.code === "van_projection_too_large",
        );
        expect(c.detail).toMatchObject({
          products: 3,
          outlets: 201,
          priceLines: 603,
        });
      }
    } finally {
      await h.db`delete from outlet_assignments where id in (select row_id::uuid from sample_data_rows where table_name='outlet_assignments' and key like 'outlet_assignments:trial-kvsguard-a%')`;
      await h.db`delete from outlets where id in (select row_id::uuid from sample_data_rows where table_name='outlets' and key like 'outlets:trial-kvsguard-%')`;
      await h.db`delete from sample_data_rows where key like 'outlets:trial-kvsguard-%' or key like 'outlet_assignments:trial-kvsguard-a%'`;
    }
    expect(await onRoute()).toBe(outlets0);
  } finally {
    await h.db`delete from inventory_balances where id in ${h.db(dead.map((/** @type {any} */ r) => r.id))}`;
  }
});

test("F2: ANY open trip of the seller or of the vehicle, on ANY date, refuses with zero writes", async () => {
  const [vanOne] =
    await h.db`select id from vehicles where vehicle_code='SMP-VAN-1'`;
  for (const [label, date] of /** @type {const} */ ([
    ["prior", manilaDate(now - 9 * DAY)],
    ["future", manilaDate(now + 9 * DAY)],
    ["far-future", "2099-01-01"],
  ])) {
    // (1) seller open trip on ANOTHER vehicle
    const [t1] = await trip({
      date,
      vehicleId: vanOne.id,
      profileId: seller.id,
      n: `KVS-SELLER-${label}`,
    });
    const r1 = await refuses(opts(), "seller_has_open_trip");
    expect(
      r1.plan.conflicts.find(
        (/** @type {any} */ c) => c.code === "seller_has_open_trip",
      ).detail.serviceDate,
    ).toBe(date);
    await h.db`delete from van_trips where id=${t1.id}`;
    // (2) another seller's open trip on THIS vehicle
    const [t2] = await trip({
      date,
      vehicleId: veh.id,
      profileId: admin.id,
      n: `KVS-VEHICLE-${label}`,
    });
    const r2 = await refuses(opts(), "no_dedicated_empty_vehicle");
    expect(
      r2.plan.excludedVehicles.find(
        (/** @type {any} */ v) => v.code === "SMP-TRIAL-KVSAFE",
      ).why,
    ).toEqual(
      expect.arrayContaining([
        "vehicle_has_open_trip",
        "vehicle_used_by_another_seller",
      ]),
    );
    await h.db`delete from van_trips where id=${t2.id}`;
    // (3) the seller's own open trip on THIS vehicle: both refusals
    const [t3] = await trip({
      date,
      vehicleId: veh.id,
      profileId: seller.id,
      n: `KVS-BOTH-${label}`,
      status: "loading",
    });
    const r3 = await refuses(opts(), "seller_has_open_trip");
    expect(
      r3.plan.excludedVehicles.find(
        (/** @type {any} */ v) => v.code === "SMP-TRIAL-KVSAFE",
      ).why,
    ).toContain("vehicle_has_open_trip");
    await h.db`delete from van_trips where id=${t3.id}`;
  }
  // a CLOSED trip of the same seller/vehicle on another date is history, not a blocker
  const [done] = await trip({
    date: manilaDate(now - 3 * DAY),
    vehicleId: veh.id,
    profileId: seller.id,
    n: "KVS-CLOSED",
    status: "closed",
  });
  expect(
    codes(await planKickoffVan(h.db, { ...opts(), withFiscalSample: false })),
  ).toEqual(["fiscal_sample_missing"]);
  await h.db`delete from van_trips where id=${done.id}`;
});

// ------------------------------------------------------------------------------------------------ F5/F7: office identity
test("F5/F7: office assignment, effective org unit, depot org unit and ambiguous email are refused BEFORE any actor or command exists", async () => {
  const [asg] =
    await h.db`select id,org_unit_id from employee_assignments where profile_id=${admin.id} and deleted_at is null and effective_to is null`;
  expect(asg.org_unit_id).toBe(admin.org_unit_id);
  for (const [name, fn] of /** @type {const} */ ([
    [
      "office assignment marker",
      (/** @type {any} */ run) =>
        withoutMarker("employee_assignments", asg.id, run),
    ],
    [
      "office org unit marker",
      (/** @type {any} */ run) =>
        withoutMarker("org_units", admin.org_unit_id, run),
    ],
  ])) {
    const s = spy();
    await fn(() =>
      refuses(
        { ...opts(), officeEmail: "admin@sunpride.test" },
        "office_assignment_not_sample",
        { domain: s.domain },
      ),
    );
    expect({ name, ...s.calls }).toEqual({ name, actor: 0, command: 0 });
  }
  const s2 = spy();
  expect(veh.home_location_id).toBeTruthy();
  const [depot] =
    await h.db`select org_unit_id from inventory_locations where id=${veh.home_location_id}`;
  expect(depot.org_unit_id).not.toBe(seller.org_unit_id);
  await withoutMarker("org_units", depot.org_unit_id, () =>
    refuses(opts(), "depot_org_unit_not_sample", { domain: s2.domain }),
  );
  expect(s2.calls).toEqual({ actor: 0, command: 0 });
  // a case-variant email is a SECOND profile for the same address: never "first wins"
  const cols = (
    await h.db`select column_name from information_schema.columns where table_name='profiles' and is_generated='NEVER' order by ordinal_position`
  )
    .map((/** @type {any} */ c) => `"${c.column_name}"`)
    .join(",");
  await h.db.unsafe(
    `insert into profiles(${cols}) select ${cols} from jsonb_populate_record(null::profiles, (select to_jsonb(p) from profiles p where p.id=$1) || jsonb_build_object('id', $2::text, 'email', 'Admin@Sunpride.test', 'user_id', null, 'auth_subject', null, 'employee_code', null))`,
    [admin.id, crypto.randomUUID()],
  );
  try {
    const s3 = spy();
    await refuses(opts(), "office_email_ambiguous", { domain: s3.domain });
    expect(s3.calls).toEqual({ actor: 0, command: 0 });
    // an explicit profile id is still unambiguous
    expect(
      codes(
        await planKickoffVan(h.db, {
          ...opts(),
          withFiscalSample: false,
          officeProfileId: admin.id,
        }),
      ),
    ).not.toContain("office_email_ambiguous");
  } finally {
    await h.db`delete from profiles where email='Admin@Sunpride.test'`;
  }
});

// ------------------------------------------------------------------------------------------------ F1/F6: fiscal, refusals
test("F1: disabled, overlapping, future and expired cash policy fail closed and are never overwritten", async () => {
  await resetFiscal();
  await insertCash({ enabled: false });
  const disabled = await refuses(opts(), "cash_tender_disabled_by_office");
  expect(disabled.plan.fiscal).toMatchObject({
    cashTender: "disabled",
    seedCash: false,
  });
  await resetFiscal();
  await insertCash();
  await insertCash({ from: "2026-02-01" });
  await refuses(opts(), "tender_policy_overlap");
  await resetFiscal();
  await insertCash({ from: new Date(now + 30 * DAY) });
  await refuses(opts(), "cash_tender_not_effective"); // an indefinite 2026-01-01 row of ours would overlap it
  await resetFiscal();
  await insertCash();
  await insertCash({ from: new Date(now + 30 * DAY) });
  await refuses(opts(), "cash_tender_future_overlap");
  await resetFiscal();
  await insertCash({ to: new Date(now - DAY), from: "2026-01-01" });
  await refuses(opts(), "cash_tender_not_effective");
  // an overlap of ANOTHER method also makes tenderPolicy refuse the whole unit
  await resetFiscal();
  await insertCash();
  await insertCash({ method: "gcash" });
  await insertCash({ method: "gcash", from: "2026-03-01" });
  await refuses(opts(), "tender_policy_overlap");
});
test("F1/F6: unusable, suspended, expired, exhausted, not-yet-effective, device-bound, ambiguous or seriesless fiscal setup is refused, never replaced or evaded", async () => {
  /** @type {[string, string, () => Promise<any>][]} */
  const cases = [
    [
      "suspended registration",
      "fiscal_series_unusable",
      () =>
        insertFiscal({
          prefix: "KVS-SUSP",
          status: "suspended",
          sample: false,
        }),
    ],
    [
      "expired registration",
      "fiscal_series_unusable",
      () =>
        insertFiscal({
          prefix: "KVS-EXP",
          status: "expired",
          sample: false,
          to: new Date(now - DAY),
        }),
    ],
    [
      "sample registration ended yesterday",
      "fiscal_series_unusable",
      () => insertFiscal({ prefix: "KVS-ENDED", to: new Date(now - DAY) }),
    ],
    [
      "exhausted series",
      "fiscal_series_unusable",
      () => insertFiscal({ prefix: "KVS-EXH", last: 5, next: 6 }),
    ],
    [
      "series not yet effective",
      "fiscal_series_unusable",
      () =>
        insertFiscal({
          prefix: "KVS-FUT",
          seriesFrom: new Date(now + 5 * DAY),
        }),
    ],
    [
      "registration bound to another device",
      "fiscal_series_unusable",
      () => insertFiscal({ prefix: "KVS-DEV", deviceId: otherDeviceId }),
    ],
    [
      "unverified 'approved'-less real registration",
      "fiscal_series_unusable",
      () =>
        insertFiscal({ prefix: "KVS-DRAFT", status: "draft", sample: false }),
    ],
    [
      "two effective unit-level series",
      "fiscal_series_ambiguous",
      async () => (
        await insertFiscal({ prefix: "KVS-A" }),
        await insertFiscal({ prefix: "KVS-B" })
      ),
    ],
    [
      "registration without series",
      "fiscal_registration_without_series",
      () => insertFiscal({ prefix: "KVS-NOSER", noSeries: true }),
    ],
  ];
  for (const [name, code, setup] of cases) {
    await resetFiscal();
    await setup();
    const { plan } = await refuses(opts(), code);
    // mixed state: the unusable SI must NOT be "fixed" by seeding anything, OR (missing) is reported but not seeded
    expect({ name, ranges: plan.fiscal.ranges.sales_invoice }).toMatchObject({
      name,
      ranges: expect.stringMatching(/unusable|ambiguous/),
    });
    expect(
      (
        await h.db`select count(*)::int n from fiscal_series where vehicle_id=${veh.id}`
      )[0].n,
    ).toBe(0);
  }
  // inverse mixed: OR unusable, SI missing
  await resetFiscal();
  await insertFiscal({
    type: "official_receipt",
    prefix: "KVS-OR-SUSP",
    status: "suspended",
    sample: false,
  });
  const inverse = await refuses(opts(), "fiscal_series_unusable");
  expect(inverse.plan.fiscal.ranges).toEqual({
    sales_invoice: "missing",
    official_receipt: "unusable",
  });
});
test("F1: sample-marker, id and prefix collisions are refused; no row is adopted or marked", async () => {
  const [vanOne] =
    await h.db`select id from vehicles where vehicle_code='SMP-VAN-1'`;
  // (1) a marker for our deterministic registration already exists although the row does not
  await resetFiscal();
  const regId = rowId("fiscal_registrations", `${veh.id}-sales_invoice`);
  await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values('sunpride-fiscal-sample','fiscal_registrations',${crypto.randomUUID()},${`fiscal_registrations:${regId}`})`;
  expect(
    (await refuses(opts(), "fiscal_sample_collision")).plan.fiscal.ranges
      .sales_invoice,
  ).toBe("collision");
  // (2) the deterministic prefix is owned by an unrelated vehicle's series
  await resetFiscal();
  await insertFiscal({
    type: "official_receipt",
    vehicleId: vanOne.id,
    prefix: "SAMPLE-SMP-TRIAL-KVSAFE-OR",
  });
  expect(
    (await refuses(opts(), "fiscal_sample_collision")).plan.fiscal.ranges
      .official_receipt,
  ).toBe("collision");
  // (3) a pre-existing UNMARKED row with our deterministic registration id would otherwise be adopted by ON CONFLICT
  await resetFiscal();
  await h.db`insert into fiscal_registrations(id,org_unit_id,entity_name,branch_name,tin,address,document_type,status,effective_from,entered_by,sample,tax_basis_points)
    values(${regId},${seller.org_unit_id},'REAL','REAL','REAL','REAL','sales_invoice','suspended','2026-01-01',${admin.id},false,1200)`;
  await refuses(opts(), "fiscal_registration_without_series");
  expect(
    (
      await h.db`select count(*)::int n from sample_data_rows where batch='sunpride-fiscal-sample'`
    )[0].n,
  ).toBe(0);
  expect(
    (
      await h.db`select entity_name from fiscal_registrations where id=${regId}`
    )[0].entity_name,
  ).toBe("REAL");
});
test("F1: a new unit-wide cash rule needs every unit consumer to be a sample row; an EXISTING cash rule does not", async () => {
  await resetFiscal();
  const [peer] =
    await h.db`select id from profiles where email='field4@sunpride.test'`;
  expect(codes(await planKickoffVan(h.db, opts()))).toEqual([]);
  const blocked = await withoutMarker("profiles", peer.id, () =>
    refuses(opts(), "tender_unit_has_non_sample_participants"),
  );
  expect(
    blocked.plan.conflicts.find(
      (/** @type {any} */ c) =>
        c.code === "tender_unit_has_non_sample_participants",
    ).detail.foreign,
  ).toEqual({ profiles: 1 });
  // location consumer too
  const [loc] =
    await h.db`select id from inventory_locations where org_unit_id=${seller.org_unit_id} and id<>${veh.truck_location_id} and id<>${veh.home_location_id} and deleted_at is null and active limit 1`;
  if (loc)
    await withoutMarker("inventory_locations", loc.id, () =>
      refuses(opts(), "tender_unit_has_non_sample_participants"),
    );
  // existing usable cash rule: no new unit-wide rule is created, so the other participant is not our concern
  await insertCash();
  await withoutMarker("profiles", peer.id, async () => {
    const plan = await planKickoffVan(h.db, opts());
    expect(plan.conflicts).toEqual([]);
    expect(plan.fiscal).toMatchObject({
      cashTender: "ready",
      seedCash: false,
      seedTypes: ["sales_invoice", "official_receipt"],
    });
  });
  await resetFiscal();
});

// ------------------------------------------------------------------------------------------------ F1/F4 success + F3
/** @type {any} */ let applied;
test("F1/F4: mixed state (usable unit-level SI, OR missing) seeds ONLY the vehicle OR, shadows nothing, consumes no serial, tags provenance", async () => {
  // inverse is a pure dry run (no trip is created twice)
  await resetFiscal();
  await insertFiscal({ type: "official_receipt", prefix: "KVS-UNIT-OR" });
  const inv = await planKickoffVan(h.db, opts());
  expect(inv.ok).toBe(true);
  expect(inv.fiscal).toMatchObject({
    ranges: { sales_invoice: "missing", official_receipt: "ready" },
    seedTypes: ["sales_invoice"],
    seedCash: true,
  });
  await resetFiscal();
  await insertFiscal({ prefix: "KVS-UNIT-SI" });
  const plan = await planKickoffVan(h.db, opts());
  expect(plan.ok).toBe(true);
  expect(plan.fiscal).toMatchObject({
    ranges: { sales_invoice: "ready", official_receipt: "missing" },
    seedTypes: ["official_receipt"],
    seedCash: true,
    willSeedSample: true,
  });
  const noFlag = await planKickoffVan(h.db, {
    ...opts(),
    withFiscalSample: false,
  });
  expect(codes(noFlag)).toEqual(["fiscal_sample_missing"]);
  const before = await snap();
  expect(await snap()).toEqual(before); // the dry runs wrote nothing

  const unitSi = (
    await h.db`select s.id,s.next_allocate::text n from fiscal_series s where s.vehicle_id is null`
  )[0];
  applied = await applyKickoffVan(h.db, opts());
  expect(applied).toMatchObject({
    applied: true,
    replayed: false,
    commandsAdded: 2,
  });
  expect(applied.fiscal.ranges).toEqual({
    sales_invoice: "ready",
    official_receipt: "ready",
  });
  // only OR was added for the vehicle; the unit-level SI is untouched and still the only SI series in scope
  const mine =
    await h.db`select r.document_type,r.sample,r.status from fiscal_series s join fiscal_registrations r on r.id=s.registration_id where s.vehicle_id=${veh.id}`;
  expect(mine).toEqual([
    {
      document_type: "official_receipt",
      sample: true,
      status: "sample_not_filed",
    },
  ]);
  expect(
    (
      await h.db`select count(*)::int n from fiscal_series s join fiscal_registrations r on r.id=s.registration_id where r.document_type='sales_invoice'`
    )[0].n,
  ).toBe(1);
  expect(
    (
      await h.db`select count(*)::int n from fiscal_registrations where document_type in ('credit_memo','delivery_receipt')`
    )[0].n,
  ).toBe(0);
  expect(
    (
      await h.db`select next_allocate::text n from fiscal_series where id=${unitSi.id}`
    )[0].n,
  ).toBe(unitSi.n);
  // real gates, no serial consumed, no allocation exists
  const regs =
    await h.db`select * from fiscal_registrations where org_unit_id=${seller.org_unit_id}`;
  for (const r of regs)
    await real.issuanceGate(h.db, r, device.deviceId, Date.now());
  expect(
    (await real.tenderPolicy(h.db, seller.org_unit_id)).map(
      (/** @type {any} */ m) => m.code,
    ),
  ).toEqual(["cash"]);
  expect(
    (await h.db`select count(*)::int n from fiscal_allocations`)[0].n,
  ).toBe(0);
  expect(
    (
      await h.db`select count(*)::int n from fiscal_series where next_allocate<>1`
    )[0].n,
  ).toBe(0);
  // only rows the helper inserted are marked; the existing unit-level SI is NOT adopted
  const marked =
    await h.db`select table_name from sample_data_rows where batch='sunpride-fiscal-sample' order by table_name`;
  expect(marked.map((/** @type {any} */ m) => m.table_name)).toEqual([
    "fiscal_registrations",
    "fiscal_series",
    "fiscal_tender_rules",
  ]);
  expect(
    (
      await h.db`select count(*)::int n from sample_data_rows where table_name='fiscal_series' and row_id=${unitSi.id}`
    )[0].n,
  ).toBe(0);
  // F4: the scoped office actor is unchanged; one provenance row names the helper; fiscal rows are audited as the helper
  const [office] =
    await h.db`select id from profiles where email='admin@sunpride.test'`;
  const prov =
    await h.db`select actor_profile_id,actor_name,details from van_audit_events where trip_id=${applied.tripId} and kind='sample.kickoff.van.fixture'`;
  expect(prov).toHaveLength(1);
  expect(prov[0]).toMatchObject({
    actor_profile_id: office.id,
    actor_name: "Sample fixture helper (kickoff-van.js)",
  });
  expect(
    (
      await h.db`select actor_profile_id from van_audit_events where trip_id=${applied.tripId} and kind='van.trip.planned'`
    )[0].actor_profile_id,
  ).toBe(office.id);
  expect(
    (
      await h.db`select count(*)::int n from fiscal_audit_events where actor_subject='system:kickoff-van-fixture' and table_name in ('fiscal_registrations','fiscal_series','fiscal_tender_rules')`
    )[0].n,
  ).toBeGreaterThanOrEqual(3);
});

test("F3: replay re-runs identity, ownership and changed-input checks; a changed set is refused by name; depot changes never swap products", async () => {
  const replay = await applyKickoffVan(h.db, opts());
  expect(replay).toMatchObject({
    applied: true,
    replayed: true,
    commandsAdded: 0,
    tripId: applied.tripId,
  });
  expect(
    (
      await h.db`select count(*)::int n from van_audit_events where kind='sample.kickoff.van.fixture'`
    )[0].n,
  ).toBe(1);
  // identity is NOT short-circuited
  const [office] =
    await h.db`select id from profiles where email='admin@sunpride.test'`;
  await withoutMarker("profiles", office.id, () =>
    refuses(opts(), "office_not_sample"),
  );
  // changed intent is never replayed
  const q = await refuses({ ...opts(), quantity: 12 }, "owned_load_differs");
  expect(
    q.report.conflicts.find(
      (/** @type {any} */ c) => c.code === "owned_load_differs",
    ).detail.stored,
  ).toHaveLength(3);
  const keep = applied.products
    .slice(0, 2)
    .map((/** @type {any} */ p) => p.code);
  await refuses({ ...opts(), products: keep }, "owned_load_differs");
  // depot eligibility changes while the trip is only planned/loading: the product that was loaded becomes ineligible
  const first = applied.products[0];
  const [bal] =
    await h.db`select reserved_base::text r from inventory_balances where location_id=${applied.depot.id} and product_id=${first.id}`;
  await h.db`update inventory_balances set reserved_base=1 where location_id=${applied.depot.id} and product_id=${first.id}`;
  try {
    const { report } = await refuses(opts(), "owned_load_differs");
    expect(codes(report)).not.toContain("replayed");
    expect(
      (
        await h.db`select product_id::text pid from van_trip_load_lines where trip_id=${applied.tripId} order by line_number`
      ).map((/** @type {any} */ r) => r.pid),
    ).toEqual(applied.products.map((/** @type {any} */ p) => p.id));
  } finally {
    await h.db`update inventory_balances set reserved_base=${bal.r} where location_id=${applied.depot.id} and product_id=${first.id}`;
  }
  expect((await applyKickoffVan(h.db, opts())).replayed).toBe(true);
});

test("F3: once the phone confirms the load the trip is progressed: named refusal, no reseed, no inventory change, never 'replayed'", async () => {
  const push = async (/** @type {string} */ type, /** @type {any} */ facts) => {
    const at = Date.now();
    const op = {
      clientOpId: crypto.randomUUID(),
      opType: type,
      clientTime: at,
      dependsOn: [],
      payload: {
        tripId: applied.tripId,
        settlementVersion: 1,
        deviceTime: at,
        ...facts,
      },
    };
    const r = await signedPost(h, device, "/api/sync/push", {
      version: 2,
      app: "van-android",
      deviceId: device.deviceId,
      scopeId: seller.org_unit_id,
      operations: [op],
    });
    expect(r.body.results?.[0]?.status).toBe("applied");
  };
  await push("temperature.record", {
    observationId: crypto.randomUUID(),
    checkpoint: "load_out",
    deciC: -200,
    method: "manual",
  });
  const lines =
    await h.db`select line_number,expected_base::text e from van_trip_load_lines where trip_id=${applied.tripId} order by line_number`;
  const [load] =
    await h.db`select id from van_trip_loads where trip_id=${applied.tripId}`;
  await push("load.confirm", {
    loadId: load.id,
    lines: lines.map((/** @type {any} */ l) => ({
      lineNumber: l.line_number,
      actualBase: l.e,
    })),
  });
  expect(
    (await h.db`select status from van_trips where id=${applied.tripId}`)[0]
      .status,
  ).toBe("loaded");
  const { plan, report } = await refuses(opts(), "owned_trip_progressed");
  expect(
    plan.conflicts.find(
      (/** @type {any} */ c) => c.code === "owned_trip_progressed",
    ).detail,
  ).toMatchObject({ tripId: applied.tripId, status: "loaded" });
  expect(codes(report)).toEqual(["owned_trip_progressed"]);
  // the same applies even when the inputs are identical or the depot has since changed
  await refuses({ ...opts(), quantity: 12 }, "owned_trip_progressed");
  expect(
    (
      await h.db`select count(*)::int n from van_trips where salesperson_profile_id=${seller.id} and status in ${h.db(OPEN)}`
    )[0].n,
  ).toBe(1);
  expect(
    (
      await h.db`select coalesce(sum(physical_base),0)::text q from inventory_balances where location_id=${applied.vehicle.truckLocationId}`
    )[0].q,
  ).toBe("72");
});
