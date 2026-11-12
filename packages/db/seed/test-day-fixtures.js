// Fixture sections for test-day.js. Each `section(name, cases, ensure, check)`:
//  ensure(): create what is missing (idempotent), return "created" | "kept" | "partial".
//  check(): read-only facts; any false/0/null value marks the section MISS.
import { tx } from "../src/client.js";
import { api, db, key, one, section, TAG, TODAY, uid } from "./test-day.js";
import {
  accentedNamesMissing,
  ACTIVITY_RULES,
  cashierFor,
  creditRoom,
  formKinds,
  officeAddedUnplaced,
  stopsWithMsl,
  unitLevelSeries,
} from "./test-day-picks.js";

const ADMIN = "admin@sunpride.test";
const AGENT = "agent@sunpride.test";
const VAN = "van@sunpride.test";
const MANAGER = "manager@sunpride.test";
const SUPERVISOR = "supervisor@sunpride.test";
const APPROVER = "approver@sunpride.test";
const OPS = "operations1@trial.sunpride.test";
/** The field login the phone packs use (PHONE-F). */
const FIELD = "agent1@trial.sunpride.test";

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
  ["FLD-121", "FLD-122", "FLD-123", "FLD-124", "FLD-125"],
  async () => {
    let did = "kept";
    // r6: agent@ (web/ROLES packs) and agent1@trial (the Xiaomi login) each get today's collection stops.
    for (const [n, who] of [AGENT, FIELD].entries()) {
      const a = await profile(who);
      const have = await one(
        db`select count(*)::int n from collection_route_stops where route_date=${TODAY} and collector_profile_id=${a.id}`,
      );
      const codes =
        await db`select distinct r.details->>'customerCode' as code from admin_pack_records r join analytics_store_scope s on s.customer_code=r.details->>'customerCode'
        where r.kind='ar_balance' and r.source='sample' and s.owner_unit_id=${a.org_unit_id} and s.status='active' order by 1 limit 4`;
      if (codes.length < 3)
        throw new Error(`not enough AR customers in ${who}'s unit`);
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
      const number = `${TAG}-CHQ${n + 1}`;
      const cheque = await one(
        db`select id from cheque_instruments where cheque_number=${number}`,
      );
      if (!cheque) {
        await api(ADMIN, "/api/v1/money/collections/cheque", {
          idempotencyKey: key(n ? `cheque${n + 1}` : "cheque1"),
          customerCode: codes[1].code,
          chequeNumber: number,
          bank: "Sample Bank of Cebu",
          amountMinor: 250000,
          chequeDate: plusDays(TODAY, 7),
        });
        did = "created";
      }
    }
    return did;
  },
  async () => {
    /** @type {Record<string,any>} */ const out = {};
    for (const [n, who] of [AGENT, FIELD].entries()) {
      const a = await profile(who);
      const s = await one(
        db`select count(*)::int n from collection_route_stops where route_date=${TODAY} and collector_profile_id=${a.id}`,
      );
      const c = await one(
        db`select count(*)::int n from cheque_instruments where cheque_number=${`${TAG}-CHQ${n + 1}`} and status='received'`,
      );
      const who2 = n ? "agent1Trial" : "agent";
      out[`${who2}CollectorStopsToday`] = s.n;
      out[`${who2}PostDatedCheque`] = c.n;
    }
    return out;
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
    // r6 (FLD-047): the Xiaomi signs in as agent1@trial, so the stores go to HIS territory (r5 put them in agent@'s).
    const agent = await profile(FIELD);
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
    const agent = await profile(FIELD);
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

// ---------------------------------------------------------------- field forms on agent1@trial's day (r4 batch 2)
/** agent1@trial's planned stops today, in route order. */
const fieldStops = async () => {
  const me = await profile(FIELD);
  if (!me) return [];
  return db`select distinct on (o.id) o.id,o.code,o.name,o.channel,o.channel_id,o.classification,s.sequence
    from planned_visits v join outlets o on o.id=v.outlet_id left join coverage_plan_slots s on s.id=v.plan_slot_id
    where v.assignee_profile_id=${me.id} and v.service_date=${TODAY} and v.deleted_at is null and o.deleted_at is null
    order by o.id`.then((/** @type {any[]} */ rows) =>
    rows.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.code.localeCompare(b.code)),
  );
};
/** Today's stops that have an MSL profile for their channel but not their class (sample "SAMPLE-A"). */
const mslChannelStops = async () => {
  const stops = await fieldStops();
  const channels = new Set(
    (
      await db`select distinct v.data->>'channelId' as c from master_definitions d join master_versions v on v.master_id=d.id
        where d.kind='msl' and v.status='active' and v.effective_from<=now() and (v.effective_to is null or v.effective_to>now())`
    ).map((/** @type {any} */ r) => r.c),
  );
  return stops.filter((/** @type {any} */ o) => o.channel_id && channels.has(o.channel_id));
};
/** Revenue-potential inputs that derive class A (52,000,000 centavos) or B (26,000,000) under the sample policy. */
const POTENTIAL = {
  A: { transactionsPerDay: 200, averageBasketCentavos: 10000, tradingDaysPerMonth: 26, captureRatePct: 100 },
  B: { transactionsPerDay: 100, averageBasketCentavos: 10000, tradingDaysPerMonth: 26, captureRatePct: 100 },
};
const RETAIL_EQUIPMENT = "TD-FREEZER-FIELD";
section(
  "field-forms",
  ["FLD-091", "FLD-092", "FLD-093", "FLD-094", "FLD-100", "FLD-101", "FLD-102", "FLD-114"],
  async () => {
    let did = "kept";
    const from = Date.now() + 5000;
    const reason = `${TAG} field forms fixture (r4 batch 2)`;
    // 1) FLD-091..094: publish the activity rules; the phone downloads published rows only.
    for (const [intent, activities] of Object.entries(ACTIVITY_RULES)) {
      const have = await one(
        db`select 1 as x from visit_activity_rules where organization_id='sunpride' and intent=${intent} and deleted_at is null and (effective_to is null or effective_to>now())`,
      );
      if (have) continue;
      did = "created";
      await api(
        ADMIN,
        "/api/v1/visits/activity-rules/set",
        { intent, activities, effectiveFrom: from, provisional: true, sourceRef: `SAMPLE ${reason}` },
        { key: key(`activity-rule:${intent}`) },
      );
    }
    // 2) FLD-100/101: an MSL framework profile matches the governed class (A-D) only, and it replaces the
    //    legacy per-store release. Classify the first two GT/MT stops through the office's own command.
    const candidates = await mslChannelStops();
    const msl = candidates.slice(0, 2);
    const retail = candidates[2];
    const policy = await one(
      db`select v.id from master_definitions d join master_versions v on v.master_id=d.id where d.kind='class_policy' and v.status='active' and v.effective_from<=now() and (v.effective_to is null or v.effective_to>now()) limit 1`,
    );
    for (const [stop, klass] of [
      ...msl.map((/** @type {any} */ o) => [o, "A"]),
      ...(retail ? [[retail, "B"]] : []),
    ]) {
      if (stop.classification === klass || !policy) continue;
      did = "created";
      await api(
        ADMIN,
        "/api/v1/masters/outlets/classify",
        { outletId: stop.id, policyVersionId: policy.id, inputs: POTENTIAL[/** @type {"A"|"B"} */ (klass)], reason },
        { key: key(`classify:${stop.code}:${klass}`) },
      );
    }
    // 3) FLD-102: the Retail execution panel rides the merchandiser call flow. Bind it to (channel, class B),
    //    which only the stop classified B above has, and give that store a freezer.
    if (retail) {
      const bound = await one(
        db`select 1 as x from call_flow_channel_bindings where app='field-android' and channel_code=${retail.channel} and outlet_class='B' and channel_profile='merchandiser' and (effective_to is null or effective_to>now())`,
      );
      if (!bound) {
        did = "created";
        await api(
          ADMIN,
          "/api/v1/callflow/binding/publish",
          { app: "field-android", channelCode: retail.channel, outletClass: "B", channelProfile: "merchandiser", effectiveFrom: from },
          { key: key(`merch-binding:${retail.channel}`) },
        );
      }
      const freezer = await one(
        db`select 1 as x from retail_master_versions where kind='equipment' and code=${RETAIL_EQUIPMENT} and (effective_to is null or effective_to>now())`,
      );
      const cold = await one(
        db`select id from retail_master_versions where kind='cold_policy' and data->>'type'='freezer' and effective_from<=now() and (effective_to is null or effective_to>now()) order by code limit 1`,
      );
      if (!freezer && cold) {
        did = "created";
        await api(
          ADMIN,
          "/api/v1/retail/masters/publish",
          {
            requestKey: uid(`freezer:${retail.code}`),
            kind: "equipment",
            code: RETAIL_EQUIPMENT,
            label: `Sample freezer at ${retail.name}`,
            effectiveFrom: from,
            data: {
              serial: `${TAG}-FR-1`,
              model: "Sample 200 L chest freezer",
              sapFixedAssetId: `${TAG}-FA-1`,
              custodian: "Sample store custodian",
              agreement: "Sample own-products agreement",
              location: "Cebu",
              type: "freezer",
              outletId: retail.id,
              deployedAt: Date.now() - 30 * 86_400_000,
              policyVersionId: cold.id,
            },
          },
          { key: key(`freezer:${retail.code}`) },
        );
      }
    }
    if (did === "created")
      await new Promise((r) => setTimeout(r, Math.max(0, from - Date.now()) + 500));
    return did;
  },
  async () => {
    const rules =
      await db`select r.intent,a.kind from visit_activity_rules r join visit_activity_rule_activities a on a.visit_activity_rule_id=r.id and a.deleted_at is null
        where r.organization_id='sunpride' and r.deleted_at is null and r.effective_from<=now() and (r.effective_to is null or r.effective_to>now())`;
    const kinds = new Set(rules.map((/** @type {any} */ r) => r.kind));
    const stops = await fieldStops();
    const withMsl = await stopsWithMsl(
      db,
      stops.map((/** @type {any} */ o) => o.id),
    );
    const retail =
      await db`select o.code from outlets o join call_flow_channel_bindings b on b.app='field-android' and b.channel_profile='merchandiser'
        and b.channel_code in (o.channel,'*') and b.outlet_class in (o.classification,'*') and b.effective_from<=now() and (b.effective_to is null or b.effective_to>now())
        join retail_master_versions e on e.kind='equipment' and e.data->>'outletId'=o.id::text and e.effective_from<=now() and (e.effective_to is null or e.effective_to>now())
        where o.id in ${db(stops.length ? stops.map((/** @type {any} */ o) => o.id) : [uid("none")])}`;
    const credit =
      await db`select o.code, round(c.credit_limit*100)::bigint as "limitMinor",
        coalesce((select sum(round(x.total*100))::bigint from orders x where x.customer_code=c.code and x.status in ('submitted','pending_approval','approved','sent_to_sap','review_required')),0) as "openMinor"
        from outlets o join outlet_customer_links l on l.outlet_id=o.id and l.deleted_at is null and l.effective_from<=now() and (l.effective_to is null or l.effective_to>now())
        join customers c on c.id=l.customer_id where o.id in ${db(stops.length ? stops.map((/** @type {any} */ o) => o.id) : [uid("none")])} and c.credit_limit>0`;
    const room = creditRoom(credit, 1_000_000); // at least PHP 10,000 left: a small order stays within
    const forms = formKinds(ACTIVITY_RULES);
    return {
      activityForms: forms.every((k) => kinds.has(k)) ? forms.join("/") : 0,
      availabilityStores: withMsl.length ? withMsl.join(",") : 0,
      retailExecutionStore: retail[0]?.code ?? 0,
      creditRoomStore: room[0] ? `${room[0].code} (PHP ${(room[0].roomMinor / 100).toFixed(2)} left)` : 0,
    };
  },
);

