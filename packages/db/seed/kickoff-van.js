#!/usr/bin/env bun
/**
 * Kickoff van demo fixture: ONE sample van seller, ONE existing dedicated sample truck, ONE planned trip + planned load
 * for today (Manila), so the installed van phone can confirm the load, start the trip, sell and settle.
 *
 * Why this exists: the van phone shows "No trip assigned for today" until the OFFICE plans a trip. Seeded trucks that
 * still hold stock cannot be re-planned (`trips/plan` refuses) and historic work must never be touched.
 *
 * Safety contract
 *  - Default is a read-only DRY RUN. `apply` is explicit and the CLI additionally requires
 *    `--confirm-database <current database name>`.
 *  - Trip and load are created ONLY through the real van office commands (`trips/plan`, `loads/plan` =
 *    `planTrip`/`planLoad` through `van/commands.js command()`), so capability/scope checks, the `van_web_commands`
 *    idempotency ledger, audit and the change feed are the product's own. No van table is written with SQL.
 *  - Nothing is posted: stock moves only when the seller's phone sends the real `load.confirm`; nothing is approved,
 *    confirmed, counted or closed here. No fabricated financial authority.
 *  - ONE transaction under an advisory lock; any refusal rolls everything back (all or none).
 *  - CURRENT-DAY fixture only: any date other than today (Manila) is refused, past or future.
 *  - Idempotent while the owned trip is still `planned`/`loading`: deterministic command keys; a rerun replays the
 *    stored result. Identity, ownership, vehicle, depot and product checks are ALWAYS re-run, and a product/quantity set
 *    that differs from the stored load is refused (`owned_load_differs`), never silently replaced.
 *  - Once the owned trip progressed (load confirmed, started, closed, cancelled ...) a rerun is refused with the named
 *    conflict `owned_trip_progressed`. There is deliberately NO replay of progressed trips: the helper never reseeds or
 *    touches stock, and it refuses rather than guess.
 *  - Never resets, edits, cancels or re-plans anything it does not own. It never edits devices.
 *  - Fails closed on: ANY other open trip (any date) for the seller or for the vehicle, a vehicle that is not an EMPTY
 *    marked sample truck used only by this seller, a non-sample participant (seller, office actor + its effective
 *    assignment and org unit, vehicle, locations, depot org unit, route, route outlets, products), an ambiguous office
 *    email, missing/foreign active van device, depot stock that is short/reserved, unpriced products and missing,
 *    unusable or ambiguous fiscal/tender configuration.
 *  - Provenance: the scoped office actor is unchanged; one `van_audit_events` row (`sample.kickoff.van.fixture`) tags the
 *    trip as created by this helper, and fiscal fixture rows are audited under `system:kickoff-van-fixture`.
 *
 * Sample-only contract: every participant needs a VERIFIED `sample_data_rows` marker of the seed batch whose key and id
 * re-derive as `store.js` derives them (what `resetDemo` checks). Email suffixes are never trusted.
 *
 * Optional `--with-fiscal-sample` adds ONLY the missing sales_invoice / official_receipt vehicle-level sample series (never
 * credit_memo/delivery_receipt: the cash chain does not use them) and, when the unit has NO cash tender rule of any date,
 * a cash tender rule, using the same deterministic ids as `fiscal.js seedFiscal`. It is additive only: it never edits or
 * adopts an existing row (no ON CONFLICT), never shadows a unit-level series, never overwrites a disabled/overlapping
 * policy, and it fails closed on unusable, suspended, expired, exhausted, ambiguous or colliding fiscal setup. Fiscal
 * setup is serialized with `fiscal.js` through `pg_advisory_xact_lock(4300019)` and re-assessed inside the transaction;
 * after the inserts the real `issuanceGate`/`tenderPolicy` are re-run (no serial is ever allocated). A new unit-wide cash
 * rule is only seeded when every unit consumer (profiles, assignments, vehicles, locations) is a sample row.
 * Sample registrations are `sample_not_filed`; they cannot authorize real tax documents.
 *
 * No credentials are read. The CLI takes DATABASE_URL from the environment and never prints it.
 */
import { createDb, tx } from "../src/client.js";
import { BATCH, rowId } from "./store.js";

const KEY_VERSION = "kickoff-van:v1";
const FISCAL_BATCH = "sunpride-fiscal-sample";
const FISCAL_LOCK = 4300019; // same advisory lock `fiscal.js seedFiscal` takes
const FISCAL_ACTOR = "system:kickoff-van-fixture";
const FISCAL_TYPES = /** @type {const} */ ([
  ["sales_invoice", "SI"],
  ["official_receipt", "OR"],
]);
const DAY_MS = 86_400_000;
// Mirror the van bundle bounds (apps/api/src/domains/van/projection.js): 500 products, 600 outlets, 600 price lines.
const PROJECTION_PRODUCTS = 500;
const PROJECTION_OUTLETS = 600;
const PROJECTION_PRICE_LINES = 600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN = [
  "planned",
  "loading",
  "loaded",
  "active",
  "closing",
  "reconciling",
  "review_required",
];

/** @param {number} ms */
export const manilaDate = (ms) =>
  new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);

export class KickoffVanConflict extends Error {
  /** @param {any} report */
  constructor(report) {
    super(
      `Kickoff van refused: ${report.conflicts.map((/** @type {any} */ c) => c.code).join(", ")}`,
    );
    this.name = "KickoffVanConflict";
    this.report = report;
  }
}

/** @typedef {{sellerProfileId?:string, officeProfileId?:string, officeEmail?:string, date?:string, vehicleId?:string,
 *   products?:string[], quantity?:number, withFiscalSample?:boolean, now?:number}} KickoffVanOptions */

