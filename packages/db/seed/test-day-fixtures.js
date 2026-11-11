// Fixture sections for test-day.js. Each `section(name, cases, ensure, check)`:
//  ensure(): create what is missing (idempotent), return "created" | "kept" | "partial".
//  check(): read-only facts; any false/0/null value marks the section MISS.
import { api, db, key, one, section, TAG, TODAY, uid } from "./test-day.js";
import { accentedNamesMissing, cashierFor, unitLevelSeries } from "./test-day-picks.js";

const ADMIN = "admin@sunpride.test";
const AGENT = "agent@sunpride.test";
const VAN = "van@sunpride.test";
const MANAGER = "manager@sunpride.test";
const SUPERVISOR = "supervisor@sunpride.test";
const APPROVER = "approver@sunpride.test";
const OPS = "operations1@trial.sunpride.test";

const profile = async (/** @type {string} */ email) =>
  one(
    db`select id,name,org_unit_id,role from profiles where lower(email)=${email} and status='active' and deleted_at is null`,
  );
const location = async (/** @type {string} */ code) =>
  one(
    db`select id,code,name,org_unit_id,type from inventory_locations where code=${code} and deleted_at is null`,
  );
/** Products with the most available stock at a location. @param {string} locId @param {number} n */
const stocked = (locId, n) =>
  db`select b.product_id as id,p.code,b.available_stock_base::int as qty from inventory_balances b join products p on p.id=b.product_id
     where b.location_id=${locId} and b.available_stock_base>=96 and b.deleted_at is null and p.active order by b.available_stock_base desc, p.code limit ${n}`;
const plusDays = (/** @type {string} */ d, /** @type {number} */ n) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000)
    .toISOString()
    .slice(0, 10);

// ---------------------------------------------------------------- field day (seeded)
section(
  "field-day",
  [
    "FLD-032",
    "FLD-033",
    "FLD-034",
    "FLD-040",
    "FLD-042",
    "FLD-043",
    "FLD-044",
    "FLD-048",
    "FLD-049",
    "FLD-052",
    "FLD-054",
    "FLD-055",
    "FLD-076",
    "FLD-077",
    "FLD-078",
    "FLD-080..FLD-120",
    "FLD-139",
    "FLD-141",
    "FLD-143",
    "FLD-144",
    "FLD-145",
    "FLD-147",
    "FLD-149",
    "FLD-150",
    "FLD-163",
    "FLD-165",
    "FLD-170",
    "FLD-174",
    "FLD-204",
    "FLD-207",
    "E2E-017..E2E-020",
    "E2E-038",
    "SYNC-001",
    "SYNC-003",
    "SYNC-014",
    "SYNC-018..SYNC-020",
    "WEB-149",
    "EDGE-007",
    "EDGE-008",
  ],
  async () => "kept",
  async () => {
    const a = await profile(AGENT);
    const v = await one(
      db`select count(*)::int n, count(distinct p.plan_slot_id)::int slots from planned_visits p where p.assignee_profile_id=${a.id} and p.service_date=${TODAY} and p.status='planned' and p.deleted_at is null`,
    );
    const pinned = await one(
      db`select count(*)::int n from planned_visits p join outlet_pins o on o.outlet_id=p.outlet_id where p.assignee_profile_id=${a.id} and p.service_date=${TODAY} and p.deleted_at is null`,
    );
    return {
      agentPlannedToday: v.n,
      orderedSlots: v.slots,
      pinnedStops: pinned.n,
    };
  },
);

// ---------------------------------------------------------------- collections
section(
  "collections",
  ["FLD-122", "FLD-123", "FLD-124", "FLD-125"],
  async () => {
    const a = await profile(AGENT);
    const have = await one(
      db`select count(*)::int n from collection_route_stops where route_date=${TODAY} and collector_profile_id=${a.id}`,
    );
    const codes =
      await db`select distinct r.details->>'customerCode' as code from admin_pack_records r join analytics_store_scope s on s.customer_code=r.details->>'customerCode'
      where r.kind='ar_balance' and r.source='sample' and s.owner_unit_id=${a.org_unit_id} and s.status='active' order by 1 limit 4`;
    if (codes.length < 3)
      throw new Error("not enough AR customers in the agent's unit");
    let did = "kept";
    if (have.n < 3) {
      await api(ADMIN, "/api/v1/money/collections/route", {
        routeDate: TODAY,
        collectorProfileId: a.id,
        stops: codes.map((/** @type {any} */ c, /** @type {number} */ i) => ({
          customerCode: c.code,
          reason: [
            "overdue_balance",
            "cheque_pickup",
            "promise_due",
            "overdue_balance",
          ][i],
        })),
      });
      did = "created";
    }
    const cheque = await one(
      db`select id from cheque_instruments where cheque_number=${`${TAG}-CHQ1`}`,
    );
    if (!cheque) {
      await api(ADMIN, "/api/v1/money/collections/cheque", {
        idempotencyKey: key("cheque1"),
        customerCode: codes[1].code,
        chequeNumber: `${TAG}-CHQ1`,
        bank: "Sample Bank of Cebu",
        amountMinor: 250000,
        chequeDate: plusDays(TODAY, 7),
      });
      did = "created";
    }
    return did;
  },
  async () => {
    const a = await profile(AGENT);
    const s = await one(
      db`select count(*)::int n from collection_route_stops where route_date=${TODAY} and collector_profile_id=${a.id}`,
    );
    const c = await one(
      db`select count(*)::int n from cheque_instruments where cheque_number=${`${TAG}-CHQ1`} and status='received'`,
    );
    return { collectorStopsToday: s.n, postDatedCheque: c.n };
  },
);

// ---------------------------------------------------------------- transfers + in-transit place
const xfer = (/** @type {string} */ ref) =>
  one(
    db`select id,status,variance_status from stock_transfers where source_ref=${ref}`,
  );
/** request (ops) -> approve (approver) [-> dispatch (ops) [-> receive (admin)]]
 * @param {string} ref @param {"requested"|"shipped"|"received"} upTo @param {any} dest @param {any} depot @param {any} transit @param {any} product @param {number} qty @param {number} [receivedGood] */