// ---------------------------------------------------------------- a new store on today's field area (E2E-012, SYNC-007)
const OFFICE_ADDED = { code: "TD-OFFICE-ADD-1", name: "Office Added Test Today" };
section(
  "route-today",
  ["E2E-012", "SYNC-007"],
  async () => {
    // The web's Assignments form takes tomorrow or later only; the API takes any instant from now.
    // Rerun `--only route-today` after adding a store named "Office Added ..." on the web: it is placed
    // in agent1@trial's territory within seconds (run it with the phone offline for SYNC-007).
    let did = "kept";
    const stop = (await fieldStops())[0];
    if (!stop) throw new Error("agent1@trial has no planned stop today");
    const area = await one(
      db`select a.territory_id,o.custodian_org_unit_id as unit from outlet_assignments a join outlets o on o.id=a.outlet_id where a.outlet_id=${stop.id} and a.deleted_at is null and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now())`,
    );
    const existing = await one(
      db`select id from outlets where code=${OFFICE_ADDED.code} and deleted_at is null`,
    );
    if (!existing) {
      did = "created";
      await api(
        OPS,
        "/api/v1/outlets/create",
        {
          name: OFFICE_ADDED.name,
          code: OFFICE_ADDED.code,
          custodianOrgUnitId: area.unit,
          channel: stop.channel ?? "gt",
          address: "Sample address, Cebu",
          status: "active",
          reason: `${TAG} office-added store for today`,
        },
        { key: key("office-added-store") },
      );
    }
    const from = Date.now() + 5000;
    for (const o of await officeAddedUnplaced(db)) {
      did = "created";
      await api(
        ADMIN,
        "/api/v1/outlets/assignments/assign",
        { outletId: o.id, territoryId: area.territory_id, effectiveFrom: from, reason: `${TAG} place an office-added store today` },
        { key: key(`office-added-place:${o.id}`) },
      );
    }
    if (did === "created")
      await new Promise((r) => setTimeout(r, Math.max(0, from - Date.now()) + 500));
    return did;
  },
  async () => {
    const me = await profile(FIELD);
    const placed =
      await db`select o.code from outlets o join outlet_assignments a on a.outlet_id=o.id and a.deleted_at is null and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now())
        join territory_salespeople s on s.territory_id=a.territory_id and s.deleted_at is null and s.effective_from<=now() and (s.effective_to is null or s.effective_to>now())
        where o.name ilike 'Office Added%' and o.status='active' and s.profile_id=${me?.id ?? uid("none")} order by o.code`;
    return {
      officeAddedOnAgentArea: placed.length ? placed.map((/** @type {any} */ r) => r.code).join(",") : 0,
      unplacedOfficeAdded: (await officeAddedUnplaced(db)).length === 0,
    };
  },
);