/** @param {KickoffVanOptions} o */
function normalize(o = {}) {
  const now = o.now ?? Date.now();
  const today = manilaDate(now);
  const date = o.date ?? today;
  if (!o.sellerProfileId || !UUID.test(o.sellerProfileId))
    throw new Error(
      "sellerProfileId (the exact signed-in van profile id) is required",
    );
  for (const id of [o.officeProfileId, o.vehicleId])
    if (id != null && !UUID.test(id)) throw new Error("ids must be UUIDs");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    manilaDate(Date.parse(`${date}T00:00:00+08:00`)) !== date
  )
    throw new Error("date must be a real YYYY-MM-DD Manila date");
  const quantity = o.quantity ?? 24;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500)
    throw new Error("quantity must be 1..500");
  if (o.products && (o.products.length < 1 || o.products.length > 10))
    throw new Error("products must list 1..10 codes");
  return {
    now,
    today,
    date,
    quantity,
    products: o.products ?? null,
    productCount: 3,
    withFiscalSample: o.withFiscalSample === true,
    sellerProfileId: o.sellerProfileId.toLowerCase(),
    officeProfileId: o.officeProfileId?.toLowerCase() ?? null,
    officeEmail: (o.officeEmail ?? "admin@sunpride.test").toLowerCase(),
    vehicleId: o.vehicleId?.toLowerCase() ?? null,
  };
}

const commandKey = (
  /** @type {string} */ seller,
  /** @type {string} */ date,
  /** @type {string} */ step,
) => `${KEY_VERSION}:${seller}:${date}:${step}`;

/** Marker verified exactly as `resetDemo` does (batch, key prefix, derived row id, derived marker id).
 * @param {any} db @param {string} table @param {(string|null|undefined)[]} ids @param {string} [batch] @returns {Promise<Set<string>>} */
export async function verifiedSample(db, table, ids, batch = BATCH) {
  const list = [...new Set(ids.filter((i) => i != null).map(String))];
  /** @type {Set<string>} */ const ok = new Set();
  if (!list.length) return ok;
  const rows = await db`select id::text as id,key,row_id from sample_data_rows
    where batch=${batch} and table_name=${table} and row_id in ${db(list)}`;
  for (const m of rows) {
    const k = String(m.key);
    // Fiscal fixtures key their marker `<table>:<row_id>`; seed rows key `<table>:<key>` re-derived to the row id.
    const derived =
      batch === BATCH
        ? rowId(table, k.slice(table.length + 1)) === m.row_id &&
          rowId("sample_data_rows", k) === m.id
        : k === `${table}:${m.row_id}`;
    if (k.startsWith(`${table}:`) && derived) ok.add(m.row_id);
  }
  return ok;
}
/** @param {any} db @param {string} table @param {string|null|undefined} id */
const isSample = async (db, table, id) =>
  id != null && (await verifiedSample(db, table, [id])).has(String(id));
/** @param {any} db @param {{id:string,user_id:string|null}} p */
const sampleIdentity = async (db, p) =>
  Boolean(p.user_id) &&
  (await isSample(db, "profiles", p.id)) &&
  (await isSample(db, "users", p.user_id));

/** @param {any} db @param {string|null} id @param {string} [email] @returns {Promise<any>} */
async function person(db, id, email) {
  if (id) {
    const [p] =
      await db`select id,user_id,email,name,role,status,org_unit_id from profiles where id=${id} and deleted_at is null`;
    return p ?? null;
  }
  // `profiles.email` is unique only case-sensitively: two profiles can match lower(email). Never pick one.
  const rows =
    await db`select id,user_id,email,name,role,status,org_unit_id from profiles where lower(email)=${email} and deleted_at is null order by id limit 2`;
  if (rows.length > 1) return { ambiguous: true };
  return rows[0] ?? null;
}

/** Real API pieces, loaded lazily so a plain dry run of the SQL checks does not need them. Only READ-ONLY org scope
 * hooks are installed (restored afterwards), the same way `kickoff-demo.js` does it.
 */
export async function loadDomain() {
  const base = new URL("../../../apps/api/src/", import.meta.url);
  const [cmds, caps, sync, hookMod, identity, pricing, series, tenders] =
    await Promise.all([
      import(new URL("domains/van/commands.js", base).href),
      import(new URL("core/capabilities.js", base).href),
      import(new URL("core/sync.js", base).href),
      import(new URL("core/hooks.js", base).href),
      import(new URL("domains/org/identity.js", base).href),
      import(new URL("domains/orders/pricing.js", base).href),
      import(new URL("domains/fiscal/series.js", base).href),
      import(new URL("domains/fiscal/tenders.js", base).href),
    ]);
  return {
    caps,
    command: cmds.command,
    planTrip: cmds.planTrip,
    planLoad: cmds.planLoad,
    resolvePrice: pricing.resolvePrice,
    issuanceGate: series.issuanceGate,
    tenderPolicy: tenders.tenderPolicy,
    recordChange: sync.recordChange,
    /** @param {any} p */
    actorFor: (p) => ({
      userId: p.user_id,
      profileId: p.id,
      role: p.role,
      orgUnitId: p.org_unit_id ?? null,
      capabilities: new Set(caps.capabilitiesFor(p.role)),
      subject: p.user_id,
      name: p.name ?? null,
    }),
    /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
    async withScopeHooks(fn) {
      const scope = identity.identityHooks({});
      const keys = ["unitInScope", "scopeUnitIds", "rootUnitId"];
      const saved = Object.fromEntries(keys.map((k) => [k, hookMod.hooks[k]]));
      hookMod.setHooks(Object.fromEntries(keys.map((k) => [k, scope[k]])));
      try {
        return await fn();
      } finally {
        hookMod.setHooks(saved);
      }
    },
  };
}

const inWindow = (/** @type {any} */ r, /** @type {number} */ at) =>
  new Date(r.effective_from).getTime() <= at &&
  (!r.effective_to || new Date(r.effective_to).getTime() > at);
const fiscalIds = (
  /** @type {any} */ vehicle,
  /** @type {string} */ type,
  /** @type {string} */ code,
) => ({
  reg: rowId("fiscal_registrations", `${vehicle.id}-${type}`),
  series: rowId("fiscal_series", `${vehicle.id}-${type}`),
  prefix: `SAMPLE-${vehicle.vehicle_code.toUpperCase().replace(/[^A-Z0-9-]/g, "-")}-${code}`,
});

/**
 * READ-ONLY assessment of everything the cash sale -> settlement chain needs: a usable SI and OR series for this vehicle
 * and an effective enabled cash tender rule for the unit. Reads ALL rows (not only enabled/effective) so disabled,
 * suspended, expired, future, exhausted and overlapping setup is classified, never overwritten. Nothing is allocated.
 * @param {any} db @param {ReturnType<typeof normalize>} o @param {any} vehicle @param {string[]} deviceIds @param {any} domain
 */