async function transfer(
  ref,
  upTo,
  dest,
  depot,
  transit,
  product,
  qty,
  receivedGood = qty,
) {
  let row = await xfer(ref);
  if (!row) {
    const made = await api(OPS, "/api/v1/inventory/transfers/request", {
      idempotencyKey: key(`${ref}:request`),
      type: "store_replenishment",
      sourceLocationId: depot.id,
      destinationLocationId: dest.id,
      inTransitLocationId: transit.id,
      lines: [{ productId: product.id, quantityBase: qty }],
      note: `${ref} test-day fixture`,
      sourceRef: ref,
    });
    row = { id: made.id, status: made.status ?? "requested" };
  }
  if (upTo === "requested") return row;
  row = await xfer(ref);
  if (["requested", "draft"].includes(row.status)) {
    if (row.status === "draft")
      await api(OPS, "/api/v1/inventory/transfers/submit", {
        idempotencyKey: key(`${ref}:submit`),
        transferId: row.id,
      });
    await api(APPROVER, "/api/v1/inventory/transfers/approve", {
      idempotencyKey: key(`${ref}:approve`),
      transferId: row.id,
    });
    row = await xfer(ref);
  }
  if (["approved", "picking"].includes(row.status)) {
    await api(OPS, "/api/v1/inventory/transfers/dispatch", {
      idempotencyKey: key(`${ref}:dispatch`),
      transferId: row.id,
      driverName: "Sample Driver Ramon",
      vehiclePlate: "TD 1234",
      receiverName: "Sample Store Clerk",
    });
    row = await xfer(ref);
  }
  if (upTo === "shipped") return row;
  if (row.status === "shipped") {
    const detail = await api(
      ADMIN,
      `/api/v1/inventory/transfers/detail?id=${row.id}`,
    );
    await api(ADMIN, "/api/v1/inventory/transfers/receive", {
      idempotencyKey: key(`${ref}:receive`),
      transferId: row.id,
      lines: [{ lineId: detail.lines[0].id, receivedGoodBase: receivedGood }],
      final: true,
    });
  }
  return xfer(ref);
}
section(
  "transfers",
  [
    "WEB-065",
    "WEB-071",
    "WEB-072",
    "WEB-073",
    "WEB-074",
    "WEB-075",
    "WEB-076",
    "WEB-163",
    "WEB-176",
    "POS-044",
  ],
  async () => {
    const depot = await location("SMP-DEPOT");
    const colon = await location("SAMPLE-CEBU-COLON");
    const mandaue = await location("SAMPLE-CEBU-MANDAUE");
    let transit = await one(
      db`select id from inventory_locations where type='in_transit' and active and deleted_at is null and org_unit_id is not distinct from ${depot.org_unit_id} order by code limit 1`,
    );
    let did = "kept";
    if (!transit) {
      await api(ADMIN, "/api/v1/inventory/locations/save", {
        idempotencyKey: key("transit"),
        code: "SMP-TRANSIT",
        name: "Sample in transit (Cebu depot)",
        type: "in_transit",
        orgUnitId: depot.org_unit_id,
        siteCode: "SMP",
      });
      transit = await one(
        db`select id from inventory_locations where type='in_transit' and active and deleted_at is null order by code limit 1`,
      );
      did = "created";
    }
    const products = await stocked(depot.id, 3);
    if (products.length < 3)
      throw new Error("depot has too little stock for transfer fixtures");
    const refs = ["REQ", "TRANSIT", "DIFF", "VAR"].map(
      (r) => `${TAG}-XFER-${r}`,
    );
    const snap = async () => JSON.stringify(await Promise.all(refs.map(xfer)));
    const before = await snap();
    await transfer(
      `${TAG}-XFER-REQ`,
      "requested",
      colon,
      depot,
      transit,
      products[0],
      48,
    );
    await transfer(
      `${TAG}-XFER-TRANSIT`,
      "shipped",
      mandaue,
      depot,
      transit,
      products[1],
      48,
    );
    await transfer(
      `${TAG}-XFER-DIFF`,
      "received",
      colon,
      depot,
      transit,
      products[2],
      48,
      46,
    ); // small: auto-accepted
    await transfer(
      `${TAG}-XFER-VAR`,
      "received",
      mandaue,
      depot,
      transit,
      products[2],
      96,
      48,
    ); // big: waits for review
    const after = await snap();
    return before === after ? did : "created";
  },
  async () => {
    const t = await one(
      db`select count(*)::int n from inventory_locations where type='in_transit' and active and deleted_at is null`,
    );
    const r = await xfer(`${TAG}-XFER-REQ`),
      s = await xfer(`${TAG}-XFER-TRANSIT`),
      d = await xfer(`${TAG}-XFER-DIFF`),
      v = await xfer(`${TAG}-XFER-VAR`);
    return {
      inTransitPlace: t.n,
      requested: r?.status === "requested",
      inTransit: s?.status === "shipped",
      receivedSmallDiff: d?.variance_status ?? null,
      receivedDiffToReview: v ? `${v.status}/${v.variance_status}` : null,
    };
  },
);

// ---------------------------------------------------------------- stock counts
const countByTitle = (/** @type {string} */ title) =>
  one(
    db`select id,status,count_number from stock_count_sessions where title=${title} order by created_at limit 1`,
  );