// ---------------------------------------------------------------- r6: van1@trial's unit can bootstrap and sell (NF-R5V-5)
// The trial unit had no tender rules (bundle paymentMethods=[] -> the phone refused the bootstrap) and no fiscal
// registration/series for its truck. Tender rules: the office can only schedule them from a FUTURE midnight, so the kit
// writes today's rows the same way the sample fiscal seed does (marked sample rows). Registrations/series go through the API.
const TENDERS = [
  { code: "cash", label: "Cash", ref: null },
  { code: "gcash", label: "GCash", ref: "GCash reference" },
  { code: "card", label: "Card", ref: "Terminal approval (never card number)" },
];
const VAN_DOCS = /** @type {const} */ ([
  ["sales_invoice", "SI"],
  ["official_receipt", "OR"],
  ["credit_memo", "CM"],
  ["delivery_receipt", "DR"],
]);
/** Vehicle-level series for every van document type; registrations are made in the unit when missing.
 * @param {any} unitId @param {any} vehicle @param {string} tag @returns {Promise<boolean>} */
async function vanSeries(unitId, vehicle, tag) {
  let made = false;
  for (const [type, short] of VAN_DOCS) {
    const have = await one(
      db`select 1 as x from fiscal_series s join fiscal_registrations r on r.id=s.registration_id where r.org_unit_id=${unitId} and r.document_type=${type} and s.vehicle_id=${vehicle.id} and s.next_allocate<=s.last_serial and (s.effective_to is null or s.effective_to>now())`,
    );
    if (have) continue;
    let reg = await one(
      db`select id from fiscal_registrations where org_unit_id=${unitId} and document_type=${type} and device_id is null and (effective_to is null or effective_to>now()) order by created_at limit 1`,
    );
    if (!reg) {
      const unit = await one(db`select name from org_units where id=${unitId}`);
      reg = await api(ADMIN, "/api/v1/fiscal/registrations/save", {
        id: uid(`fiscal-reg:${unitId}:${type}`),
        orgUnitId: unitId,
        status: "sample_not_filed",
        effectiveFrom: new Date(Date.now() - 120_000).toISOString(),
        entityName: "SAMPLE SUNPRIDE COMPANY - NOT REGISTERED",
        branchName: unit?.name ?? "Sample branch",
        tin: "SAMPLE 000-000-000-000",
        address: "Sample Cebu address - replace with registered address",
        documentType: type,
      });
    }
    await api(ADMIN, "/api/v1/fiscal/series/create", {
      registrationId: reg.id,
      vehicleId: vehicle.id,
      prefix: `TD-${tag}-${short}`,
      firstSerial: "1",
      lastSerial: "999999",
      effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
    });
    made = true;
  }
  return made;
}
section(
  "van-trial-units",
  ["NF-R5V-5", "VAN-005", "VAN-011..VAN-017", "VAN-020", "VAN-057..VAN-067 (van1 fallback)"],
  async () => {
    let did = "kept";
    const s1 = await profile(VAN1);
    const admin = await profile(ADMIN);
    for (const m of TENDERS) {
      const have = await one(
        db`select 1 as x from fiscal_tender_rules where org_unit_id=${s1.org_unit_id} and method=${m.code} and effective_from<=now() and (effective_to is null or effective_to>now())`,
      );
      if (have) continue;
      const id = uid(`tender:${s1.org_unit_id}:${m.code}`);
      await tx(db, async (/** @type {any} */ t) => {
        await t`insert into fiscal_tender_rules(id,org_unit_id,method,label,reference_label,enabled,effective_from,sample,entered_by) values(${id},${s1.org_unit_id},${m.code},${m.label},${m.ref},true,${new Date(Date.now() - 60_000)},true,${admin.id}) on conflict(id) do nothing`;
        await t`insert into sample_data_rows(batch,table_name,row_id,key) values('sunpride-fiscal-sample','fiscal_tender_rules',${id},${"fiscal_tender_rules:" + id}) on conflict(batch,key) do nothing`;
      });
      did = "created";
    }
    const v1 = await one(
      db`select id from vehicles where vehicle_code='SMP-TRIAL-VAN1' and status='active'`,
    );
    if (await vanSeries(s1.org_unit_id, v1, "VAN1")) did = "created";
    const s3 = await profile(VAN3);
    const v3 = await one(
      db`select id from vehicles where vehicle_code='SMP-TRIAL-VAN3' and status='active'`,
    );
    if (await vanSeries(s3.org_unit_id, v3, "VAN3")) did = "created";
    return did;
  },
  async () => {
    const s1 = await profile(VAN1);
    const t = await one(
      db`select count(*)::int n from fiscal_tender_rules where org_unit_id=${s1.org_unit_id} and enabled and effective_from<=now() and (effective_to is null or effective_to>now())`,
    );
    /** @param {string} code */
    const series = (code) =>
      one(
        db`select count(distinct r.document_type)::int n from fiscal_series s join fiscal_registrations r on r.id=s.registration_id join vehicles v on v.id=s.vehicle_id where v.vehicle_code=${code} and s.effective_from<=now() and (s.effective_to is null or s.effective_to>now())`,
      );
    return {
      van1UnitPaymentMethods: t.n,
      van1TruckSeries: (await series("SMP-TRIAL-VAN1")).n === 4,
      van3TruckSeries: (await series("SMP-TRIAL-VAN3")).n === 4,
    };
  },
);

// ---------------------------------------------------------------- r6: van3@trial gets a van-day load dispatched (Accept the load)
// VAN-011/012 need vanDay state canAccept (office plan -> approve -> clerk pick -> dispatch). van1@trial keeps the classic
// Loading trip (VAN-013..017) and van@ keeps the on-route trip, so the VAN operator signs in as van3@trial for these two.
const VAN3 = "van3@trial.sunpride.test";
const planRow = (/** @type {string} */ tripId) =>
  one(
    db`select id,state from van_planned_loads where trip_id=${tripId} order by created_at desc limit 1`,
  );