async function assessFiscal(db, o, vehicle, deviceIds, domain) {
  /** @type {{code:string, detail:any}[]} */ const bad = [];
  /** @type {Record<string,string>} */ const ranges = {};
  /** @type {string[]} */ const seedTypes = [];
  const unit = vehicle.org_unit_id;
  const regs =
    await db`select * from fiscal_registrations where org_unit_id=${unit} and document_type in ('sales_invoice','official_receipt')`;
  const series = regs.length
    ? await db`select * from fiscal_series where registration_id in ${db(regs.map((/** @type {any} */ r) => r.id))}`
    : [];
  for (const [type, code] of FISCAL_TYPES) {
    const tRegs = regs.filter(
      (/** @type {any} */ r) => r.document_type === type,
    );
    const orphan = tRegs.filter(
      (/** @type {any} */ r) =>
        !series.some((/** @type {any} */ s) => s.registration_id === r.id),
    );
    const scope = series.filter(
      (/** @type {any} */ s) =>
        tRegs.some((/** @type {any} */ r) => r.id === s.registration_id) &&
        (s.vehicle_id == null || s.vehicle_id === vehicle.id),
    );
    if (orphan.length) {
      ranges[type] = "unusable";
      bad.push({
        code: "fiscal_registration_without_series",
        detail: {
          type,
          registrationIds: orphan.map((/** @type {any} */ r) => r.id),
        },
      });
      continue;
    }
    if (!scope.length) {
      // Nothing of this type can reach this vehicle: seeding a vehicle-level row shadows nothing. Prove no id/prefix/marker collision.
      const ids = fiscalIds(vehicle, type, code);
      const [hit] = await db`select
        (select count(*)::int from fiscal_registrations where id=${ids.reg}) regs,
        (select count(*)::int from fiscal_series where id=${ids.series} or prefix=${ids.prefix}) series,
        (select count(*)::int from sample_data_rows where (batch=${FISCAL_BATCH} and key in (${`fiscal_registrations:${ids.reg}`},${`fiscal_series:${ids.series}`}))
          or (table_name='fiscal_registrations' and row_id=${ids.reg}) or (table_name='fiscal_series' and row_id=${ids.series})) markers`;
      if (hit.regs || hit.series || hit.markers) {
        ranges[type] = "collision";
        bad.push({ code: "fiscal_sample_collision", detail: { type, ...hit } });
      } else {
        ranges[type] = "missing";
        seedTypes.push(type);
      }
      continue;
    }
    const effective = scope.filter((/** @type {any} */ s) =>
      inWindow(s, o.now),
    );
    if (effective.length > 1) {
      ranges[type] = "ambiguous";
      bad.push({
        code: "fiscal_series_ambiguous",
        detail: {
          type,
          prefixes: effective.map((/** @type {any} */ s) => s.prefix),
        },
      });
      continue;
    }
    const s = effective[0];
    /** @type {string|null} */ let why = null;
    if (!s) why = "series_not_effective";
    else if (BigInt(s.next_allocate) > BigInt(s.last_serial))
      why = "series_exhausted";
    else {
      const reg = tRegs.find(
        (/** @type {any} */ r) => r.id === s.registration_id,
      );
      try {
        for (const deviceId of deviceIds)
          await domain.issuanceGate(db, reg, deviceId, o.now);
      } catch (e) {
        why = `registration_unusable: ${String(/** @type {any} */ (e)?.message ?? e)}`;
      }
    }
    if (why) {
      ranges[type] = "unusable";
      bad.push({
        code: "fiscal_series_unusable",
        detail: { type, reason: why, prefix: s?.prefix ?? null },
      });
    } else ranges[type] = "ready";
  }

  // Tender: ALL rows of the unit, any method/date/enabled. tenderPolicy refuses the whole unit on any overlap.
  const rules =
    await db`select * from fiscal_tender_rules where org_unit_id=${unit}`;
  const effective = rules.filter((/** @type {any} */ r) => inWindow(r, o.now));
  const dup = effective.filter(
    (/** @type {any} */ r, /** @type {number} */ i) =>
      effective.findIndex((/** @type {any} */ x) => x.method === r.method) !==
      i,
  );
  const cashAll = rules.filter((/** @type {any} */ r) => r.method === "cash");
  const cashNow = effective.filter(
    (/** @type {any} */ r) => r.method === "cash",
  );
  let cash = "ready";
  let seedCash = false;
  if (dup.length) {
    cash = "overlap";
    bad.push({
      code: "tender_policy_overlap",
      detail: {
        methods: [...new Set(dup.map((/** @type {any} */ r) => r.method))],
      },
    });
  } else if (!cashAll.length) {
    cash = "missing";
    seedCash = true;
  } else if (!cashNow.length) {
    cash = "not_effective";
    bad.push({
      code: "cash_tender_not_effective",
      detail: {
        rules: cashAll.map((/** @type {any} */ r) => ({
          from: r.effective_from,
          to: r.effective_to,
          enabled: r.enabled,
        })),
      },
    });
  } else if (!cashNow[0].enabled) {
    cash = "disabled";
    bad.push({
      code: "cash_tender_disabled_by_office",
      detail: { ruleId: cashNow[0].id },
    });
  } else {
    // A scheduled cash rule that overlaps the current one would make tenderPolicy refuse the whole unit once it starts.
    const cur = cashNow[0];
    const clash = cashAll.filter(
      (/** @type {any} */ r) =>
        r.id !== cur.id &&
        new Date(r.effective_from).getTime() <
          (cur.effective_to
            ? new Date(cur.effective_to).getTime()
            : Infinity) &&
        (r.effective_to ? new Date(r.effective_to).getTime() : Infinity) >
          new Date(cur.effective_from).getTime(),
    );
    if (clash.length) {
      cash = "future_overlap";
      bad.push({
        code: "cash_tender_future_overlap",
        detail: { ruleIds: clash.map((/** @type {any} */ r) => r.id) },
      });
    }
  }
  if (cash === "ready" && domain.tenderPolicy) {
    try {
      if (
        !(await domain.tenderPolicy(db, unit, o.now)).some(
          (/** @type {any} */ m) => m.code === "cash",
        )
      )
        throw new Error("cash tender not offered");
    } catch (e) {
      cash = "unusable";
      bad.push({
        code: "tender_policy_unusable",
        detail: { message: String(/** @type {any} */ (e)?.message ?? e) },
      });
    }
  }
  if (seedCash && o.withFiscalSample) {
    // A NEW unit-wide cash rule changes tenders for everyone in the unit: every consumer must be a sample row.
    const consumers = [
      [
        "profiles",
        await db`select id::text id from profiles where org_unit_id=${unit} and deleted_at is null and status='active'`,
      ],
      [
        "employee_assignments",
        await db`select id::text id from employee_assignments where org_unit_id=${unit} and deleted_at is null and effective_from<=${new Date(o.now)} and (effective_to is null or effective_to>${new Date(o.now)})`,
      ],
      [
        "vehicles",
        await db`select id::text id from vehicles where org_unit_id=${unit} and deleted_at is null`,
      ],
      [
        "inventory_locations",
        await db`select id::text id from inventory_locations where org_unit_id=${unit} and deleted_at is null and active`,
      ],
    ];
    /** @type {Record<string,number>} */ const foreign = {};
    for (const [table, rows] of /** @type {[string, any[]][]} */ (consumers)) {
      const ok = await verifiedSample(
        db,
        table,
        rows.map((r) => r.id),
      );
      const n = rows.filter((r) => !ok.has(r.id)).length;
      if (n) foreign[table] = n;
    }
    if (Object.keys(foreign).length)
      bad.push({
        code: "tender_unit_has_non_sample_participants",
        detail: { orgUnitId: unit, foreign },
      });
  }
  return { ranges, seedTypes, cash, seedCash, bad };
}