/** @param {string} title @param {string} planner @param {string} assignee @param {any} loc */
async function planCount(title, planner, assignee, loc) {
  const have = await countByTitle(title);
  if (have) return have;
  const who = await one(
    db`select user_id from profiles where lower(email)=${assignee}`,
  );
  const made = await api(planner, "/api/v1/inventory/counts/plan", {
    idempotencyKey: key(`count:${title}`),
    locationId: loc.id,
    assignedTo: who.user_id,
    blindCount: false,
    countType: "cycle",
    title,
    scope: {
      productIds: (await stocked(loc.id, 3)).map(
        (/** @type {any} */ p) => p.id,
      ),
    },
  });
  return { id: made.id, status: "planned" };
}
section(
  "counts",
  [
    "WEB-077",
    "WEB-079",
    "WEB-080",
    "WEB-081",
    "WEB-093",
    "WEB-159",
    "WEB-167",
    "WEB-168",
    "E2E-024",
    "EDGE-028",
    "ROLE-020",
  ],
  async () => {
    const depot = await location("SMP-DEPOT");
    const colon = await location("SAMPLE-CEBU-COLON");
    const before = JSON.stringify(
      await db`select title,status from stock_count_sessions where title like ${TAG + "%"} order by title`,
    );
    await planCount(`${TAG} manager count (open)`, OPS, MANAGER, depot);
    await planCount(`${TAG} clerk count (open)`, MANAGER, OPS, depot);
    const sub = await planCount(
      `${TAG} clerk count (submitted)`,
      MANAGER,
      OPS,
      colon.id ? depot : depot,
    );
    const s = await countByTitle(`${TAG} clerk count (submitted)`);
    if (
      !["submitted", "review", "review_needed", "approved", "posted"].includes(
        s.status,
      )
    ) {
      const ls = await api(
        OPS,
        `/api/v1/inventory/counts/lines?sessionId=${sub.id}`,
      );
      const lines = ls.lines.map(
        (/** @type {any} */ l, /** @type {number} */ i) => ({
          lineId: l.id,
          countedBase: Math.max(
            0,
            Number(l.expected?.base ?? 48) - (i === 0 ? 30 : 0),
          ),
          clientOpId: `${TAG}-cnt-${i}`,
        }),
      );
      await api(OPS, "/api/v1/inventory/counts/save-lines", {
        idempotencyKey: key("count-save"),
        sessionId: sub.id,
        deviceLabel: "test-day",
        lines,
      });
      await api(OPS, "/api/v1/inventory/counts/submit", {
        idempotencyKey: key("count-submit"),
        sessionId: sub.id,
      });
    }
    const after = JSON.stringify(
      await db`select title,status from stock_count_sessions where title like ${TAG + "%"} order by title`,
    );
    return before === after ? "kept" : "created";
  },
  async () => {
    const rows =
      await db`select title,status from stock_count_sessions where title like ${TAG + "%"} order by title`;
    const st = (/** @type {string} */ t) =>
      rows.find((/** @type {any} */ r) => r.title.includes(t))?.status ?? null;
    return {
      managerOpen: st("manager count"),
      clerkOpen: st("clerk count (open)"),
      submitted: st("(submitted)"),
    };
  },
);

// ---------------------------------------------------------------- store POS tills
const NORTH = { code: "SAMPLE-CEBU-NORTH", name: "Sample Cebu North store" };
const registerFor = (/** @type {string} */ code) =>
  one(
    db`select r.id,r.terminal_code,r.outlet_id,l.org_unit_id from store_registers r join inventory_locations l on l.id=r.location_id where l.code=${code} and r.effective_to is null order by r.terminal_code limit 1`,
  );
/** @param {string} registerId @param {string} email */
async function cashier(registerId, email) {
  const p = await profile(email);
  const have = await one(
    db`select id from store_cashier_assignments where register_id=${registerId} and profile_id=${p.id} and effective_to is null`,
  );
  if (have) return false;
  await api(ADMIN, "/api/v1/storepos/cashiers/save", {
    requestKey: uid(`cashier:${registerId}:${email}`),
    registerId,
    profileId: p.id,
    enabled: true,
  });
  return true;
}
section(
  "pos-tills",
  [
    "POS-011",
    "POS-013",
    "POS-014",
    "POS-015",
    "POS-017",
    "POS-018",
    "POS-019",
    "POS-021",
    "POS-022",
    "POS-023",
    "POS-029..POS-036",
    "POS-038",
    "POS-042",
    "POS-043",
    "POS-046",
    "POS-051",
    "POS-053",
    "POS-054",
    "POS-202",
    "WEB-085",
    "WEB-086",
    "WEB-087",
    "WEB-088",
    "WEB-089",
    "WEB-095",
    "WEB-156",
    "E2E-025..E2E-029",
    "E2E-039",
    "SYNC-017",
    "EDGE-009",
    "EDGE-011",
    "EDGE-012",
    "EDGE-014",
    "EDGE-027",
    "EDGE-032",
  ],
  async () => {
    const van = await profile(VAN);
    let did = "kept";
    if (!(await registerFor(NORTH.code))) {
      const { ensureStorePosShops } = await import("./storepos.js");
      await ensureStorePosShops(db, [{ ...NORTH, orgUnitId: van.org_unit_id }]);
      did = "created";
    }
    const north = await registerFor(NORTH.code);
    if (await cashier(north.id, VAN)) did = "created";
    // Store receipts need unit-level (vehicle null) sales_invoice + credit_memo series in the store's unit.
    for (const [type, prefix] of [
      ["sales_invoice", "TD-NORTH-SI"],
      ["credit_memo", "TD-NORTH-CM"],
    ]) {
      const reg = await one(
        db`select id from fiscal_registrations where org_unit_id=${van.org_unit_id} and document_type=${type} order by created_at limit 1`,
      );
      if (!reg)
        throw new Error(`no ${type} registration in the van seller's unit`);
      // Any registration's branch-level series serves the store; a second one would tie (NF-2).
      if (await unitLevelSeries(db, van.org_unit_id, type)) continue;
      await api(ADMIN, "/api/v1/fiscal/series/create", {
        registrationId: reg.id,
        prefix,
        firstSerial: "1",
        lastSerial: "999999",
        effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
      });
      did = "created";
    }
    // The sample shops now sit in van@'s unit; a cashier must work in the store's unit.
    const testers = [
      { email: AGENT, ...(await profile(AGENT)) },
      { email: VAN, ...van },
    ];
    for (const code of ["SAMPLE-CEBU-COLON", "SAMPLE-CEBU-MANDAUE"]) {
      const r = await registerFor(code);
      const who = cashierFor(r.org_unit_id, testers);
      if (!who) throw new Error(`no tester works in ${code}'s unit`);
      if (await cashier(r.id, who)) did = "created";
    }
    return did;
  },
  async () => {
    const regs =
      await db`select r.terminal_code,l.code,r.outlet_id is not null as linked,
        (select count(*)::int from store_cashier_assignments a where a.register_id=r.id and a.effective_to is null) as cashiers,
        (select count(*)::int from store_till_days d where d.register_id=r.id and d.business_date=${TODAY} and d.status<>'open') as closed_today,
        (select count(*)::int from store_register_policies p where p.register_id=r.id and p.effective_to is null) as policy,
        (select count(*)::int from inventory_balances b where b.location_id=l.id and b.available_stock_base>0) as stocked
      from store_registers r join inventory_locations l on l.id=r.location_id where r.effective_to is null order by 1`;
    /** @type {Record<string,any>} */ const out = { registers: regs.length };
    for (const r of regs)
      out[r.terminal_code] =
        r.linked &&
        r.cashiers > 0 &&
        r.policy > 0 &&
        r.stocked > 0 &&
        r.closed_today === 0
          ? "openable"
          : false;
    const north = await registerFor(NORTH.code);
    const vanCashier =
      north &&
      (await one(
        db`select count(*)::int n from store_cashier_assignments a join profiles p on p.id=a.profile_id where a.register_id=${north.id} and lower(p.email)=${VAN} and a.effective_to is null`,
      ));
    out.vanSellerCashierInOwnUnit = vanCashier?.n ?? 0;
    const van = await profile(VAN);
    const series = await one(
      db`select count(*)::int n from fiscal_series s join fiscal_registrations r on r.id=s.registration_id where r.org_unit_id=${van.org_unit_id} and s.vehicle_id is null and r.document_type in ('sales_invoice','credit_memo')`,
    );
    out.northUnitSeries = series.n >= 2;
    return out;
  },
);