/** @param {string} path @param {any} body @param {string} k */
async function clerk(path, body, k) {
  try {
    return await van(path, body, k, OPS);
  } catch (e) {
    if (/** @type {any} */ (e).status !== 403) throw e;
    return van(path, body, k, ADMIN);
  }
}
section(
  "van3-accept-load",
  ["VAN-011", "VAN-012"],
  async () => {
    let did = "kept";
    const s3 = await profile(VAN3);
    let [t] = await tripOf(s3.id);
    const seeded = t;
    if (t && t.status === "planned" && t.created_by.startsWith("system:")) {
      await van(
        "trips/cancel",
        { tripId: t.id, reason: "Replaced by the test-day van-day load trip" },
        `cancel:${t.id}`,
      );
      [t] = await tripOf(s3.id);
      did = "created";
    }
    if (!t) {
      const vehicle = await one(
        db`select id from vehicles where vehicle_code='SMP-TRIAL-VAN3' and status='active'`,
      );
      const route =
        seeded?.route_id ??
        (
          await one(
            db`select route_id from van_trips where vehicle_id=${vehicle.id} and route_id is not null order by created_at desc limit 1`,
          )
        )?.route_id;
      const have = await one(
        db`select id from van_rosters where vehicle_id=${vehicle.id} and seller_profile_id=${s3.id} and status<>'ended' and deleted_at is null and effective_from<=${TODAY} and (effective_to is null or effective_to>=${TODAY})`,
      );
      if (!have)
        await van(
          "rosters/save",
          {
            vehicleId: vehicle.id,
            sellerProfileId: s3.id,
            weekdays: [1, 2, 3, 4, 5, 6, 7],
            effectiveFrom: TODAY,
            routeId: route ?? undefined,
          },
          `roster:${vehicle.id}:${s3.id}`,
        );
      await van(
        "trips/generate",
        { date: TODAY, unitId: s3.org_unit_id },
        `generate:${s3.org_unit_id}`,
      );
      [t] = await tripOf(s3.id);
      if (!t) throw new Error("trips/generate made no trip for van3@trial");
      did = "created";
    }
    let plan = await planRow(t.id);
    if (!plan) throw new Error(`van3's trip ${t.trip_number} has no planned load`);
    if (plan.state === "suggested") {
      // A small clean load the depot can free (the route suggestion can be short at the depot): 3 stocked
      // products x 48 pieces, every other suggested line set to 0.
      // Lot-tracked depot stock must be released and unexpired on the service day (openDocument reserves lots).
      const products =
        await db`select b.product_id as id from inventory_lot_balances b join inventory_lots l on l.id=b.lot_id join products p on p.id=b.product_id
          where b.location_id=${t.source_location_id} and b.stock_status='available' and l.quality_status='released' and p.active
            and (l.expires_at is null or l.expires_at>${new Date(`${TODAY}T23:59:59+08:00`)})
          group by b.product_id,p.code having sum(b.available_base)>=96 order by sum(b.available_base) desc,p.code limit 3`;
      if (products.length < 3)
        throw new Error("the depot has fewer than 3 products with eligible lot stock");
      const keep = new Set(products.map((/** @type {any} */ p) => p.id));
      const others =
        await db`select product_id from van_planned_load_lines where planned_load_id=${plan.id}`;
      await van(
        "loads/edit",
        {
          tripId: t.id,
          lines: [
            ...products.map((/** @type {any} */ p) => ({
              productId: p.id,
              quantityBase: "48",
            })),
            ...others
              .filter((/** @type {any} */ o) => !keep.has(o.product_id))
              .map((/** @type {any} */ o) => ({
                productId: o.product_id,
                quantityBase: "0",
              })),
          ],
        },
        `edit-load:${t.id}`,
      );
      const ok = await van(
        "loads/approve-plan",
        { tripIds: [t.id] },
        `approve-load:${t.id}`,
      );
      if (!ok.approved)
        throw new Error(
          `approve-plan refused: ${ok.results?.[0]?.message ?? JSON.stringify(ok).slice(0, 200)}`,
        );
      plan = await planRow(t.id);
      did = "created";
    }
    if (["approved", "picking"].includes(plan.state)) {
      if (plan.state === "approved")
        await clerk("loads/pick", { tripId: t.id }, `pick:${t.id}`);
      await clerk(
        "loads/dispatch",
        {
          tripId: t.id,
          driverName: "Sample Driver Ramon",
          vehiclePlate: "SMP TRIAL 3",
        },
        `dispatch:${t.id}`,
      );
      did = "created";
    }
    return did;
  },
  async () => {
    const s3 = await profile(VAN3);
    const [t] = await tripOf(s3.id);
    const plan = t && (await planRow(t.id));
    return {
      van3Trip: t ? `${t.trip_number}/${t.status}` : null,
      van3LoadCanAccept: plan?.state === "dispatched",
    };
  },
);

// ---------------------------------------------------------------- r6: agent1@trial targets: On track + a % target (FLD-213)
// Sales value already has a seeded Behind target. Publish (territory -> agent cascade, office submit + second-person
// approve) a Calls target he is ahead of pace on and an MSL compliance rate target ("of 90%").
const FIELD_TARGETS = /** @type {const} */ ([
  ["calls", 250],
  ["msl_compliance", 9000],
]);
section(
  "agent1-targets",
  ["FLD-213", "FLD-214", "FLD-216"],
  async () => {
    let did = "kept";
    const me = await profile(FIELD);
    const area = await one(
      db`select territory_id from territory_salespeople where profile_id=${me.id} and deleted_at is null and effective_from<=now() and (effective_to is null or effective_to>now()) order by effective_from desc limit 1`,
    );
    if (!area) throw new Error("agent1@trial has no territory today");
    const month = TODAY.slice(0, 7);
    for (const [metric, amount] of FIELD_TARGETS) {
      const have = await one(
        db`select 1 as x from target_cascades c join target_cascade_lines l on l.cascade_id=c.id where c.month=${month} and c.metric=${metric} and c.status='published' and c.child_level='agent' and l.child_key=${me.id}`,
      );
      if (have) continue;
      const base = {
        month,
        metric,
        parentLevel: "territory",
        parentKey: area.territory_id,
      };
      const look = await api(ADMIN, "/api/v1/targets/cascade/preview", {
        ...base,
        parentAmount: amount,
      });
      const kids = look.lines.map((/** @type {any} */ l) => l.key);
      if (!kids.includes(me.id))
        throw new Error(`agent1@trial is not a child of territory ${area.territory_id}`);
      const additive = metric !== "msl_compliance";
      const sent = await api(ADMIN, "/api/v1/targets/cascade/submit", {
        ...base,
        parentAmount: additive ? amount * kids.length : amount,
        lines: kids.map((/** @type {string} */ k) => ({ key: k, amount })),
        idempotencyKey: key(`target:${metric}:${area.territory_id}`),
        sourceRef: `${TAG} test-day fixture (FLD-213)`,
      });
      if (sent.status === "submitted") {
        const body = {
          cascadeId: sent.id,
          decision: "approve",
          contentHash: sent.contentHash,
        };
        try {
          await api(APPROVER, "/api/v1/targets/cascade/decide", body);
        } catch (e) {
          if (![403, 404].includes(/** @type {any} */ (e).status)) throw e;
          await api(MANAGER, "/api/v1/targets/cascade/decide", body);
        }
      }
      did = "created";
    }
    return did;
  },
  async () => {
    const me = await profile(FIELD);
    const rows =
      await db`select c.metric,l.amount::bigint as amount from target_cascades c join target_cascade_lines l on l.cascade_id=c.id where c.month=${TODAY.slice(0, 7)} and c.status='published' and c.child_level='agent' and l.child_key=${me.id}`;
    const has = (/** @type {string} */ m) =>
      rows.some((/** @type {any} */ r) => r.metric === m);
    const sales = await one(
      db`select count(*)::int n from sales_targets where profile_id=${me.id} and month=${TODAY.slice(0, 7)} and metric='sales_value' and deleted_at is null`,
    );
    return {
      salesValueTarget: sales.n,
      callsTarget: has("calls"),
      mslRateTarget: has("msl_compliance"),
    };
  },
);