/** Read-only preflight. `deps.domain` is required for the office-scope and price checks.
 * @param {any} db @param {ReturnType<typeof normalize>} o @param {any} domain */
async function preflight(db, o, domain) {
  /** @type {{code:string, detail:any}[]} */ const conflicts = [];
  /** @param {string} code @param {any} [detail] */
  const refuse = (code, detail = null) => conflicts.push({ code, detail });
  const report = {
    mode: "van-fixture",
    date: o.date,
    seller: /** @type {any} */ (null),
    office: /** @type {any} */ (null),
    devices: /** @type {any[]} */ ([]),
    vehicle: /** @type {any} */ (null),
    excludedVehicles: /** @type {any[]} */ ([]),
    depot: /** @type {any} */ (null),
    route: /** @type {any} */ (null),
    products: /** @type {any[]} */ ([]),
    excludedProducts: /** @type {any[]} */ ([]),
    fiscal: /** @type {any} */ (null),
    owned: /** @type {any} */ ({ tripId: null }),
    conflicts,
    ok: false,
  };
  const done = () => {
    report.ok = conflicts.length === 0;
    return report;
  };
  // CURRENT-DAY fixture: every other date is refused before anything else is read (no future/past options).
  if (o.date !== o.today) {
    refuse(o.date < o.today ? "date_in_past" : "date_not_current_day", {
      date: o.date,
      today: o.today,
    });
    return done();
  }

  // ---- seller: the exact signed-in profile, sample-verified ----
  const seller = await person(db, o.sellerProfileId);
  if (
    !seller ||
    seller.status !== "active" ||
    !seller.user_id ||
    seller.role !== "sales"
  ) {
    refuse("seller_unavailable", { profileId: o.sellerProfileId });
    return done();
  }
  if (!(await sampleIdentity(db, seller))) {
    refuse("seller_not_sample", { profileId: seller.id });
    return done();
  }
  const at = new Date(Math.max(Date.parse(`${o.date}T00:00:00+08:00`), o.now));
  const emps =
    await db`select id,org_unit_id,role from employee_assignments where profile_id=${seller.id} and deleted_at is null
    and effective_from<=${at} and (effective_to is null or effective_to>${at})`;
  if (emps.length !== 1 || emps[0].org_unit_id !== seller.org_unit_id) {
    refuse("seller_assignment_unusable", { count: emps.length });
    return done();
  }
  if (
    !(await isSample(db, "employee_assignments", emps[0].id)) ||
    !(await isSample(db, "org_units", seller.org_unit_id))
  ) {
    refuse("seller_assignment_not_sample", {
      employeeAssignmentId: emps[0].id,
      orgUnitId: seller.org_unit_id,
    });
    return done();
  }
  report.seller = {
    profileId: seller.id,
    email: seller.email,
    name: seller.name,
    orgUnitId: seller.org_unit_id,
  };

  // ---- the installed phone: must already be an active, correctly bound van device; never edited here ----
  const devices =
    await db`select id,status,bound_subject,org_unit_id from registered_devices where profile_id=${seller.id} and app='van-android'`;
  const usable = devices.filter(
    (/** @type {any} */ d) =>
      d.status === "active" && d.bound_subject === seller.user_id,
  );
  report.devices = devices.map((/** @type {any} */ d) => ({
    id: d.id,
    status: d.status,
    usable: usable.includes(d),
  }));
  if (!usable.length)
    refuse("no_active_van_device", { devices: report.devices });
  for (const d of devices)
    if (
      d.status === "active" &&
      d.bound_subject &&
      d.bound_subject !== seller.user_id
    )
      refuse("device_bound_to_other_subject", { deviceId: d.id });

  // ---- office actor: a sample admin/operations identity that holds van.manage ----
  const office = await person(db, o.officeProfileId, o.officeEmail);
  if (office?.ambiguous)
    refuse("office_email_ambiguous", { email: o.officeEmail });
  else if (
    !office ||
    office.status !== "active" ||
    !["admin", "operations"].includes(office.role)
  )
    refuse("office_unavailable", {
      email: o.officeEmail,
      profileId: o.officeProfileId,
    });
  else if (!(await sampleIdentity(db, office)))
    refuse("office_not_sample", { profileId: office.id });
  else {
    const oe =
      await db`select id,org_unit_id from employee_assignments where profile_id=${office.id} and deleted_at is null and effective_from<=${at} and (effective_to is null or effective_to>${at})`;
    if (oe.length !== 1 || oe[0].org_unit_id !== office.org_unit_id)
      refuse("office_assignment_unusable", { count: oe.length });
    else if (
      !(await isSample(db, "employee_assignments", oe[0].id)) ||
      !(await isSample(db, "org_units", office.org_unit_id))
    )
      refuse("office_assignment_not_sample", {
        employeeAssignmentId: oe[0].id,
        orgUnitId: office.org_unit_id,
      });
    else
      report.office = {
        profileId: office.id,
        email: office.email,
        role: office.role,
      };
  }

  // ---- our own earlier result (real command ledger) vs. foreign open work ----
  if (report.office) {
    const [prior] =
      await db`select result from van_web_commands where actor_profile_id=${office.id} and idempotency_key=${commandKey(seller.id, o.date, "trip")}`;
    report.owned.tripId = prior?.result?.tripId ?? null;
  }
  if (report.owned.tripId) {
    // Replay is only defined while OUR trip is still `planned`/`loading`. Identity/ownership checks above already ran and
    // every later check (vehicle, depot, products, fiscal, stored load) still runs; a progressed trip is a named refusal.
    const [own] =
      await db`select id,status,vehicle_id,salesperson_profile_id,service_date::text d from van_trips where id=${report.owned.tripId}`;
    if (!own || own.salesperson_profile_id !== seller.id || own.d !== o.date) {
      refuse("owned_trip_mismatch", { tripId: report.owned.tripId });
      return done();
    }
    if (!["planned", "loading"].includes(own.status)) {
      refuse("owned_trip_progressed", {
        tripId: own.id,
        status: own.status,
        hint: "the phone or office already progressed this trip; this fixture is not replayed after that",
      });
      return done();
    }
    report.owned.status = own.status;
    report.owned.vehicleId = own.vehicle_id;
  }
  // ANY other open trip of this seller, on ANY date, blocks the fixture (the phone assumes one live trip).
  const openTrips =
    await db`select id,trip_number,status,service_date::text d from van_trips where salesperson_profile_id=${seller.id}
    and deleted_at is null and status in ${db(OPEN)}`;
  for (const t of openTrips.filter(
    (/** @type {any} */ t) => t.id !== report.owned.tripId,
  ))
    refuse("seller_has_open_trip", {
      tripNumber: t.trip_number,
      status: t.status,
      serviceDate: t.d,
    });

  // ---- route: exactly one active assignment, sample, every outlet on it sample ----
  const routes =
    await db`select r.id,r.code,r.status from route_salespeople s join routes r on r.id=s.route_id
    where s.profile_id=${seller.id} and s.deleted_at is null and s.effective_from<=${at} and (s.effective_to is null or s.effective_to>${at})
    and r.deleted_at is null`;
  if (routes.length !== 1 || routes[0].status !== "active")
    refuse("route_unusable", {
      routes: routes.map((/** @type {any} */ r) => r.code),
    });
  else if (!(await isSample(db, "routes", routes[0].id)))
    refuse("route_not_sample", { routeId: routes[0].id });
  else {
    const outlets =
      await db`select o.id,o.code,o.channel,o.organization_id from outlets o join outlet_assignments a on a.outlet_id=o.id and a.deleted_at is null
      and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now())
      where a.route_id=${routes[0].id} and o.status='active' and o.deleted_at is null order by a.sequence nulls last,o.code`;
    const ok = await verifiedSample(
      db,
      "outlets",
      outlets.map((/** @type {any} */ x) => x.id),
    );
    const foreign = outlets.filter((/** @type {any} */ x) => !ok.has(x.id));
    if (!outlets.length)
      refuse("route_has_no_outlets", { route: routes[0].code });
    if (foreign.length)
      refuse("route_has_non_sample_outlets", {
        route: routes[0].code,
        count: foreign.length,
      });
    report.route = {
      id: routes[0].id,
      code: routes[0].code,
      outlets: outlets.length,
      sampleOutlets: ok.size,
      channels: [...new Set(outlets.map((/** @type {any} */ x) => x.channel))],
      first: outlets.slice(0, 5).map((/** @type {any} */ x) => x.code),
      _outlets: outlets,
    };
  }

  // ---- vehicle: an EMPTY marked sample truck of the seller's unit, used by nobody else ----
  const vrows =
    await db`select v.id,v.vehicle_code,v.org_unit_id,v.truck_location_id,v.home_location_id,v.status from vehicles v
    where v.org_unit_id=${seller.org_unit_id} and v.deleted_at is null and v.status='active' ${o.vehicleId ? db`and v.id=${o.vehicleId}` : db``} order by v.vehicle_code`;
  const vmarks = await verifiedSample(
    db,
    "vehicles",
    vrows.map((/** @type {any} */ v) => v.id),
  );
  const lmarks = await verifiedSample(
    db,
    "inventory_locations",
    vrows.flatMap((/** @type {any} */ v) => [
      v.truck_location_id,
      v.home_location_id,
    ]),
  );
  /** @type {any[]} */ const candidates = [];
  for (const v of vrows) {
    const why = [];
    if (!vmarks.has(v.id)) why.push("vehicle_not_sample");
    if (!lmarks.has(v.truck_location_id)) why.push("truck_location_not_sample");
    if (!lmarks.has(v.home_location_id)) why.push("depot_not_sample");
    const [held] = await db`select
      (select count(*)::int from inventory_balances b where b.location_id=${v.truck_location_id} and b.deleted_at is null and
        (b.physical_base<>0 or b.available_stock_base<>0 or b.reserved_base<>0 or b.damaged_base<>0 or b.in_transit_base<>0 or b.quality_hold_base<>0)) as balances,
      (select count(*)::int from inventory_lot_balances b where b.location_id=${v.truck_location_id} and b.physical_base<>0) as lots`;
    if (held.balances || held.lots) why.push("truck_holds_stock");
    const [other] =
      await db`select count(*)::int n from van_trips where vehicle_id=${v.id} and deleted_at is null and status<>'cancelled' and salesperson_profile_id<>${seller.id}`;
    if (other.n) why.push("vehicle_used_by_another_seller");
    const [busy] =
      await db`select count(*)::int n from van_trips where vehicle_id=${v.id} and deleted_at is null and status in ${db(OPEN)} ${report.owned.tripId ? db`and id<>${report.owned.tripId}` : db``}`;
    if (busy.n) why.push("vehicle_has_open_trip");
    if (why.length) report.excludedVehicles.push({ code: v.vehicle_code, why });
    else candidates.push(v);
  }
  if (candidates.length !== 1)
    refuse(
      candidates.length ? "vehicle_ambiguous" : "no_dedicated_empty_vehicle",
      {
        candidates: candidates.map((c) => c.vehicle_code),
        excluded: report.excludedVehicles,
      },
    );
  const vehicle = candidates.length === 1 ? candidates[0] : null;
  if (
    vehicle &&
    report.owned.vehicleId &&
    report.owned.vehicleId !== vehicle.id
  )
    refuse("owned_trip_vehicle_changed", {
      tripId: report.owned.tripId,
      ownedVehicleId: report.owned.vehicleId,
      vehicleId: vehicle.id,
    });
  if (vehicle) {
    report.vehicle = {
      id: vehicle.id,
      code: vehicle.vehicle_code,
      truckLocationId: vehicle.truck_location_id,
    };
    const [depot] =
      await db`select id,code,type,active,org_unit_id from inventory_locations where id=${vehicle.home_location_id} and deleted_at is null`;
    if (!depot || !depot.active || depot.type === "truck")
      refuse("depot_unusable", { depotId: vehicle.home_location_id });
    else if (!(await isSample(db, "org_units", depot.org_unit_id)))
      refuse("depot_org_unit_not_sample", {
        depotId: depot.id,
        orgUnitId: depot.org_unit_id,
      });
    else
      report.depot = {
        id: depot.id,
        code: depot.code,
        orgUnitId: depot.org_unit_id,
      };
  }

  // ---- office scope (real capability + org-scope check, read-only) ----
  if (report.office && vehicle && report.depot && domain) {
    const actor = domain.actorFor(office);
    try {
      for (const unit of new Set([
        vehicle.org_unit_id,
        report.depot.orgUnitId,
        seller.org_unit_id,
      ]))
        await domain.caps.requireCapability({ db, actor }, "van.manage", unit);
    } catch (e) {
      refuse("office_out_of_scope", {
        message: String(/** @type {any} */ (e)?.message ?? e),
      });
    }
  }

  // ---- products: sample, priced for every channel on the route, enough unreserved depot stock ----
  if (report.depot && report.route) {
    const bal =
      await db`select p.id,p.code,b.available_base::text av,b.reserved_base::text rv,b.quality_hold_base::text qh,
      (select count(*)::int from inventory_lot_balances lb where lb.location_id=b.location_id and lb.product_id=b.product_id and lb.physical_base>0) lots
      from inventory_balances b join products p on p.id=b.product_id
      where b.location_id=${report.depot.id} and b.deleted_at is null and b.physical_base>0 and p.active ${o.products ? db`and p.code in ${db(o.products)}` : db``}
      order by p.code`;
    const pm = await verifiedSample(
      db,
      "products",
      bal.map((/** @type {any} */ b) => b.id),
    );
    /** @type {any[]} */ const eligible = [];
    const probe = report.route._outlets;
    for (const b of bal) {
      const why = [];
      if (!pm.has(b.id)) why.push("product_not_sample");
      if (BigInt(b.av) < BigInt(o.quantity)) why.push("depot_short");
      if (BigInt(b.rv) !== 0n || BigInt(b.qh) !== 0n)
        why.push("depot_reserved_or_held");
      if (!b.lots) why.push("no_lot");
      let unit = null;
      if (!why.length && domain) {
        const prices = new Set();
        for (const ch of report.route.channels) {
          const sample = probe.find((/** @type {any} */ x) => x.channel === ch);
          const r = await domain.resolvePrice(db, {
            organizationId: sample.organization_id,
            productId: b.id,
            uom: "PC",
            channelKey: ch,
            customerCode: null,
            outletId: sample.id,
            at: o.now,
          });
          if (r.unitPriceCentavos == null) why.push(`unpriced:${ch}`);
          else prices.add(String(r.unitPriceCentavos));
        }
        unit = [...prices].sort()[0] ?? null;
      }
      if (!why.length)
        eligible.push({
          id: b.id,
          code: b.code,
          depotAvailable: b.av,
          listPriceMinor: unit,
        });
      else {
        if (report.excludedProducts.length < 10)
          report.excludedProducts.push({ code: b.code, why });
        if (o.products)
          refuse("requested_product_not_eligible", { code: b.code, why });
      }
    }
    if (o.products) {
      const missing = o.products.filter(
        (c) => !bal.some((/** @type {any} */ b) => b.code === c),
      );
      if (missing.length)
        refuse("requested_product_not_in_depot", { codes: missing });
    }
    const chosen = o.products
      ? o.products
          .map((c) => eligible.find((e) => e.code === c))
          .filter((e) => e)
      : eligible.slice(0, o.productCount);
    if (chosen.length < (o.products ? o.products.length : o.productCount))
      refuse("not_enough_eligible_products", { found: chosen.length });
    report.products = chosen.map((c) => ({ ...c, quantity: o.quantity }));
    // The phone's bundle (van/projection.js) prices every catalogue product for every route outlet and refuses past
    // 500 products / 600 price lines. Refuse BEFORE any write rather than plan a trip that can never download. The
    // catalogue is the chosen load plus truck stock; an eligible truck holds none (`truck_holds_stock`), and historical
    // all-zero truck rows are not catalogue (same rule as the bundle), so nothing is double-counted.
    if (report.route && chosen.length) {
      const priceLines = chosen.length * report.route.outlets;
      if (
        chosen.length > PROJECTION_PRODUCTS ||
        report.route.outlets > PROJECTION_OUTLETS ||
        priceLines > PROJECTION_PRICE_LINES
      )
        refuse("van_projection_too_large", {
          products: chosen.length,
          outlets: report.route.outlets,
          priceLines,
          bounds: {
            products: PROJECTION_PRODUCTS,
            outlets: PROJECTION_OUTLETS,
            priceLines: PROJECTION_PRICE_LINES,
          },
        });
    }
    if (report.owned.tripId) {
      // Replay must be against the ORIGINAL facts: a changed product or quantity is a named refusal, never a replacement.
      const stored =
        await db`select product_id::text pid,product_code code,expected_base::text qty from van_trip_load_lines where trip_id=${report.owned.tripId} and deleted_at is null order by product_code`;
      const asked = chosen.map((c) => `${c.id}:${o.quantity}`).sort();
      const had = stored
        .map((/** @type {any} */ l) => `${l.pid}:${l.qty}`)
        .sort();
      if (asked.length !== had.length || asked.some((x, i) => x !== had[i]))
        refuse("owned_load_differs", {
          tripId: report.owned.tripId,
          stored: stored.map((/** @type {any} */ l) => ({
            code: l.code,
            quantity: l.qty,
          })),
          requested: chosen.map((c) => ({
            code: c.code,
            quantity: String(o.quantity),
          })),
        });
    }
  }

  // ---- fiscal / tender readiness for the sale -> settlement chain (read-only) ----
  if (vehicle) {
    const usableDeviceIds = report.devices
      .filter((/** @type {any} */ d) => d.usable)
      .map((/** @type {any} */ d) => d.id);
    const fx = await assessFiscal(db, o, vehicle, usableDeviceIds, domain);
    const needs = fx.seedTypes.length > 0 || fx.seedCash;
    report.fiscal = {
      ranges: fx.ranges,
      cashTender: fx.cash,
      seedTypes: fx.seedTypes,
      seedCash: fx.seedCash,
      willSeedSample: false,
    };
    for (const b of fx.bad) refuse(b.code, b.detail);
    if (!fx.bad.length && needs && !o.withFiscalSample)
      refuse("fiscal_sample_missing", {
        ranges: fx.ranges,
        cashTender: fx.cash,
        hint: "re-run with --with-fiscal-sample (adds only the missing vehicle-level SI/OR sample series and, if the unit has no cash rule at all, a cash tender rule)",
      });
    else if (!fx.bad.length && needs) report.fiscal.willSeedSample = true;
  }
  const { _outlets, ...route } = report.route ?? {};
  report.route = report.route ? route : null;
  return done();
}