// ---------------------------------------------------------------- van: classic Loading trip, roster, crew
const VAN1 = "van1@trial.sunpride.test";
/** @param {string} path @param {any} body @param {string} k @param {string} [who] */
const van = (path, body, k, who = ADMIN) =>
  api(who, `/api/v1/van/${path}`, body, { key: key(`van:${k}`) });
const tripOf = (/** @type {string} */ sellerId) =>
  db`select t.id,t.trip_number,t.status,t.started_device_id,t.created_by,t.vehicle_id,t.source_location_id,t.route_id,t.driver_name from van_trips t where t.salesperson_profile_id=${sellerId} and t.service_date=${TODAY} and t.status not in ('cancelled','closed') and t.deleted_at is null order by t.created_at`;
section(
  "van-day",
  [
    "VAN-005",
    "VAN-012",
    "VAN-013",
    "VAN-014",
    "VAN-015",
    "VAN-016",
    "VAN-018",
    "VAN-017..VAN-086 (on-route trip)",
    "VAN-201..VAN-205",
    "WEB-082",
    "WEB-084",
    "WEB-099",
    "E2E-016",
    "E2E-023",
    "E2E-030..E2E-033",
    "E2E-044",
    "SYNC-016",
  ],
  async () => {
    let did = "kept";
    // 1) Classic Loading trip (no vanDay load) for van1@trial on his empty trial truck.
    const s1 = await profile(VAN1);
    let [t1] = await tripOf(s1.id);
    if (t1 && t1.status === "planned") {
      // The seeded trial trip is `planned` with a pre-made load; replace it once with a real office-planned one.
      if (t1.created_by.startsWith("system:")) {
        await van(
          "trips/cancel",
          {
            tripId: t1.id,
            reason: "Replaced by the test-day classic Loading trip",
          },
          `cancel:${t1.id}`,
        );
        [t1] = await tripOf(s1.id);
        did = "created";
      }
    }
    if (!t1) {
      const vehicle = await one(
        db`select id from vehicles where vehicle_code='SMP-TRIAL-VAN1' and status='active'`,
      );
      const depot = await location("SMP-DEPOT");
      const route = await one(
        db`select route_id from van_trips where vehicle_id=${vehicle.id} and route_id is not null order by created_at desc limit 1`,
      );
      await van(
        "trips/plan",
        {
          vehicleId: vehicle.id,
          sourceLocationId: depot.id,
          serviceDate: TODAY,
          salespersonProfileId: s1.id,
          routeId: route?.route_id ?? undefined,
          driverName: "Sample Driver Ramon",
          helperName: "Sample Helper Jun",
        },
        "plan-van1",
      );
      [t1] = await tripOf(s1.id);
      did = "created";
    }
    if (t1.status === "planned") {
      const products = await stocked(t1.source_location_id, 3);
      await van(
        "loads/plan",
        {
          tripId: t1.id,
          lines: products.map((/** @type {any} */ p) => ({
            productId: p.id,
            expectedBase: "48",
          })),
        },
        `load:${t1.id}`,
      );
      did = "created";
    }
    // 2) Roster for both sellers' trucks (this week, every day) and crew on van@'s on-route trip (agent@ as relief: crew PIN takeover).
    const seller = await profile(VAN);
    const [t0] = await tripOf(seller.id);
    for (const [s, t] of [
      [seller, t0],
      [s1, t1],
    ]) {
      if (!t) continue;
      const have = await one(
        db`select id from van_rosters where vehicle_id=${t.vehicle_id} and seller_profile_id=${s.id} and status<>'ended' and deleted_at is null and effective_from<=${TODAY} and (effective_to is null or effective_to>=${TODAY})`,
      );
      if (!have) {
        await van(
          "rosters/save",
          {
            vehicleId: t.vehicle_id,
            sellerProfileId: s.id,
            weekdays: [1, 2, 3, 4, 5, 6, 7],
            effectiveFrom: TODAY,
            routeId: t.route_id ?? undefined,
          },
          `roster:${t.vehicle_id}:${s.id}`,
        );
        did = "created";
      }
    }
    // NF-R4-V1: the seeded on-route trip is `active` with no start handheld; give it van@'s registered van phone so
    // invoices, prints and the close manifest carry the device (the API also binds it on the first operation).
    if (t0 && t0.status === "active" && !t0.started_device_id) {
      const phone = await one(
        db`select id from registered_devices where profile_id=${seller.id} and app='van-android' and status='active' order by created_at desc limit 1`,
      );
      if (phone) {
        await db`update van_trips set started_device_id=${phone.id},updated_at=now() where id=${t0.id} and started_device_id is null`;
        did = "created";
      }
    }
    if (t0) {
      const relief = await profile(AGENT);
      const has = await one(
        db`select 1 as x from van_trip_crew where trip_id=${t0.id} and profile_id=${relief.id} and role='relief' and ended_at is null`,
      );
      if (!has) {
        await van(
          "trips/crew",
          { tripId: t0.id, profileId: relief.id, role: "relief" },
          `crew:${t0.id}`,
        );
        did = "created";
      }
    }
    return did;
  },
  async () => {
    const s1 = await profile(VAN1),
      s0 = await profile(VAN);
    const [t1] = await tripOf(s1.id),
      [t0] = await tripOf(s0.id);
    const classic =
      t1 &&
      (await one(
        db`select count(*)::int n from van_trip_loads l where l.trip_id=${t1.id} and l.status='planned' and l.stock_transfer_id is null`,
      ));
    const rosters = await one(
      db`select count(*)::int n from van_rosters where seller_profile_id in ${db([s0.id, s1.id])} and status<>'ended' and deleted_at is null and effective_from<=${TODAY}`,
    );
    const crew =
      t0 &&
      (await one(
        db`select count(*)::int n from van_trip_crew where trip_id=${t0.id} and role='relief' and ended_at is null`,
      ));
    return {
      van1ClassicLoading: t1?.status === "loading" && classic?.n === 1,
      vanSellerOnRouteTrip: t0?.status ?? null,
      rosters: rosters.n,
      reliefCrewOnVanTrip: crew?.n ?? 0,
    };
  },
);