// ---------------------------------------------------------------- r6: programme feature list (WEB-148)
section(
  "programme",
  ["WEB-148"],
  async () => {
    const n = await one(db`select count(*)::int n from spec_features`);
    if (n.n > 0) return "kept";
    // The documented admin load (packages/db/seed/programme-run.js); safe to repeat.
    const { seedProgramme } = await import("./programme.js");
    await seedProgramme(db);
    return "created";
  },
  async () => {
    const f = await one(db`select count(*)::int n from spec_features`);
    const w = await one(db`select count(*)::int n from spec_waves`);
    return { features: f.n, waves: w.n };
  },
);


// ================================================================ r6 A5: last-retest fixtures (SP-0169)
// Ported from the round-6 lane-helper fixtures (COORD.md LANE-HELPER lines) so a fresh reset reports them OK.
// Business writes go through the lane API or the SAP mock's control feed; phone-originated rows (field order,
// field change capture, evidence photo, checklist) are marked sample rows, like the new-stores section.
const VAN3_R6 = "van3@trial.sunpride.test";
const { addTrialRow: addTrialRowR6 } = await import("./trial-wiring.js");
const { BATCH: BATCH_R6, rowId: rowIdR6 } = await import("./store.js");
/** Marked sample row, created once per day key. @param {string} table @param {string} k @param {any} values */
async function markedRow(table, k, values) {
  const m = await one(
    db`select row_id from sample_data_rows where batch=${BATCH_R6} and table_name=${table} and key=${`${table}:trial-td-${k}`}`,
  );
  if (m) return { row: { ...values, id: m.row_id }, made: false };
  return { row: await addTrialRowR6(db, table, `td-${k}`, values), made: true };
}
const SAP_PORT = process.env.SAP_PORT ?? "4712";
/** Two customer price conditions with the same precedence (different prices) => no single price => "Office price".
 * Sent through the SAP mock's control feed; the API's master pull (about a minute) brings them in.
 * @param {string} product @param {string} customer @returns {Promise<boolean>} made */
async function officePrice(product, customer) {
  const keys = [`TD-OFFICE-${customer}-${product}-A`, `TD-OFFICE-${customer}-${product}-B`];
  const have = await one(
    db`select count(*)::int n from sap_replicas where kind='condition' and sap_key in ${db(keys)}`,
  );
  if (have.n === 2) return false;
  const file = process.env.SAP_TOKEN_FILE;
  if (!file) throw new Error("SAP_TOKEN_FILE is required (test-day.sh passes it)");
  const { readFileSync } = await import("node:fs");
  const token = readFileSync(file, "utf8").trim();
  const from = Date.now() - 60_000;
  const items = keys.map((k, i) => ({
    schemaVersion: 1,
    organizationId: "sunpride",
    kind: "condition",
    key: k,
    source: "sample",
    effectiveFrom: from,
    effectiveTo: null,
    deleted: false,
    version: 1,
    data: {
      productCode: product,
      uom: "PC",
      customerCode: customer,
      channelKey: null,
      currency: "PHP",
      unitPriceCentavos: 11000 + i * 200,
      taxCode: "SAMPLE-VAT12",
      taxBasisPoints: 1200,
      taxInclusive: true,
      precedence: 50,
      priceListCode: `TD-OFFICE-${customer}`,
    },
  }));
  const res = await fetch(`http://127.0.0.1:${SAP_PORT}/control/masters`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) throw new Error(`SAP mock masters -> ${res.status}`);
  for (let i = 0; i < 36; i++) {
    const n = await one(
      db`select count(*)::int n from sap_replicas where kind='condition' and sap_key in ${db(keys)}`,
    );
    if (n.n === 2) return true;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`office price ${product}@${customer} not pulled from SAP within 3 min`);
}
const officePriced = async (/** @type {string} */ product, /** @type {string} */ customer) =>
  (
    await one(
      db`select count(*)::int n from sap_replicas where kind='condition' and sap_key like ${`TD-OFFICE-${customer}-${product}-%`}`,
    )
  ).n === 2;

// ---------------------------------------------------------------- VAN-028/029: an office-priced product on van@'s route
const VAN_OFFICE = { product: "SMP-LYC-565", customer: "SMP-C0077" };
section(
  "r6-van-office-price",
  ["VAN-028", "VAN-029"],
  async () => ((await officePrice(VAN_OFFICE.product, VAN_OFFICE.customer)) ? "created" : "kept"),
  async () => {
    const s = await profile(VAN);
    const [t] = await tripOf(s.id);
    const onTruck =
      t &&
      (await one(
        db`select count(*)::int n from inventory_balances b join products p on p.id=b.product_id join van_trips t on t.truck_location_id=b.location_id where t.id=${t.id} and p.code=${VAN_OFFICE.product} and b.available_base>0`,
      ));
    return {
      officePriced: (await officePriced(VAN_OFFICE.product, VAN_OFFICE.customer))
        ? `${VAN_OFFICE.product}@${VAN_OFFICE.customer}`
        : false,
      productOnVanTruck: onTruck?.n ?? 0,
    };
  },
);