/** Dry run: read-only, never throws on conflicts. @param {any} db @param {KickoffVanOptions} options @param {{domain?:any}} [deps] */
export async function planKickoffVan(db, options, deps = {}) {
  const o = normalize(options);
  const domain = deps.domain ?? (await loadDomain());
  const r = await domain.withScopeHooks(() =>
    db.begin("read only", (/** @type {any} */ t) => preflight(t, o, domain)),
  );
  return { dryRun: true, ...r };
}

/** Additive copy of the sample fiscal fixture (same deterministic ids/markers as fiscal.js). Plain INSERTs only: a
 * collision raises and rolls the whole apply back; nothing existing is ever adopted, marked or edited.
 * @param {any} t @param {any} vehicle @param {string} officeId @param {string} unitName @param {string[]} types @param {boolean} seedCash */
async function seedVehicleFiscal(
  t,
  vehicle,
  officeId,
  unitName,
  types,
  seedCash,
) {
  await t`select set_config('sunpride.actor',${FISCAL_ACTOR},true)`;
  for (const [type, code] of FISCAL_TYPES.filter(([ty]) =>
    types.includes(ty),
  )) {
    const {
      reg: id,
      series: seriesId,
      prefix,
    } = fiscalIds(vehicle, type, code);
    await t`insert into fiscal_registrations(id,org_unit_id,entity_name,branch_name,tin,address,document_type,status,effective_from,entered_by,sample,tax_basis_points)
      values(${id},${vehicle.org_unit_id},'SAMPLE SUNPRIDE COMPANY - NOT REGISTERED',${unitName},'SAMPLE 000-000-000-000','Sample Cebu address - replace with registered address',${type},'sample_not_filed','2026-01-01',${officeId},true,1200)`;
    await t`insert into fiscal_series(id,registration_id,vehicle_id,prefix,first_serial,last_serial,next_allocate,effective_from)
      values(${seriesId},${id},${vehicle.id},${prefix},1,999999,1,'2026-01-01')`;
    for (const [table, row] of [
      ["fiscal_registrations", id],
      ["fiscal_series", seriesId],
    ])
      await t`insert into sample_data_rows(batch,table_name,row_id,key) values(${FISCAL_BATCH},${table},${row},${`${table}:${row}`})`;
  }
  if (!seedCash) return;
  const tid = rowId("fiscal_tender_rules", `${vehicle.org_unit_id}-cash`);
  await t`insert into fiscal_tender_rules(id,org_unit_id,method,label,reference_label,enabled,effective_from,sample,entered_by) values(${tid},${vehicle.org_unit_id},'cash','Cash',null,true,'2026-01-01',true,${officeId})`;
  await t`insert into sample_data_rows(batch,table_name,row_id,key) values(${FISCAL_BATCH},'fiscal_tender_rules',${tid},${"fiscal_tender_rules:" + tid})`;
}