// ---------------------------------------------------------------- approvals: order over credit, bad orders x2
section(
  "approvals",
  ["WEB-066", "WEB-093", "WEB-094", "WEB-100", "WEB-106", "E2E-020"],
  async () => {
    let did = "kept";
    // Order over credit (pending approval), created through the office order writer as the field agent.
    const agent = await profile(AGENT);
    const crq = uid("order-over-credit");
    if (
      !(await one(db`select id from orders where client_request_id=${crq}`))
    ) {
      const c =
        await one(db`select c.code,o.id as outlet_id from customers c join outlet_customer_links l on l.customer_id=c.id and l.deleted_at is null join outlets o on o.id=l.outlet_id
        where c.credit_limit>0 and o.custodian_org_unit_id=${agent.org_unit_id} and o.status='active' order by c.credit_limit, c.code limit 1`);
      const p = await one(db`select id from products where code='SMP-CB-150'`);
      await api(
        AGENT,
        "/api/v1/orders/create",
        {
          clientRequestId: crq,
          customerCode: c.code,
          outletId: c.outlet_id,
          lines: [{ productId: p.id, uom: "CASE", quantity: 400 }],
          status: "pending_approval",
        },
        { key: key("order-over-credit") },
      );
      did = "created";
    }
    // Bad-order lines: move a little depot stock to Damaged, then request two write-offs (ops) for the manager.
    const depot = await location("SMP-DEPOT");
    const have = await one(
      db`select count(*)::int n from inventory_dispositions where note like ${TAG + "%"} and status='requested'`,
    );
    if (have.n < 2) {
      // Depot stock is lot-tracked: pick two products' fullest available lots.
      const lots =
        await db`select distinct on (lb.product_id) lb.product_id as id, lb.lot_id from inventory_lot_balances lb
        where lb.location_id=${depot.id} and lb.stock_status='available' and lb.available_base>=48 order by lb.product_id, lb.available_base desc`;
      for (const [i, p] of lots.slice(0, 2).entries()) {
        const dmg = await one(
          db`select coalesce(sum(physical_base),0)::int n from inventory_lot_balances where location_id=${depot.id} and lot_id=${p.lot_id} and stock_status='damaged'`,
        );
        if (dmg.n < 6)
          await api(OPS, "/api/v1/inventory/quality/change", {
            idempotencyKey: key(`dmg-move:${i}`),
            locationId: depot.id,
            productId: p.id,
            lotId: p.lot_id,
            fromStatus: "available",
            toStatus: "damaged",
            quantityBase: 12,
            reasonCode: "DMG-HANDLING",
            note: `${TAG} damaged in the depot`,
          });
        await api(OPS, "/api/v1/inventory/dispositions/request", {
          idempotencyKey: key(`dispo:${i}`),
          locationId: depot.id,
          productId: p.id,
          lotId: p.lot_id,
          fromStatus: "damaged",
          decision: "write_off",
          quantityBase: 6,
          reasonCode: "RECALL",
          note: `${TAG} bad order line ${i + 1}`,
        });
      }
      did = "created";
    }
    return did;
  },
  async () => {
    const o = await one(
      db`select status,credit_status from orders where client_request_id=${uid("order-over-credit")}`,
    );
    const d = await one(
      db`select count(*)::int n from inventory_dispositions where note like ${TAG + "%"} and status='requested'`,
    );
    return {
      orderOverCredit: o ? `${o.status}/${o.credit_status}` : null,
      badOrderLinesWaiting: d.n >= 2 ? d.n : 0,
    };
  },
);