// ---------------------------------------------------------------- WEB-142: a claim with linkable evidence (checklist + photo)
const claimRef = () => `SAMPLE-CLAIM-tpm-${TODAY.slice(0, 7)}-0`;
section(
  "r6-claim-evidence",
  ["WEB-142"],
  async () => {
    let did = "kept";
    const c = await one(
      db`select c.*,m.code as campaign_code from claims c join campaign_versions v on v.id=c.campaign_version_id join campaigns m on m.id=v.campaign_id where c.reference=${claimRef()}`,
    );
    if (!c) throw new Error(`claim ${claimRef()} is not seeded`);
    const from = String(c.period_from instanceof Date ? c.period_from.toISOString() : c.period_from).slice(0, 10);
    // 1) Checklist: a compliant promotion check for the claim's campaign on an existing (seeded) audit in the period.
    const audit = await one(
      db`select a.* from merchandising_audits a join campaign_versions v on v.id=${c.campaign_version_id} and v.effective_from<=a.device_time and v.effective_to>a.device_time
        where a.deleted_at is null and a.service_date between ${from} and ${TODAY} and a.device_time<=now() ${c.outlet_id ? db`and a.outlet_id=${c.outlet_id}` : db``}
        order by a.device_time desc limit 1`,
    );
    if (!audit) throw new Error("no merchandising audit in the claim period");
    const chk = await markedRow("merchandising_compliance_checks", "r6-claim-checklist", {
      organization_id: "sunpride",
      org_unit_id: audit.org_unit_id,
      audit_id: audit.id,
      outlet_id: audit.outlet_id,
      service_date: audit.service_date,
      kind: "promotion",
      finding: "compliant",
      program_ref: c.campaign_code,
      action_taken: `${TAG} promotion display verified (WEB-142)`,
    });
    if (chk.made) did = "created";
    // 2) Photo: a stored evidence photo on a completed visit in the period (claim outlet if the claim has one).
    const visit = await one(
      db`select v.* from visit_executions v where v.deleted_at is null and v.state='completed' and v.service_date between ${from} and ${TODAY}
        and v.checked_in_at<=now() ${c.outlet_id ? db`and v.outlet_id=${c.outlet_id}` : db``} order by v.checked_in_at desc limit 1`,
    );
    if (!visit) throw new Error("no completed visit in the claim period");
    const have = await one(
      db`select row_id from sample_data_rows where batch=${BATCH_R6} and key=${"field_evidence_files:trial-td-r6-claim-photo"}`,
    );
    if (!have) {
      /** @param {string} t @param {string} k @param {any} v */
      const ensure = async (t, k, v) => (await markedRow(t, k, v)).row;
      const file = await samplePhoto(visit.assignee_profile_id, "r6-claim-photo-file", ensure);
      const at = new Date(Math.min(Date.now() - 60_000, +new Date(visit.checked_in_at) + 120_000));
      await markedRow("field_evidence_files", "r6-claim-photo", {
        organization_id: "sunpride",
        org_unit_id: visit.org_unit_id,
        storage_id: file.id,
        visit_id: visit.id,
        owner_profile_id: visit.assignee_profile_id,
        outlet_id: visit.outlet_id,
        mime: "image/jpeg",
        size_bytes: file.size,
        checksum: file.sha256,
        captured_at: at.toISOString(),
        photo_type: "display",
        uploaded_at: at.toISOString(),
        status: "verified",
      });
      did = "created";
    }
    return did;
  },
  async () => {
    const c = await one(db`select id,status from claims where reference=${claimRef()}`);
    const opts = c ? await api(APPROVER, `/api/v1/tpm/claims/evidence-options?id=${c.id}`) : { rows: [] };
    const kinds = new Set(opts.rows.map((/** @type {any} */ r) => r.kind));
    return {
      claim: c ? `${claimRef()}/${c.status}` : null,
      checklistOption: kinds.has("checklist"),
      photoOption: kinds.has("photo"),
    };
  },
);

// ---------------------------------------------------------------- WEB-143: a customer portal login (sign-in, no employee profile)
const PORTAL_EMAIL = "td-portal@customer.sunpride.test";
const portalFile = () =>
  `${process.env.HOME}/.sunpride-keys/${LANE_SHORT()}-portal-login.txt`;
const LANE_SHORT = () => (String(process.env.LANE_DB).endsWith("_fixture") ? "fixture" : "codex");
section(
  "r6-portal-login",
  ["WEB-143"],
  async () => {
    const u = await one(db`select id from users where lower(email)=${PORTAL_EMAIL}`);
    if (u) return "kept";
    // A customer login has no invitation (sign-up would make an employee profile), so the kit writes the
    // users row the way the API's sign-up does (argon2id), as a marked sample row. Password: 0600 key file only.
    const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
    const { randomBytes } = await import("node:crypto");
    const f = portalFile();
    const pw = existsSync(f)
      ? readFileSync(f, "utf8").split(" · ").at(-1)?.trim()
      : `TD-${randomBytes(9).toString("base64url")}`;
    if (!existsSync(f)) writeFileSync(f, `${PORTAL_EMAIL} · ${pw}\n`, { mode: 0o600 });
    const hash = await Bun.password.hash(String(pw), { algorithm: "argon2id" });
    await markedRow("users", "r6-portal-login", { email: PORTAL_EMAIL, password_hash: hash });
    return "created";
  },
  async () => {
    const s = await api(ADMIN, "/api/v1/mt/settings");
    const ext = (s.externalUsers ?? []).find((/** @type {any} */ u) => u.email === PORTAL_EMAIL);
    return { portalLoginListed: ext ? PORTAL_EMAIL : false, passwordFile: portalFile().split("/").at(-1) ?? null };
  },
);

// ---------------------------------------------------------------- WEB-175: a field change request with a moved pin (Pin to keep)
section(
  "r6-change-moved-pin",
  ["WEB-175", "WEB-173"],
  async () => {
    const agent = await profile(AGENT);
    const agent1 = await profile(FIELD);
    const batch = await one(
      db`select id from census_batches where org_unit_id=${agent.org_unit_id} order by created_at limit 1`,
    );
    if (!batch) throw new Error("no census batch in agent@'s unit");
    const store = await one(db`select o.id,o.name,o.address,p.latitude,p.longitude from planned_visits v join outlets o on o.id=v.outlet_id
      join outlet_pins p on p.outlet_id=o.id and p.status='verified' and p.effective_to is null and p.deleted_at is null
      where v.assignee_profile_id=${agent.id} and v.service_date=${TODAY} order by o.code offset 3 limit 1`);
    const now = new Date().toISOString();
    const { row, made } = await markedRow("census_captures", "r6-change-moved-pin", {
      batch_id: batch.id,
      actor_profile_id: agent1.id,
      app: "field-android",
      kind: "change",
      target_outlet_id: store.id,
      name: store.name,
      address: `${store.address ?? "Sample address"} (moved)`,
      latitude: Number(store.latitude) + 0.0134,
      longitude: Number(store.longitude) + 0.0082,
      accuracy_meters: 9,
      location_source: "places",
      location_provider: "places",
      location_recorded_at: now,
      place_id: `td-searched-${TODAY}`,
      formatted_address: store.address ?? "Sample address",
      owner_name: "Sample Owner Lima",
      owner_phone: "0917 555 0650",
      captured_at: now,
      payload_hash: `td-cap-moved-${TODAY}`,
      duplicate_flag: false,
      duplicate_candidates: [],
      acknowledged_duplicate_ids: [],
      previous_values: { address: store.address ?? "Sample address" },
    });
    if (!(await one(db`select 1 as x from census_place_checks where capture_id=${row.id}`)))
      await db`insert into census_place_checks(capture_id,status,place_latitude,place_longitude,distance_meters,checked_at) values(${row.id},'mismatch',${Number(store.latitude)},${Number(store.longitude)},1730,now())`;
    return made ? "created" : "kept";
  },
  async () => {
    const r = await one(db`select c.kind,pc.status,(select count(*)::int from census_reviews r where r.capture_id=c.id) reviewed from census_captures c
      join sample_data_rows m on m.row_id=c.id::text and m.key=${"census_captures:trial-td-r6-change-moved-pin"} left join census_place_checks pc on pc.capture_id=c.id`);
    return { changeWithMovedPin: r?.kind === "change" && r.status === "mismatch", undecided: r ? r.reviewed === 0 : false };
  },
);