/**
 * Apply in ONE transaction. Throws KickoffVanConflict (report attached) when anything is unsafe.
 * @param {any} db @param {KickoffVanOptions} options @param {{domain?:any}} [deps]
 */
export async function applyKickoffVan(db, options, deps = {}) {
  const o = normalize(options);
  const domain = deps.domain ?? (await loadDomain());
  return tx(db, (t) =>
    domain.withScopeHooks(async () => {
      await t`select pg_advisory_xact_lock(hashtextextended(${`${KEY_VERSION}:${o.sellerProfileId}:${o.date}`}, 0))`;
      // Fiscal setup is serialized with fiscal.js; the preflight below is the in-transaction recheck under that lock.
      if (o.withFiscalSample)
        await t`select pg_advisory_xact_lock(${FISCAL_LOCK})`;
      const report = await preflight(t, o, domain);
      if (!report.ok)
        throw new KickoffVanConflict({ applied: false, ...report });
      const seller = await person(t, report.seller.profileId);
      const office = await person(t, report.office.profileId);
      // Impersonation is the dangerous step: re-prove both identities inside this transaction.
      for (const [code, who] of /** @type {const} */ ([
        ["seller_not_sample", seller],
        ["office_not_sample", office],
      ]))
        if (!(await sampleIdentity(t, who)))
          throw new KickoffVanConflict({
            applied: false,
            conflicts: [{ code, detail: { profileId: who.id } }],
            ok: false,
          });
      const [{ n: ledger0 }] =
        await t`select count(*)::int n from van_web_commands where actor_profile_id=${office.id}`;
      if (report.fiscal?.willSeedSample) {
        const [veh] =
          await t`select * from vehicles where id=${report.vehicle.id}`;
        const [unit] =
          await t`select name from org_units where id=${veh.org_unit_id}`;
        await seedVehicleFiscal(
          t,
          veh,
          office.id,
          unit.name,
          report.fiscal.seedTypes,
          report.fiscal.seedCash,
        );
        // Post-apply proof (real issuanceGate/tenderPolicy; allocates nothing): everything must now be usable or we roll back.
        const after = await assessFiscal(
          t,
          o,
          veh,
          report.devices
            .filter((/** @type {any} */ d) => d.usable)
            .map((/** @type {any} */ d) => d.id),
          domain,
        );
        if (
          after.bad.length ||
          after.seedTypes.length ||
          after.seedCash ||
          Object.values(after.ranges).some((r) => r !== "ready") ||
          after.cash !== "ready"
        )
          throw new KickoffVanConflict({
            applied: false,
            conflicts: [
              {
                code: "fiscal_post_apply_unusable",
                detail: {
                  ranges: after.ranges,
                  cash: after.cash,
                  bad: after.bad,
                },
              },
            ],
            ok: false,
          });
        report.fiscal = {
          ...report.fiscal,
          ranges: after.ranges,
          cashTender: after.cash,
        };
      }
      const actor = domain.actorFor(office);
      const run = (
        /** @type {string} */ action,
        /** @type {Function} */ fn,
        /** @type {string} */ step,
        /** @type {any} */ body,
      ) =>
        domain.command(
          {
            db: t,
            actor,
            req: { headers: new Headers() },
            body: {
              ...body,
              idempotencyKey: commandKey(seller.id, o.date, step),
            },
            env: {},
            publish: async () => {},
          },
          { recordChange: domain.recordChange },
          action,
          "van.manage",
          fn,
        );
      const trip = await run("trips/plan", domain.planTrip, "trip", {
        vehicleId: report.vehicle.id,
        sourceLocationId: report.depot.id,
        salespersonProfileId: seller.id,
        routeId: report.route.id,
        serviceDate: o.date,
        driverName: "Sample demo driver",
        helperName: "Sample demo helper",
      });
      const load = await run("loads/plan", domain.planLoad, "load", {
        tripId: trip.tripId,
        lines: report.products.map((/** @type {any} */ p) => ({
          productId: p.id,
          expectedBase: String(o.quantity),
        })),
      });
      const [{ n: ledger1 }] =
        await t`select count(*)::int n from van_web_commands where actor_profile_id=${office.id}`;
      if (ledger1 > ledger0)
        // Provenance only (the scoped office actor and every domain check are unchanged): tag the fixture as helper-made.
        await t`insert into van_audit_events(trip_id,actor_profile_id,actor_name,kind,entity_id,details)
        values(${trip.tripId},${office.id},'Sample fixture helper (kickoff-van.js)','sample.kickoff.van.fixture',${trip.tripId},${{ helper: "packages/db/seed/kickoff-van.js", scopedActorProfileId: office.id, sellerProfileId: seller.id, loadId: load.loadId, date: o.date, note: "created by the sample fixture helper through the real van office commands; not a manual office action" }})`;
      return {
        applied: true,
        replayed: ledger1 === ledger0,
        commandsAdded: ledger1 - ledger0,
        date: o.date,
        seller: report.seller,
        office: report.office,
        vehicle: report.vehicle,
        depot: report.depot,
        route: report.route,
        products: report.products,
        fiscal: report.fiscal,
        tripId: trip.tripId,
        tripNumber: trip.tripNumber,
        loadId: load.loadId,
        verify: await readBack(t, trip.tripId),
      };
    }),
  );
}