// ---------------------------------------------------------------- outlets with ñ / é / period names (in the agent's territory)
// Office-made stores (office Add store + route assignment), NOT renamed SAP sample outlets: SAP owns the names of the
// outlets it sends and the next masters pull put the old names back (r3: the kit said "created", the DB had none).
export const ACCENTED = [
  "Sample Tindahan ni Aling Peña",
  "Sample Café Ébano Store",
  "Sample St. Jude Sari-sari",
];
section(
  "accent-names",
  ["FLD-047", "EDGE-003", "EDGE-004"],
  async () => {
    const agent = await profile(AGENT);
    // Next to one of today's stops (not ones the packs name by code): same unit and territory.
    const used = new Set(["SMP-O0069", "SMP-O0061", "SMP-O0060", "SMP-O0016", "SMP-O0017", "SMP-O0018"]);
    const stop = (
      await db`select o.code,o.custodian_org_unit_id unit,a.territory_id
        from planned_visits v join outlets o on o.id=v.outlet_id
        join outlet_assignments a on a.outlet_id=o.id and a.deleted_at is null and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now())
        where v.assignee_profile_id=${agent.id} and v.service_date=${TODAY} and v.deleted_at is null order by o.code desc`
    ).find((/** @type {any} */ s) => !used.has(s.code));
    if (!stop) throw new Error("no assigned stop on the agent's plan today");
    const from = Date.now() + 3_000; // assignments must be future-effective
    let did = "kept";
    for (const name of ACCENTED) {
      // Office codes (TD-ACC-n) are never sent by SAP, so no masters pull can rename them.
      const code = `TD-ACC-${ACCENTED.indexOf(name) + 1}`;
      const existing = await one(
        db`select id,name from outlets where code=${code} and deleted_at is null`,
      );
      const outletId =
        existing?.id ??
        (await api(
          ADMIN,
          "/api/v1/outlets/create",
          {
            name,
            code,
            custodianOrgUnitId: stop.unit,
            address: "Sample address, Mandaue-Consolacion, Cebu",
            status: "active",
            reason: `${TAG} accent/punctuation search fixture`,
          },
          { key: key(`accent-store:${name}`) },
        ));
      if (!existing) did = "created";
      if (existing && existing.name !== name) {
        await api(ADMIN, "/api/v1/outlets/edit", { outletId, name, reason: `${TAG} accent/punctuation search fixture` }, { key: key(`accent-name:${name}`) });
        did = "created";
      }
      const placed = await one(
        db`select 1 from outlet_assignments where outlet_id=${outletId} and territory_id=${stop.territory_id} and deleted_at is null and (effective_to is null or effective_to>now())`,
      );
      if (placed) continue;
      did = "created";
      await api(
        ADMIN,
        "/api/v1/outlets/assignments/assign",
        {
          outletId,
          // Territory only: today's route is locked by the approved coverage plan; the agent's phone lists every
          // store in the territory (Stores tab), which is what the search cases need.
          territoryId: stop.territory_id,
          effectiveFrom: from,
          reason: `${TAG} accent/punctuation search fixture`,
        },
        { key: key(`accent-place:${name}`) },
      );
    }
    if (did === "kept") return did;
    await new Promise((r) => setTimeout(r, Math.max(0, from - Date.now()) + 500));
    return did;
  },
  async () => {
    const agent = await profile(AGENT);
    const missing = await accentedNamesMissing(db, ACCENTED);
    const placed =
      await db`select distinct o.name from outlets o join outlet_assignments a on a.outlet_id=o.id and a.deleted_at is null and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now())
        where o.name in ${db(ACCENTED)} and a.territory_id in (select a2.territory_id from planned_visits v join outlet_assignments a2 on a2.outlet_id=v.outlet_id and a2.deleted_at is null and (a2.effective_to is null or a2.effective_to>now()) where v.assignee_profile_id=${agent.id} and v.service_date=${TODAY} and v.deleted_at is null)`;
    return {
      accentedStoresNotSapOwned: missing.length === 0 ? ACCENTED.length : 0,
      accentedStoresInAgentTerritory: placed.length === ACCENTED.length ? placed.length : 0,
    };
  },
);

// ---------------------------------------------------------------- second region / area / territory effective today + one store there
section(
  "second-region",
  ["ROLE-021", "ROLE-022", "ROLE-024"],
  async () => {
    const { addTrialRow } = await import("./trial-wiring.js");
    const { BATCH } = await import("./store.js");
    const root = await one(db`select id from org_units where code='SUNPRIDE'`);
    let did = "kept";
    /** @param {string} table @param {string} k @param {any} values */
    const ensure = async (table, k, values) => {
      const m = await one(
        db`select row_id from sample_data_rows where batch=${BATCH} and table_name=${table} and key=${`${table}:trial-${k}`}`,
      );
      if (m) return { ...values, id: m.row_id };
      did = "created";
      return addTrialRow(db, table, k, values);
    };
    const from = new Date(Date.now() - 60_000);
    const unit = (
      /** @type {string} */ code,
      /** @type {string} */ name,
      /** @type {string} */ type,
      /** @type {string} */ parent,
    ) =>
      ensure("org_units", `td-${code}`, {
        organization_id: "sunpride",
        code,
        name,
        type_code: type,
        parent_id: parent,
        status: "active",
        effective_from: from,
      });
    const edge = (/** @type {any} */ u) =>
      ensure("org_unit_parent_edges", `td-${u.code}`, {
        unit_id: u.id,
        parent_id: u.parent_id,
        effective_from: from,
        actor_subject: "system:sample",
        reason: "Test-day second region fixture",
      });
    const region = await unit("SMP-MIN", "Sample Mindanao", "region", root.id);
    await edge(region);
    const area = await unit(
      "SMP-AREA-DVO",
      "Sample Davao Area",
      "area",
      region.id,
    );
    await edge(area);
    const terr = await unit(
      "SMP-T9",
      "Sample Davao City",
      "territory",
      area.id,
    );
    await edge(terr);
    if (
      !(await one(db`select id from outlets where name='Office Area B Store'`))
    ) {
      const setup = await api(ADMIN, "/api/v1/masters/store-setup");
      const sub = setup.subchannels[0];
      await api(
        ADMIN,
        "/api/v1/masters/stores/office-add",
        {
          name: "Office Area B Store",
          address: "J.P. Laurel Ave, Davao City",
          ownerName: "Sample Owner B",
          ownerPhone: "0917 555 0101",
          channelId: sub.data.channelId,
          subchannelId: sub.id,
          orgUnitId: terr.id,
          latitude: 7.0731,
          longitude: 125.6128,
          acknowledgedDuplicateIds: [],
        },
        { key: key("area-b-store") },
      );
      did = "created";
    }
    return did;
  },
  async () => {
    const units =
      await db`select code from org_units where code in ('SMP-MIN','SMP-AREA-DVO','SMP-T9') and status='active' and effective_from<=now()`;
    const store = await one(
      db`select o.code,u.code as unit from outlets o join org_units u on u.id=o.custodian_org_unit_id where o.name='Office Area B Store'`,
    );
    return {
      secondRegionUnits: units.length === 3 ? 3 : 0,
      areaBStore: store?.unit === "SMP-T9" ? store.code : null,
    };
  },
);