// ---------------------------------------------------------------- WEB-106: a captured phone order in Field order review (needs price setup)
const ORDER_PRODUCT = "SMP-PCH-227";
section(
  "r6-field-order-review",
  ["WEB-106"],
  async () => {
    let did = "kept";
    const agent = await profile(AGENT);
    const have = await one(
      db`select row_id from sample_data_rows where batch=${BATCH_R6} and key=${"visit_activities:trial-td-r6-field-order"}`,
    );
    if (have) return did;
    // A visit checked in before now (seeded day history runs 06:00-11:55), on a store with a customer account.
    const v = await one(db`select v.*,c.code as customer_code from visit_executions v join outlet_customer_links l on l.outlet_id=v.outlet_id and l.deleted_at is null
      join customers c on c.id=l.customer_id where v.assignee_profile_id=${agent.id} and v.service_date=${TODAY} and v.state='completed' and v.checked_in_at<=now()-interval '3 minutes'
      order by v.checked_in_at desc limit 1`);
    if (!v) throw new Error("agent@ has no completed visit before now; rerun --only r6-field-order-review later in the day");
    if (await officePrice(ORDER_PRODUCT, v.customer_code)) did = "created";
    const p = await one(db`select id from products where code=${ORDER_PRODUCT}`);
    const at = new Date(Math.max(+new Date(v.checked_in_at) + 60_000, Date.now() - 120_000));
    await markedRow("visit_activities", "r6-field-order", {
      organization_id: v.organization_id,
      org_unit_id: v.org_unit_id,
      visit_id: v.id,
      assignee_profile_id: v.assignee_profile_id,
      outlet_id: v.outlet_id,
      activity_kind: "order_intent",
      activity: {
        kind: "order_intent",
        lines: [{ uom: "PC", quantity: 4, productId: p.id }],
        source: "sample",
        clientOrderId: `${TAG}-FIELD-ORDER-1`,
      },
      device_time: at.toISOString(),
      server_time: new Date().toISOString(),
    });
    // The insert trigger queues it; the API's drain (about a minute) moves it to review.
    for (let i = 0; i < 24; i++) {
      const q = await one(db`select q.status from order_intent_queue q join visit_activities a on a.id=q.activity_id where a.activity->>'clientOrderId'=${`${TAG}-FIELD-ORDER-1`}`);
      if (q && q.status !== "pending") break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    return "created";
  },
  async () => {
    const q = await one(db`select q.status,q.review_code from order_intent_queue q join visit_activities a on a.id=q.activity_id where a.activity->>'clientOrderId'=${`${TAG}-FIELD-ORDER-1`}`);
    const rows = (await api(ADMIN, "/api/v1/orders/field-review")).rows ?? [];
    return {
      fieldOrderInReview: q?.status === "review" ? q.review_code ?? "review" : false,
      listedInFieldOrderReview: rows.length,
    };
  },
);

// ---------------------------------------------------------------- WEB-082/084: one clean suggested load (released, unexpired lots) on a non-VAN truck
const cleanLoadTrip = () =>
  one(db`select t.id,t.trip_number,t.status,t.source_location_id from van_trips t join profiles p on p.id=t.salesperson_profile_id
    where t.service_date=${TODAY} and t.trip_number like 'SMP-TRIAL-area-%' and lower(p.email)=${AGENT} and t.status not in ('cancelled','closed') and t.deleted_at is null order by t.created_at limit 1`);
section(
  "r6-clean-load",
  ["WEB-082", "WEB-084"],
  async () => {
    const t = await cleanLoadTrip();
    if (!t) throw new Error("agent@'s trial-truck trip for today is missing");
    let plan = await one(db`select id,state,attention from van_planned_loads where trip_id=${t.id} order by created_at desc limit 1`);
    if (plan?.state === "suggested" && (plan.attention ?? []).length === 0) return "kept";
    if (plan && plan.state !== "suggested") return "kept";
    // Released lots that stay sellable for 30+ days at the trip's depot (quarantined/near-expiry lots fail approval).
    const products =
      await db`select b.product_id as id from inventory_lot_balances b join inventory_lots l on l.id=b.lot_id join products p on p.id=b.product_id
        where b.location_id=${t.source_location_id} and b.stock_status='available' and l.quality_status='released' and p.active
          and (l.expires_at is null or l.expires_at>${new Date(Date.parse(`${TODAY}T00:00:00+08:00`) + 30 * 86_400_000)})
        group by b.product_id,p.code having sum(b.available_base)>=200 order by p.code limit 4`;
    if (products.length < 2) throw new Error("the depot has fewer than 2 products with released lot stock");
    if (!plan) {
      const yesterday = await one(db`select id from van_trips where service_date<${TODAY} and status not in ('cancelled') and deleted_at is null order by service_date desc, trip_number limit 1`);
      await van("loads/copy", { tripId: t.id, fromTripId: yesterday.id }, `copy-load:${t.id}`);
      plan = await planRow(t.id);
    }
    const keep = new Set(products.map((/** @type {any} */ p) => p.id));
    const others = await db`select product_id from van_planned_load_lines where planned_load_id=${plan.id}`;
    await van(
      "loads/edit",
      {
        tripId: t.id,
        lines: [
          ...products.map((/** @type {any} */ p) => ({ productId: p.id, quantityBase: "48" })),
          ...others
            .filter((/** @type {any} */ o) => !keep.has(o.product_id))
            .map((/** @type {any} */ o) => ({ productId: o.product_id, quantityBase: "0" })),
        ],
        note: `${TAG} clean load for WEB-082/084`,
      },
      `edit-clean-load:${t.id}`,
    );
    return "created";
  },
  async () => {
    const t = await cleanLoadTrip();
    const plan = t && (await one(db`select state,attention from van_planned_loads where trip_id=${t.id} order by created_at desc limit 1`));
    return {
      trip: t ? `${t.trip_number}/${t.status}` : null,
      suggestedLoad: plan?.state === "suggested",
      clean: plan ? (plan.attention ?? []).length === 0 : false,
    };
  },
);

// ---------------------------------------------------------------- FLD-163: supervisor@'s own plan today (copy of agent@'s stops)
section(
  "r6-supervisor-plan",
  ["FLD-163"],
  async () => {
    const sup = await one(db`select * from profiles where lower(email)=${SUPERVISOR} and deleted_at is null`);
    const have = await one(db`select 1 as x from planned_visits where assignee_profile_id=${sup.id} and service_date=${TODAY} and status='planned' and deleted_at is null`);
    if (have) return "kept";
    const tpl = await one(db`select * from profiles where lower(email)=${AGENT} and deleted_at is null`);
    const { ensureTodayPlan } = await import("./trial-wiring.js");
    await ensureTodayPlan(db, sup, tpl, "supervisor");
    return "created";
  },
  async () => {
    const sup = await profile(SUPERVISOR);
    const n = await one(db`select count(*)::int n from planned_visits where assignee_profile_id=${sup.id} and service_date=${TODAY} and status='planned' and deleted_at is null`);
    return { supervisorPlannedStops: n.n };
  },
);

// ---------------------------------------------------------------- FLD-095 / FLD-082 (B): one agent1 store with no call flow and no call sheet
// The office cannot bind a store type to "no call flow" (binding/publish requires a published profile), so the kit
// classifies one agent1 stop as class D (unique channel/class pair) through the office command and adds a marked
// binding of that pair to a profile with no definition. The stop's call sheet account is retired (soft delete).
const NO_FLOW = "td_no_call_flow";
const POTENTIAL_D = { transactionsPerDay: 10, averageBasketCentavos: 1000, tradingDaysPerMonth: 26, captureRatePct: 100 };
const noFlowStop = async () => {
  const stops = await fieldStops();
  return stops.at(-1);
};
section(
  "r6-store-no-call-flow",
  ["FLD-095", "FLD-082"],
  async () => {
    let did = "kept";
    const stop = await noFlowStop();
    if (!stop) throw new Error("agent1@trial has no planned stops today");
    if (stop.classification !== "D") {
      const policy = await one(
        db`select v.id from master_definitions d join master_versions v on v.master_id=d.id where d.kind='class_policy' and v.status='active' and v.effective_from<=now() and (v.effective_to is null or v.effective_to>now()) limit 1`,
      );
      await api(
        ADMIN,
        "/api/v1/masters/outlets/classify",
        { outletId: stop.id, policyVersionId: policy.id, inputs: POTENTIAL_D, reason: `${TAG} store without a call flow (FLD-095/082)` },
        { key: key(`classify:${stop.code}:D`) },
      );
      did = "created";
    }
    const bound = await one(
      db`select 1 as x from call_flow_channel_bindings where app='field-android' and channel_code=${stop.channel} and outlet_class='D' and (effective_to is null or effective_to>now())`,
    );
    if (!bound) {
      await markedRow("call_flow_channel_bindings", "r6-no-call-flow", {
        app: "field-android",
        channel_code: stop.channel,
        outlet_class: "D",
        channel_profile: NO_FLOW,
        version: 1,
        effective_from: new Date(Date.now() - 60_000).toISOString(),
        published_by: "system:test-day",
        source: "sample",
      });
      did = "created";
    }
    const sheets = await db`update call_sheet_accounts set deleted_at=now(),updated_at=now() where outlet_id=${stop.id} and deleted_at is null returning id`;
    if (sheets.length) did = "created";
    return did;
  },
  async () => {
    const stop = await noFlowStop();
    const same = await one(db`select count(*)::int n from outlets where channel=${stop.channel} and classification='D' and deleted_at is null`);
    const sheet = await one(db`select count(*)::int n from call_sheet_accounts where outlet_id=${stop.id} and deleted_at is null`);
    const pin = await one(db`select count(*)::int n from outlet_pins where outlet_id=${stop.id} and status='verified' and effective_to is null and deleted_at is null`);
    const b = await one(db`select channel_profile from call_flow_channel_bindings where app='field-android' and channel_code=${stop.channel} and outlet_class='D' and (effective_to is null or effective_to>now())`);
    return {
      store: `${stop.code} ${stop.name}`,
      noCallFlow: b?.channel_profile === NO_FLOW,
      onlyStoreOfItsType: same.n === 1,
      noCallSheet: sheet.n === 0,
      verifiedPin: pin.n,
    };
  },
);

// ---------------------------------------------------------------- POS stock-tab cases: a second openable till for the Senraise cashier
section(
  "r6-second-register",
  ["POS-042", "POS-043", "POS-044", "POS-053", "POS-054", "POS-202"],
  async () => {
    let did = "kept";
    for (const code of ["SAMPLE-CEBU-COLON", NORTH.code]) {
      const r = await registerFor(code);
      if (r && (await cashier(r.id, VAN3_R6))) did = "created";
    }
    return did;
  },
  async () => {
    const regs = await db`select r.terminal_code from store_registers r join inventory_locations l on l.id=r.location_id join store_cashier_assignments a on a.register_id=r.id and a.effective_to is null
      join profiles p on p.id=a.profile_id where lower(p.email)=${VAN3_R6} and r.effective_to is null
      and not exists(select 1 from store_till_days d where d.register_id=r.id and d.business_date=${TODAY} and d.status<>'open')
      and exists(select 1 from inventory_balances b where b.location_id=l.id and b.available_stock_base>0) order by 1`;
    return { van3OpenableRegisters: regs.length >= 2 ? regs.map((/** @type {any} */ r) => r.terminal_code).join(",") : 0 };
  },
);

// ---------------------------------------------------------------- VAN-070/081 + VAN-074..083: van@'s trip started before now, with a start odometer; fresh counts
section(
  "r6-van-trip-start",
  ["VAN-070", "VAN-074", "VAN-075", "VAN-078", "VAN-079", "VAN-081", "VAN-083"],
  async () => {
    const s = await profile(VAN);
    const [t] = await tripOf(s.id);
    if (!t || t.status !== "active") throw new Error("van@ has no active trip today");
    // Seeded day history stamps the trip at 06:00; a damage photo must be newer than the trip (van/media.js),
    // and VAN-081 compares the end odometer with the start one.
    const back = new Date(Date.now() - 60 * 60_000);
    const r = await db`update van_trips set created_at=least(created_at,${back}),started_at=least(coalesce(started_at,${back}),${back}),
      start_odometer_km=coalesce(start_odometer_km,48210),updated_at=now() where id=${t.id} and (created_at>${back} or started_at is null or started_at>${back} or start_odometer_km is null) returning id`;
    return r.length ? "created" : "kept";
  },
  async () => {
    const s = await profile(VAN);
    const [t] = await tripOf(s.id);
    const row = t && (await one(db`select * from van_trips where id=${t.id}`));
    const counts = t && (await one(db`select (select count(*)::int from van_cash_counts where trip_id=${t.id}) + (select count(*)::int from van_stock_counts where trip_id=${t.id}) n`));
    const { expectedStock, assertTruckStock } = await import(
      new URL("../../../apps/api/src/domains/van/facts.js", import.meta.url).href
    );
    let ledger = true;
    try {
      if (row) await assertTruckStock(db, row, await expectedStock(db, row.id));
    } catch {
      ledger = false;
    }
    return {
      trip: row ? `${row.trip_number}/${row.status}` : null,
      startedBeforeNow: row ? +new Date(row.created_at) < Date.now() && +new Date(row.started_at) < Date.now() : false,
      startOdometerKm: row?.start_odometer_km ?? null,
      noCountsYet: counts ? counts.n === 0 : false,
      stockLedgerMatchesTruck: ledger,
    };
  },
);