/** @param {any} db @param {string} tripId */
export async function readBack(db, tripId) {
  const [trip] =
    await db`select id,trip_number,status,service_date::text d,salesperson_profile_id,operations_version,vehicle_id from van_trips where id=${tripId}`;
  const loads =
    await db`select id,status from van_trip_loads where trip_id=${tripId} and deleted_at is null`;
  const lines =
    await db`select line_number,product_code,expected_base::text expected,actual_base from van_trip_load_lines where trip_id=${tripId} and deleted_at is null order by line_number`;
  return {
    trip,
    loads,
    lines,
    nothingPostedYet: loads.every(
      (/** @type {any} */ l) => l.status === "planned",
    ),
  };
}

// --------------------------------------------------------------------------------------------- CLI
/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {Record<string, any>} */ const a = {
    apply: false,
    withFiscalSample: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v == null || v.startsWith("--"))
        throw new Error(`${k} needs a value`);
      return v;
    };
    if (k === "--apply") a.apply = true;
    else if (k === "--with-fiscal-sample") a.withFiscalSample = true;
    else if (k === "--seller-id") a.sellerProfileId = val();
    else if (k === "--office-id") a.officeProfileId = val();
    else if (k === "--office") a.officeEmail = val();
    else if (k === "--date") a.date = val();
    else if (k === "--vehicle-id") a.vehicleId = val();
    else if (k === "--products")
      a.products = val()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (k === "--quantity") a.quantity = Number(val());
    else if (k === "--confirm-database") a.confirmDatabase = val();
    else throw new Error(`Unknown option ${k}`);
  }
  return a;
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required (it is never printed).");
    process.exit(2);
  }
  let code = 0;
  const db = createDb(url, { max: 2 });
  try {
    const args = parseArgs(process.argv.slice(2));
    const [{ name }] = await db`select current_database() as name`;
    if (!args.apply) {
      const r = await planKickoffVan(db, args);
      console.log(JSON.stringify({ database: name, ...r }, null, 2));
      code = r.ok ? 0 : 1;
    } else if (args.confirmDatabase !== name) {
      console.error(
        `Refusing to apply: --confirm-database must equal the connected database name (${name}).`,
      );
      code = 2;
    } else {
      const r = await applyKickoffVan(db, args);
      console.log(JSON.stringify({ database: name, ...r }, null, 2));
    }
  } catch (e) {
    if (e instanceof KickoffVanConflict)
      console.log(
        JSON.stringify({ database: "(connected)", ...e.report }, null, 2),
      );
    else console.error(String(/** @type {any} */ (e)?.message ?? e));
    code = 1;
  } finally {
    await db.close();
  }
  process.exit(code);
}