// ---------------------------------------------------------------- notices for the manager
section(
  "manager-notices",
  ["WEB-014"],
  async () => {
    const m = await profile(MANAGER);
    const have = await one(
      db`select count(*)::int n from analytics_alert_subscriptions where profile_id=${m.id} and enabled`,
    );
    if (have.n >= 2) return "kept";
    for (const metric of ["integrity_open", "missed_stops"])
      await api(MANAGER, "/api/v1/alerts/subscribe", {
        unitId: m.org_unit_id,
        metric,
        threshold: 0,
        cooldownMinutes: 60,
        inApp: true,
        email: false,
        enabled: true,
      });
    return "created";
  },
  async () => {
    const m = await profile(MANAGER);
    const s = await one(
      db`select count(*)::int n from analytics_alert_subscriptions where profile_id=${m.id} and enabled`,
    );
    const a = await one(
      db`select count(*)::int n from analytics_alert_instances a join analytics_alert_subscriptions s on s.id=a.subscription_id where s.profile_id=${m.id} and a.in_app_at is not null`,
    );
    // Instances arrive from the API's 5-minute alert evaluator; `deliveredNotices` may read 0 right after a reset.
    return {
      managerSubscriptions: s.n,
      deliveredNotices: a.n > 0 ? a.n : "pending (5-min evaluator)",
    };
  },
);

/** A small real JPEG stored like census.js storeJpeg (content-addressed under FILES_DIR) with a marked files row.
 * @param {string} ownerId @param {string} k @param {(table:string,k:string,v:any)=>Promise<any>} ensure */
async function samplePhoto(ownerId, k, ensure) {
  const { encode } = await import(
    new URL("../../../apps/api/node_modules/jpeg-js/index.js", import.meta.url)
      .href
  );
  const w = 96,
    h = 64,
    data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const x = i % w,
      y = Math.floor(i / w);
    data[i * 4] = 200 - y;
    data[i * 4 + 1] = 120 + (x % 32);
    data[i * 4 + 2] = 60;
    data[i * 4 + 3] = 255;
  }
  const bytes = Buffer.from(encode({ data, width: w, height: h }, 80).data);
  const { createHash } = await import("node:crypto");
  const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const dir = process.env.FILES_DIR;
  if (!dir) throw new Error("FILES_DIR is required for sample photos");
  mkdirSync(`${dir}/${digest.slice(0, 2)}`, { recursive: true });
  if (!existsSync(`${dir}/${digest.slice(0, 2)}/${digest}`))
    writeFileSync(`${dir}/${digest.slice(0, 2)}/${digest}`, bytes);
  const admin = await one(
    db`select user_id from profiles where lower(email)=${ADMIN}`,
  );
  return ensure("files", k, {
    owner_id: ownerId,
    purpose: "census-storefront",
    sha256: digest,
    mime: "image/jpeg",
    size: bytes.length,
    path: `${digest.slice(0, 2)}/${digest}`,
    status: "stored",
    created_by: admin.user_id,
    stored_at: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------- New stores: provisional records + gathering captures
// Phone-originated records (their only writer is a signed device op), added as marked sample rows exactly like
// company.js seeds `SMP-PENDING-001`; resetDemo removes them. Office review then runs through the real API.
section(
  "new-stores",
  [
    "WEB-052",
    "WEB-053",
    "WEB-054",
    "WEB-055",
    "WEB-058",
    "WEB-059",
    "WEB-171",
    "WEB-174",
    "WEB-175",
    "E2E-008",
    "FLD-211",
    "ROLE-102",
  ],
  async () => {
    const { addTrialRow } = await import("./trial-wiring.js");
    const { BATCH } = await import("./store.js");
    let did = "kept";
    /** @param {string} table @param {string} k @param {any} values */
    const ensure = async (table, k, values) => {
      const m = await one(
        db`select row_id from sample_data_rows where batch=${BATCH} and table_name=${table} and key=${`${table}:trial-td-${k}`}`,
      );
      if (m) return { ...values, id: m.row_id };
      did = "created";
      return addTrialRow(db, table, `td-${k}`, values);
    };
    const agent = await one(
      db`select p.id,p.org_unit_id,p.auth_subject from profiles p where lower(p.email)=${AGENT}`,
    );
    const admin = await one(
      db`select p.id,p.org_unit_id,p.auth_subject from profiles p where lower(p.email)=${ADMIN}`,
    );
    const agent2 = await one(
      db`select p.id,p.auth_subject from profiles p where lower(p.email)='agent1@trial.sunpride.test'`,
    );
    const seeded = await one(
      db`select territory_id,org_unit_id from outlet_enrolments where provisional_code='SMP-PENDING-001'`,
    );
    const noon = new Date().toISOString();
    // 1) Three more provisional New-store records (two by the agent, one by admin for the own-proposal rule).
    const props = [
      ["TD-NEW-1", "Sample Bagong Tindahan Uno", agent, 10.3561, 123.9482],
      ["TD-NEW-2", "Sample Bagong Tindahan Dos", agent, 10.3571, 123.9492],
      ["TD-NEW-3", "Sample Admin-proposed Store", admin, 10.3581, 123.9502],
    ];
    for (const [code, name, who, lat, lng] of props) {
      const outlet = await ensure("outlets", `${code}`, {
        organization_id: "sunpride",
        code: `SMP-${code}`,
        name,
        status: "prospect",
        custodian_org_unit_id: seeded.org_unit_id,
        channel: "gt",
        enrolment_status: "provisional",
        created_by: who.auth_subject,
      });
      const pin = await ensure("outlet_pins", `${code}`, {
        outlet_id: outlet.id,
        latitude: lat,
        longitude: lng,
        radius_meters: 75,
        source: "sample",
        evidence_note: "Test-day provisional store",
        status: "pending",
        effective_from: noon,
        proposed_by: who.auth_subject,
        proposed_at: noon,
      });
      await ensure("outlet_enrolments", `${code}`, {
        organization_id: "sunpride",
        outlet_id: outlet.id,
        org_unit_id: seeded.org_unit_id,
        territory_id: seeded.territory_id,
        pin_id: pin.id,
        status: "pending",
        provisional_code: `SMP-${code}`,
        client_request_id: `td-${code}`,
        proposed_by: who.auth_subject,
        proposed_by_profile_id: who.id,
        proposed_at: noon,
      });
    }
    // 2) Store-gathering captures in the agent's census batch: plain, duplicate candidate, location mismatch,
    //    plus a second person's field change (kind=change) for own-only filtering.
    const batch = await one(
      db`select id from census_batches where org_unit_id=${agent.org_unit_id} order by created_at limit 1`,
    );
    const setup = await api(ADMIN, "/api/v1/masters/store-setup");
    const sub = setup.subchannels[0];
    const dupe =
      await one(db`select o.id,o.code,o.name,p.latitude,p.longitude from planned_visits v join outlets o on o.id=v.outlet_id join outlet_pins p on p.outlet_id=o.id and p.status='verified'
      where v.assignee_profile_id=${agent.id} and v.service_date=${TODAY} order by o.code limit 1`);
    const contact = await one(
      db`select phone from outlet_contacts where outlet_id=${dupe.id} and phone is not null limit 1`,
    );
    const base = {
      batch_id: batch.id,
      captured_at: noon,
      channel_id: sub.data.channelId,
      subchannel_id: sub.id,
      estimated_class: "C",
      app: "field-android",
      location_provider: "gps",
      location_recorded_at: noon,
      acknowledged_duplicate_ids: [],
      duplicate_candidates: [],
      duplicate_flag: false,
      kind: "new",
    };
    /** @type {[string, any][]} */
    const captures = [
      [
        "CAP-1",
        {
          ...base,
          actor_profile_id: agent.id,
          payload_hash: `td-cap-1-${TODAY}`,
          name: "Sample Gathered Store Isa",
          address: "Sample Purok 3, Mandaue City",
          latitude: 10.3401,
          longitude: 123.9421,
          accuracy_meters: 8,
          owner_name: "Sample Owner Isa",
          owner_phone: "0917 555 0201",
          location_source: "gps",
        },
      ],
      [
        "CAP-2",
        {
          ...base,
          actor_profile_id: agent.id,
          payload_hash: `td-cap-2-${TODAY}`,
          name: dupe.name,
          address: "Same place as an existing store",
          latitude: Number(dupe.latitude) + 0.0001,
          longitude: Number(dupe.longitude),
          accuracy_meters: 10,
          owner_name: "Sample Owner Dalawa",
          owner_phone: contact?.phone ?? "0917 555 0202",
          location_source: "gps",
          duplicate_flag: true,
          duplicate_candidates: [
            {
              kind: "outlet",
              id: dupe.id,
              code: dupe.code,
              name: dupe.name,
              distanceMeters: 11,
              reasons: ["name", "distance"],
            },
          ],
        },
      ],
      [
        "CAP-3",
        {
          ...base,
          actor_profile_id: agent.id,
          payload_hash: `td-cap-3-${TODAY}`,
          name: "Sample Gathered Store Tatlo",
          address: "Far Place Talisay, Tabunok, Talisay City",
          latitude: 10.3411,
          longitude: 123.9431,
          accuracy_meters: 9,
          owner_name: "Sample Owner Tatlo",
          owner_phone: "0917 555 0203",
          location_source: "places",
          location_provider: "places",
          place_id: "fake-far-talisay",
          formatted_address: "Far Place Talisay, Tabunok, Talisay City, Cebu",
          address_components: {
            street: "9 Natalio Bacalso Avenue",
            barangay: "Tabunok",
            city: "Talisay City",
            province: "Cebu",
          },
        },
      ],
      [
        "CAP-4",
        {
          ...base,
          actor_profile_id: agent2.id,
          payload_hash: `td-cap-4-${TODAY}`,
          kind: "change",
          target_outlet_id: dupe.id,
          name: dupe.name,
          address: "Sample corrected address, Mandaue City",
          latitude: null,
          longitude: null,
          owner_name: "Sample Owner Apat",
          owner_phone: "0917 555 0204",
          location_source: "gps",
          location_provider: null,
          location_recorded_at: null,
          channel_id: null,
          subchannel_id: null,
          estimated_class: null,
          previous_values: { address: "Sample previous address" },
        },
      ],
    ];
    const { rowId } = await import("./store.js");
    for (const [k, v] of captures) {
      if (v.kind === "new")
        v.photo_file_id = (
          await samplePhoto(
            rowId("census_captures", `trial-td-${k}`),
            `td-photo-${k}`,
            ensure,
          )
        ).id;
      const row = await ensure("census_captures", `${k}`, v);
      if (
        k === "CAP-3" &&
        !(await one(
          db`select 1 as x from census_place_checks where capture_id=${row.id}`,
        ))
      ) {
        await db`insert into census_place_checks(capture_id,status,place_latitude,place_longitude,distance_meters,checked_at) values(${row.id},'mismatch',10.2626,123.8414,10900,now())`;
      }
    }
    return did;
  },
  async () => {
    const p = await one(
      db`select count(*)::int n from outlet_enrolments where status='pending'`,
    );
    const c =
      await db`select c.name,c.kind,c.duplicate_flag,pc.status as place from census_captures c left join census_place_checks pc on pc.capture_id=c.id left join census_reviews r on r.capture_id=c.id where r.id is null`;
    return {
      provisionalPending: p.n >= 4 ? p.n : 0,
      gatheringCaptures: c.filter((/** @type {any} */ r) => r.kind === "new")
        .length,
      duplicateCandidate: c.some((/** @type {any} */ r) => r.duplicate_flag),
      locationMismatch: c.some(
        (/** @type {any} */ r) => r.place === "mismatch",
      ),
      fieldChangeInOffice: c.some(
        (/** @type {any} */ r) => r.kind === "change",
      ),
    };
  },
);

// ---------------------------------------------------------------- per diem (computed from seeded visit history; read-only check)
section(
  "per-diem",
  ["WEB-120"],
  async () => "kept",
  async () => {
    const agent = await profile(AGENT);
    const args = encodeURIComponent(
      JSON.stringify({
        from: plusDays(TODAY, -6),
        to: plusDays(TODAY, -1),
        profileId: agent.id,
      }),
    );
    const r = await api(
      MANAGER,
      `/api/v1/fieldreports/supervision/per_diem/validation?args=${args}`,
    );
    const sel = r.selected ?? r;
    return {
      perDiemPackForAgentLastWeek: sel?.contentHash
        ? (sel.totals?.validCalls ?? 0) + " valid calls"
        : null,
      undecided: !sel?.decision,
    };
  },
);
