import { tx } from "@sunpride/db/client";
import { actorFor } from "../../core/context.js";
import { requireCapability, roleHas } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { nextDocNumber } from "../../core/docnum.js";
import {
  choice,
  document,
  id,
  integer,
  invalid,
  locationGate,
  manilaDate,
  notSelf,
  ORGANIZATION,
  productPolicy,
  state,
  STATUS_FIELDS,
  STATUSES,
  stockLock,
  text,
  visibleLocations,
} from "./common.js";
import { commands, post } from "./commands.js";
import { enforceInventoryAuthority } from "./fiscal.js";
import { requireReason } from "./reasons.js";
import { toleranceFor, withinTolerance } from "./tolerances.js";
import { quantity, unitInfo } from "./units.js";

/**
 * Stock counts v2 (SPEC 4.3). The count functions live here; commands.js only calls installCountCommands().
 *
 * How the numbers work
 * - A line is saved on its own (draft per line). Saving never needs the rest of the count to be still.
 * - "Expected" for a line is what the books said AT THE MOMENT IT WAS COUNTED: the live balance minus the
 *   movements posted after that moment. A sale or a van load during the count therefore does not throw
 *   the count out, and the adjustment (counted - expected) is applied on top of whatever moved later.
 * - Review is per line. Inside the count_variance tolerance a line is accepted automatically.
 * - Approve posts ONE adjustment (writer batches of 100 lines inside one transaction) with a reason per line.
 * - created_by is the COUNTER (the assigned person, else the planner). That keeps the blind-count stock embargo
 *   and the hidden count movements in common.js/queries.js working for the person who must not see stock.
 *
 * Only function declarations are used at install time: commands.js calls installCountCommands() while this
 * module may still be evaluating (the two import each other).
 */

/** @typedef {{id:string,code:string,name:string,org_unit_id:string|null,type:string,[k:string]:any}} Place */

const MAX_LINES = 5000;
const SAVE_MAX = 500;
const POST_CHUNK = 100;
const DEFAULT_REASON = "COUNT-ERR";
const FINDINGS = [
  "over",
  "missing",
  "damaged",
  "expired",
  "wrong_lot",
  "wrong_location",
];
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/** @param {string} message @param {string} code @param {number} [status] @returns {never} */
function refuse(message, code, status = 409) {
  throw new ApiError(code, status, message);
}
/** Document-number location part: letters, digits and dashes only. @param {string} code */
function docLoc(code) {
  const s = String(code ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "-")
    .replace(/^-+/, "")
    .slice(0, 20);
  return s || "LOC";
}
/** @param {any} v @param {number} lo @param {number} hi @param {string} name */
function clampInt(v, lo, hi, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi)
    invalid(`${name} must be a whole number from ${lo} to ${hi}`);
  return n;
}
/** @param {any} v @param {string} name @param {number} max */
function list(v, name, max) {
  if (!Array.isArray(v) || !v.length || v.length > max)
    invalid(`${name}: supply 1–${max} entries`);
  return v;
}
/** @param {any} v @param {string} name */
function isoDate(v, name) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v))
    invalid(`${name} must be a date like 2026-11-06`);
  return /** @type {string} */ (v);
}

// ---------------------------------------------------------------------------------------------
// Scope, places and roster
// ---------------------------------------------------------------------------------------------

/** What to count. Legacy bodies carry `productIds` at the top level. @param {any} b */
function readScope(b) {
  const s =
    b.scope && typeof b.scope === "object" && !Array.isArray(b.scope)
      ? b.scope
      : {};
  /** @type {Record<string,any>} */ const out = {};
  const productIds = s.productIds ?? b.productIds;
  if (productIds !== undefined)
    out.productIds = [
      ...new Set(
        list(productIds, "Products", 2000).map((/** @type {any} */ v) =>
          id(v, "Product"),
        ),
      ),
    ];
  if (s.search) out.search = text(s.search, "Search", 100);
  if (s.category) out.category = text(s.category, "Category", 100);
  if (s.fastMovers) {
    const f = s.fastMovers === true ? {} : s.fastMovers;
    out.fastMovers = {
      days: clampInt(f.days ?? 30, 1, 365, "Fast-mover days"),
      top: clampInt(f.top ?? 50, 1, 1000, "Fast-mover count"),
    };
  }
  if (s.binFrom) out.binFrom = text(s.binFrom, "First bin", 60).toUpperCase();
  if (s.binTo) out.binTo = text(s.binTo, "Last bin", 60).toUpperCase();
  out.type = Object.keys(out).length ? "filtered" : "all";
  return out;
}
/** Plain-words summary of a scope. @param {any} scope @param {boolean} sub */
function scopeLabel(scope, sub) {
  /** @type {string[]} */ const parts = [];
  if (scope?.fastMovers)
    parts.push(
      `Fast movers (top ${scope.fastMovers.top}, last ${scope.fastMovers.days} days)`,
    );
  if (scope?.productIds)
    parts.push(`${scope.productIds.length} chosen products`);
  if (scope?.search) parts.push(`Products matching “${scope.search}”`);
  if (scope?.category) parts.push(`Category ${scope.category}`);
  if (scope?.binFrom || scope?.binTo)
    parts.push(`Bins ${scope.binFrom ?? "first"} to ${scope.binTo ?? "last"}`);
  if (!parts.length) parts.push(sub ? "Everything, all bins" : "Everything");
  return parts.join(", ");
}
/** The counting place and, when asked, every location below it (bins), in bin order.
 * @param {any} t @param {Place} root @param {boolean} sub @param {any} scope @returns {Promise<Place[]>} */
async function placesFor(t, root, sub, scope) {
  if (!sub && !scope?.binFrom && !scope?.binTo) return [root];
  const rows = await t`with recursive tree as (
      select * from inventory_locations where id=${root.id}
      union
      select c.* from inventory_locations c join tree p on c.parent_location_id=p.id where c.deleted_at is null and c.active)
    select * from tree order by code`;
  return rows.filter((/** @type {any} */ r) => {
    if (r.id === root.id) return !(scope?.binFrom || scope?.binTo);
    const code = String(r.code).toUpperCase();
    return (
      (!scope?.binFrom || code >= scope.binFrom) &&
      (!scope?.binTo || code <= scope.binTo)
    );
  });
}
/** @typedef {{locationId:string,productId:string,lotId:string|null,status:string,system:number,version:number|null,movement:string|null}} RosterItem */
/** Every stock row that falls inside the scope. @param {any} t @param {Place[]} places @param {any} scope @param {number} now
 * @returns {Promise<RosterItem[]>} */
async function buildRoster(t, places, scope, now) {
  if (!places.length) return [];
  const placeIds = places.map((p) => p.id);
  /** @type {Set<string>|null} */ let fast = null;
  if (scope.fastMovers) {
    const rows = await t`select e.product_id from inventory_ledger_entries e join inventory_movements m on m.id=e.movement_id
      where e.organization_id=${ORGANIZATION} and e.location_id in ${t(placeIds)} and e.quantity_delta_base<0
        and m.movement_type in ('pos_sale','inventory_issue','transfer_ship','van_load')
        and e.posted_at>=${new Date(now - scope.fastMovers.days * 86400000)}
      group by e.product_id order by count(*) desc, e.product_id limit ${scope.fastMovers.top}`;
    fast = new Set(rows.map((/** @type {any} */ r) => r.product_id));
  }
  const wanted = scope.productIds ? new Set(scope.productIds) : null;
  const like = scope.search
    ? `%${String(scope.search).replace(/[\\%_]/g, (/** @type {string} */ m) => `\\${m}`)}%`
    : null;
  const category = scope.category ?? null;
  /** @type {RosterItem[]} */ const out = [];
  for (const place of places) {
    const rows = await t`select b.*,p.tracking_mode as ptrack,pol.tracking_mode as poltrack
      from inventory_balances b
      join products p on p.id=b.product_id and p.organization_id=b.organization_id and p.active and p.deleted_at is null
      left join product_inventory_policies pol on pol.organization_id=b.organization_id and pol.product_id=b.product_id and pol.active and pol.deleted_at is null
      where b.organization_id=${ORGANIZATION} and b.location_id=${place.id} and b.deleted_at is null
        and (${like}::text is null or p.code ilike ${like} or p.name ilike ${like})
        and (${category}::text is null or p.category=${category})
      order by p.code`;
    for (const row of rows) {
      if (wanted && !wanted.has(row.product_id)) continue;
      if (fast && !fast.has(row.product_id)) continue;
      const tracking = row.poltrack ?? row.ptrack ?? "none";
      if (tracking === "lot") {
        const lots = await t`select * from inventory_lot_balances where organization_id=${ORGANIZATION} and location_id=${place.id} and product_id=${row.product_id} order by lot_id,stock_status`;
        for (const l of lots)
          out.push({
            locationId: place.id,
            productId: row.product_id,
            lotId: l.lot_id,
            status: l.stock_status,
            system: Number(l.physical_base),
            version: l.version,
            movement: l.last_movement_id,
          });
      } else
        for (const status of STATUSES) {
          const field = STATUS_FIELDS[status];
          const qty = Number(row[field ?? ""] ?? 0);
          if (status === "available" || qty !== 0)
            out.push({
              locationId: place.id,
              productId: row.product_id,
              lotId: null,
              status,
              system: qty,
              version: row.version,
              movement: row.last_movement_id,
            });
        }
    }
  }
  return out;
}
/** Insert roster rows; rows already in the count are left alone. @param {any} t @param {any} session @param {RosterItem[]} items */
async function insertRoster(t, session, items) {
  let added = 0;
  for (const l of items) {
    const where = l.locationId === session.location_id ? null : l.locationId;
    const rows = await t`insert into stock_count_lines (organization_id,session_id,product_id,lot_id,stock_status,system_base,snapshot_balance_version,snapshot_movement_id,location_id,source)
      values (${ORGANIZATION},${session.id},${l.productId},${l.lotId},${l.status},${l.system},${l.version},${l.movement},${where},'plan')
      on conflict do nothing returning id`;
    added += rows.length;
  }
  return added;
}

/** Create a count with its lines.
 * @param {any} t @param {{location:Place,scope:any,includeSub:boolean,countType:string,blind:boolean,counterId:string,plannerId:string,assignedTo?:string|null,title?:string|null,scheduledFor?:string|null,status:string,legacy?:boolean,scheduleId?:string|null,now:number}} o */
async function createSession(t, o) {
  const places = await placesFor(t, o.location, o.includeSub, o.scope);
  const roster = await buildRoster(t, places, o.scope, o.now);
  if (!roster.length)
    invalid(
      o.scope.type === "all"
        ? "Receive stock before starting a count"
        : "Nothing matches that scope. Widen it or check the place.",
      "nothing_to_count",
    );
  if (roster.length > MAX_LINES)
    invalid(
      `That scope has ${roster.length} lines. Narrow it to a bin range or a product filter (up to ${MAX_LINES}).`,
      "count_too_large",
    );
  const sessionId = crypto.randomUUID();
  const number = await nextDocNumber(t, ORGANIZATION, {
    type: "CNT",
    locationCode: docLoc(o.location.code),
    at: o.now,
  });
  const subset = o.scope.productIds ? JSON.stringify(o.scope.productIds) : null;
  await t`insert into stock_count_sessions (id,organization_id,count_number,count_type,location_id,status,blind_count,snapshot_at,created_by,cycle_product_ids,title,planned_by,assigned_to,scope,scheduled_for,schedule_id,legacy_whole,include_sublocations,counting_started_at)
    values (${sessionId},${ORGANIZATION},${number},${o.countType},${o.location.id},${o.status},${o.blind},${new Date(o.now)},${o.counterId},${subset}::text::jsonb,${o.title ?? null},${o.plannerId},${o.assignedTo ?? null},${JSON.stringify(o.scope)}::text::jsonb,${o.scheduledFor ?? null},${o.scheduleId ?? null},${o.legacy === true},${o.includeSub},${o.status === "counting" ? new Date(o.now) : null})`;
  await insertRoster(t, { id: sessionId, location_id: o.location.id }, roster);
  return { id: sessionId, number, lines: roster.length };
}

// ---------------------------------------------------------------------------------------------
// Measuring a line: expected at the time it was counted
// ---------------------------------------------------------------------------------------------

/** Per-request product + unit loader (no active filter: old counts must stay readable). @param {any} t @param {number} at */
function infoLoader(t, at) {
  /** @type {Map<string,any>} */ const cache = new Map();
  return async (/** @type {string} */ productId) => {
    let v = cache.get(productId);
    if (!v) {
      const [product] =
        await t`select * from products where id=${productId} and organization_id=${ORGANIZATION}`;
      if (!product) throw new ApiError("not_found", 404, "Product not found");
      const [policy] =
        await t`select * from product_inventory_policies where organization_id=${ORGANIZATION} and product_id=${productId} and active and deleted_at is null`;
      v = {
        product,
        tracking: policy?.tracking_mode ?? product.tracking_mode ?? "none",
        scale: Number(policy?.quantity_scale ?? product.quantity_scale ?? 1),
        units: await unitInfo(t, product, at),
      };
      cache.set(productId, v);
    }
    return v;
  };
}
/** @param {number} base @param {any} info */
function qty(base, info) {
  const q = quantity(Number(base), info.units, null);
  return {
    base: q.base,
    cases: q.cases,
    pieces: q.pieces,
    display: q.display,
    basePerCase: info.units.basePerCase,
    basePerPiece: info.units.basePerPiece,
  };
}
/** Whole centavos, rounded up so a fraction never drops into a smaller band. @param {number} base @param {number|null} cost @param {number} scale */
function pesoValue(base, cost, scale) {
  if (cost == null) return null;
  const s = BigInt(Math.max(1, scale));
  return Number(
    (BigInt(Math.abs(base)) * BigInt(cost) + s - 1n) / s,
  );
}
/** @param {any} t @param {any} line @param {string} locationId */
async function currentBase(t, line, locationId) {
  if (line.lot_id) {
    const [r] =
      await t`select physical_base from inventory_lot_balances where organization_id=${ORGANIZATION} and lot_id=${line.lot_id} and location_id=${locationId} and stock_status=${line.stock_status}`;
    return Number(r?.physical_base ?? 0);
  }
  const [r] =
    await t`select * from inventory_balances where organization_id=${ORGANIZATION} and product_id=${line.product_id} and location_id=${locationId} and deleted_at is null`;
  return Number(r?.[STATUS_FIELDS[line.stock_status] ?? ""] ?? 0);
}
/** Movements that physically happened after the count (effective time, not the time the server heard of them).
 * @param {any} t @param {any} line @param {string} locationId @param {number} at */
async function movedAfter(t, line, locationId, at) {
  const [r] =
    await t`select coalesce(sum(quantity_delta_base),0)::text as n from inventory_ledger_entries where organization_id=${ORGANIZATION} and product_id=${line.product_id} and location_id=${locationId} and stock_status=${line.stock_status} and lot_id is not distinct from ${line.lot_id ?? null} and effective_at>${new Date(at)}`;
  return Number(r.n);
}
/** @param {any} t @param {any} line @param {string} locationId */
async function costOf(t, line, locationId) {
  const [b] =
    await t`select weighted_average_cost_minor as w from inventory_balances where organization_id=${ORGANIZATION} and product_id=${line.product_id} and location_id=${locationId} and deleted_at is null`;
  if (b?.w != null) return Number(b.w);
  if (line.lot_id) {
    const [lot] =
      await t`select unit_cost_minor as c from inventory_lots where id=${line.lot_id}`;
    if (lot?.c != null) return Number(lot.c);
  }
  // A found item has no cost here yet: borrow the latest known cost of the same product elsewhere.
  const [other] =
    await t`select weighted_average_cost_minor as w from inventory_balances where organization_id=${ORGANIZATION} and product_id=${line.product_id} and weighted_average_cost_minor is not null and deleted_at is null order by updated_at desc limit 1`;
  return other?.w == null ? null : Number(other.w);
}
/** Expected = live balance minus everything posted after the count time. @param {any} t @param {any} session @param {any} line @param {number} now @param {(p:string)=>Promise<any>} info */
async function measure(t, session, line, now, info) {
  const locationId = line.location_id ?? session.location_id;
  const at = line.counted_at ? new Date(line.counted_at).getTime() : now;
  const current = await currentBase(t, line, locationId);
  const later = await movedAfter(t, line, locationId, at);
  const expected = current - later;
  const cost = await costOf(t, line, locationId);
  const i = await info(line.product_id);
  const counted = line.counted_base == null ? null : Number(line.counted_base);
  const variance = counted == null ? null : counted - expected;
  return {
    expected,
    variance,
    cost,
    diff: variance == null ? null : pesoValue(variance, cost, i.scale),
    info: i,
  };
}
/** Is a measured line inside the count tolerance? Unknown cost is never "inside" while a peso limit exists.
 * @param {any} tol @param {{variance:number|null,diff:number|null,info:any}} m */
function judge(tol, m) {
  if (m.variance == null) return { within: false, reason: "not_counted" };
  if (m.variance === 0) return { within: true, reason: "exact" };
  if (m.diff == null && tol.maxCentavos != null)
    return { within: false, reason: "no_cost" };
  const pieces = m.variance / (m.info.units.basePerPiece || 1);
  const ok = withinTolerance(tol, { centavos: m.diff, qtyBase: pieces });
  return { within: ok, reason: ok ? "within" : "over" };
}
/** Re-measure a counted line and store the answer. @param {any} t @param {any} session @param {any} line @param {number} now @param {(p:string)=>Promise<any>} info */
async function refreshLine(t, session, line, now, info) {
  const m = await measure(t, session, line, now, info);
  await t`update stock_count_lines set system_base=${m.expected},variance_base=${m.variance},unit_cost_minor=${m.cost},diff_centavos=${m.diff} where id=${line.id}`;
  return { ...line, system_base: m.expected, variance_base: m.variance, unit_cost_minor: m.cost, diff_centavos: m.diff, _m: m };
}

// ---------------------------------------------------------------------------------------------
// People and permissions
// ---------------------------------------------------------------------------------------------

/** The counter is the person who must not approve and who must not see expected on a blind count.
 * @param {any} t @param {any} session @param {any} actor */
async function isCounter(t, session, actor) {
  if (session.created_by === actor.userId) return true;
  const [r] =
    await t`select 1 from stock_count_lines where session_id=${session.id} and counted_by=${actor.userId} limit 1`;
  return Boolean(r);
}
/** Same rule as the old count detail: blind counts hide expected from counters and from people who cannot approve.
 * @param {any} session @param {any} actor @param {boolean} counter */
function canSeeExpected(session, actor, counter) {
  return (
    !session.blind_count ||
    (!counter && roleHas(actor.role, "inventory.count.approve"))
  );
}
/** Counter and approver must be different people (every person who counted a line counts as a counter).
 * @param {any} t @param {any} session @param {any} actor */
async function approverNotCounter(t, session, actor) {
  notSelf(actor, session.created_by);
  const rows =
    await t`select distinct counted_by from stock_count_lines where session_id=${session.id} and counted_by is not null`;
  for (const r of rows) notSelf(actor, r.counted_by);
}
/** @param {any} c @param {string} userId @param {string} locationId */
async function mustBeAbleToCount(c, userId, locationId) {
  const person = await actorFor(c.db, userId);
  if (!person)
    invalid("That person is not an active user.", "assignee_not_found");
  if (!roleHas(person.role, "inventory.count.submit"))
    invalid(
      "That person can't count stock. Choose a warehouse clerk or a manager.",
      "assignee_cannot_count",
    );
  try {
    await locationGate(
      { ...c, actor: person },
      "inventory.count.submit",
      locationId,
    );
  } catch {
    invalid(
      "That person has no access to this place. Choose someone who works there.",
      "assignee_out_of_scope",
    );
  }
}
/** @param {any} c @param {string} locationId */
async function countersAt(c, locationId) {
  const profiles =
    await c.db`select p.user_id,p.name,p.role from profiles p join users u on u.id=p.user_id where p.status='active' and p.deleted_at is null and u.disabled_at is null order by p.name`;
  /** @type {any[]} */ const out = [];
  for (const p of profiles) {
    if (!roleHas(p.role, "inventory.count.submit")) continue;
    const person = await actorFor(c.db, p.user_id);
    if (!person) continue;
    try {
      await locationGate(
        { ...c, actor: person },
        "inventory.count.submit",
        locationId,
      );
      out.push({ userId: p.user_id, name: p.name, role: p.role });
    } catch {
      /* out of scope */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

/** counts/plan: scope, counter, blind or not, schedule. @param {any} c @param {any} b @param {Place} loc */
async function runPlan(c, b, loc) {
  const scope = readScope(b);
  const includeSub = b.includeSublocations === true;
  const countType = choice(
    b.countType,
    ["cycle", "full", "spot", "route_close"],
    scope.type === "all" ? "full" : "cycle",
  );
  if (countType === "full" && scope.type !== "all")
    invalid(
      "A full count covers everything. Choose a cycle count to count only part of it.",
      "scope_needs_cycle",
    );
  const assignedTo = b.assignedTo == null ? null : text(b.assignedTo, "Counter", 100);
  if (assignedTo && assignedTo !== c.actor.userId)
    await mustBeAbleToCount(c, assignedTo, loc.id);
  const scheduledFor =
    b.scheduledFor == null ? null : isoDate(b.scheduledFor, "Schedule date");
  const made = await createSession(c.db, {
    location: loc,
    scope,
    includeSub,
    countType,
    blind: b.blindCount !== false,
    counterId: assignedTo ?? c.actor.userId,
    plannerId: c.actor.userId,
    assignedTo,
    title: b.title == null ? null : text(b.title, "Name", 160),
    scheduledFor,
    status: "planned",
    now: c.now,
  });
  return { id: made.id, number: made.number, lines: made.lines };
}
/** Old entry point kept for the store till and the old screen: a whole-location count that starts immediately.
 * @param {any} c @param {any} b @param {Place} loc */
async function runStart(c, b, loc) {
  const scope = readScope(b);
  if (scope.productIds && b.countType !== "cycle")
    invalid("A product subset is only allowed for a cycle count");
  const made = await createSession(c.db, {
    location: loc,
    scope,
    includeSub: false,
    countType: choice(
      b.countType,
      ["cycle", "full", "spot", "route_close"],
      "cycle",
    ),
    blind: b.blindCount !== false,
    counterId: c.actor.userId,
    plannerId: c.actor.userId,
    status: "counting",
    legacy: true,
    now: c.now,
  });
  return { id: made.id };
}
/** planned -> counting; lines added since the plan was made are picked up. @param {any} c @param {any} session */
async function begin(c, session) {
  if (session.status !== "planned") return session;
  const places = await placesFor(
    c.db,
    await locationOf(c.db, session.location_id),
    session.include_sublocations,
    session.scope ?? {},
  );
  const roster = await buildRoster(c.db, places, session.scope ?? {}, c.now);
  await insertRoster(c.db, session, roster);
  await c.db`update stock_count_sessions set status='counting',counting_started_at=${new Date(c.now)} where id=${session.id}`;
  return { ...session, status: "counting" };
}
/** @param {any} t @param {string} locationId @returns {Promise<Place>} */
async function locationOf(t, locationId) {
  const [row] =
    await t`select * from inventory_locations where id=${locationId} and organization_id=${ORGANIZATION}`;
  if (!row) throw new ApiError("not_found", 404, "Stock location not found");
  return row;
}
/** @param {any} t @param {string} sessionId @param {string} lineId */
async function lineOf(t, sessionId, lineId) {
  const [line] =
    await t`select * from stock_count_lines where id=${id(lineId, "Line")} and session_id=${sessionId} for update`;
  if (!line) invalid("That line is not part of this count", "line_not_found");
  return line;
}
/** @param {any} c @param {any} entry */
async function photoFor(c, entry) {
  if (entry.photoFileId == null) return null;
  const fileId = id(entry.photoFileId, "Photo");
  const [f] =
    await c.db`select id from files where id=${fileId} and created_by=${c.actor.userId}`;
  if (!f) invalid("That photo was not uploaded by you", "photo_not_found");
  return fileId;
}
/** One line saved: the draft write. @param {any} c @param {any} session @param {any} line @param {any} entry @param {(p:string)=>Promise<any>} info
 * @param {{deviceLabel?:string|null, kind?:'saved'|'added'}} [o] */
async function applySave(c, session, line, entry, info, o = {}) {
  const countedBase = integer(entry.countedBase, "Count");
  const asked =
    entry.countedAt == null ? c.now : integer(entry.countedAt, "Count time", 1);
  const countedAt = Math.min(asked, c.now);
  if (
    entry.clientOpId != null &&
    line.client_op === String(entry.clientOpId) &&
    line.counted_base != null
  )
    return { lineId: line.id, result: "duplicate" };
  if (
    line.counted_base != null &&
    line.counted_at &&
    countedAt < new Date(line.counted_at).getTime()
  )
    return { lineId: line.id, result: "superseded" };
  const finding =
    "finding" in entry && entry.finding != null
      ? choice(entry.finding, FINDINGS)
      : "finding" in entry
        ? null
        : line.finding;
  const note =
    "note" in entry
      ? entry.note == null || entry.note === ""
        ? null
        : text(entry.note, "Note", 500)
      : line.note;
  const photo =
    "photoFileId" in entry ? await photoFor(c, entry) : line.photo_file_id;
  const reopened = line.review_decision != null && !line.review_auto;
  const m = await measure(
    c.db,
    session,
    { ...line, counted_base: countedBase, counted_at: new Date(countedAt) },
    c.now,
    info,
  );
  await c.db`update stock_count_lines set counted_base=${countedBase},counted_by=${c.actor.userId},counted_at=${new Date(countedAt)},system_base=${m.expected},variance_base=${m.variance},unit_cost_minor=${m.cost},diff_centavos=${m.diff},finding=${finding},note=${note},photo_file_id=${photo},client_op=${entry.clientOpId == null ? null : String(entry.clientOpId).slice(0, 100)},device_label=${o.deviceLabel ?? line.device_label ?? null},review_decision=null,review_auto=false,reason_code=${reopened ? null : line.reason_code},review_note=${reopened ? null : line.review_note},reviewed_by=null,reviewed_at=null where id=${line.id}`;
  await c.db`insert into stock_count_line_events (session_id,line_id,kind,actor_user_id,device_label,counted_base,expected_base,note) values (${session.id},${line.id},${o.kind ?? (reopened ? "reopened" : "saved")},${c.actor.userId},${o.deviceLabel ?? null},${countedBase},${m.expected},${note})`;
  return { lineId: line.id, result: "saved", countedBase };
}
/** Who may enter numbers: on a blind count only the counter. @param {any} c @param {any} session */
function mustBeCounter(c, session) {
  if (session.blind_count && session.created_by !== c.actor.userId)
    throw new ApiError(
      "forbidden",
      403,
      "Only the assigned counter may enter this blind count",
    );
}
/** @param {any} t @param {string} sessionId */
async function progressOf(t, sessionId) {
  const [p] = await t`select count(*)::int as total,
      count(*) filter (where counted_base is not null)::int as counted,
      count(*) filter (where review_decision='recount')::int as recount
    from stock_count_lines where session_id=${sessionId}`;
  return p;
}

/** counts/save-lines: partial, idempotent per line, any device. @param {any} c @param {any} b @param {any} session */
async function runSaveLines(c, b, session) {
  state(session, ["planned", "counting"]);
  mustBeCounter(c, session);
  const entries = list(b.lines, "Lines", SAVE_MAX);
  session = await begin(c, session);
  const info = infoLoader(c.db, c.now);
  const device = b.deviceLabel == null ? null : text(b.deviceLabel, "Device", 80);
  const results = [];
  for (const e of entries) {
    const line = await lineOf(c.db, session.id, e.lineId);
    results.push(
      await applySave(c, session, line, e, info, { deviceLabel: device }),
    );
  }
  return { id: session.id, results, progress: await progressOf(c.db, session.id) };
}
/** counts/add-line: a found item, a wrong batch or another place. @param {any} c @param {any} b @param {any} session */
async function runAddLine(c, b, session) {
  state(session, ["planned", "counting"]);
  mustBeCounter(c, session);
  session = await begin(c, session);
  const { product, tracking } = await productPolicy(c.db, id(b.productId, "Product"));
  const stockStatus = choice(b.stockStatus, STATUSES, "available");
  const locationId = b.locationId == null ? session.location_id : id(b.locationId, "Place");
  if (locationId !== session.location_id) {
    const places = await placesFor(
      c.db,
      await locationOf(c.db, session.location_id),
      true,
      {},
    );
    if (!places.some((p) => p.id === locationId))
      invalid("That place is not part of this count", "place_out_of_scope");
  }
  /** @type {string|null} */ let lotId = null;
  if (tracking === "lot") {
    if (b.lotId != null) lotId = id(b.lotId, "Batch");
    else if (b.lotNumber != null) {
      const [lot] =
        await c.db`select id from inventory_lots where organization_id=${ORGANIZATION} and product_id=${product.id} and normalized_lot_number=${text(b.lotNumber, "Batch number", 100).toUpperCase()}`;
      lotId = lot?.id ?? null;
    }
    if (!lotId)
      invalid(
        "Choose the batch. If it is not in the system, ask the office to receive it first.",
        "lot_required",
      );
    const [lot] =
      await c.db`select id from inventory_lots where id=${lotId} and product_id=${product.id} and organization_id=${ORGANIZATION}`;
    if (!lot) invalid("That batch belongs to a different product", "lot_mismatch");
  }
  const where = locationId === session.location_id ? null : locationId;
  const [existing] =
    await c.db`select * from stock_count_lines where session_id=${session.id} and coalesce(location_id,${ZERO_UUID}::uuid)=coalesce(${where}::uuid,${ZERO_UUID}::uuid) and product_id=${product.id} and coalesce(lot_id,${ZERO_UUID}::uuid)=coalesce(${lotId}::uuid,${ZERO_UUID}::uuid) and stock_status=${stockStatus} for update`;
  const info = infoLoader(c.db, c.now);
  const entry = {
    countedBase: b.countedBase,
    countedAt: b.countedAt,
    clientOpId: b.clientOpId,
    finding: b.finding ?? (existing ? undefined : "over"),
    note: b.note,
    photoFileId: b.photoFileId,
  };
  if (!("finding" in entry) || entry.finding === undefined) delete entry.finding;
  if (b.note === undefined) delete entry.note;
  if (b.photoFileId === undefined) delete entry.photoFileId;
  const device = b.deviceLabel == null ? null : text(b.deviceLabel, "Device", 80);
  if (existing) {
    const r = await applySave(c, session, existing, entry, info, { deviceLabel: device });
    return { id: session.id, created: false, ...r };
  }
  const total = (await progressOf(c.db, session.id)).total;
  if (total >= MAX_LINES)
    invalid(`A count can have up to ${MAX_LINES} lines.`, "count_too_large");
  const [line] =
    await c.db`insert into stock_count_lines (organization_id,session_id,product_id,lot_id,stock_status,system_base,location_id,source) values (${ORGANIZATION},${session.id},${product.id},${lotId},${stockStatus},0,${where},'found') returning *`;
  const r = await applySave(c, session, line, entry, info, { deviceLabel: device, kind: "added" });
  return { id: session.id, created: true, ...r };
}
/** counts/submit: the counter is done. Lines inside tolerance are accepted on the spot.
 * The old body (every line in one call) still works. @param {any} c @param {any} b @param {any} session */
async function runSubmit(c, b, session) {
  state(session, ["planned", "counting"]);
  mustBeCounter(c, session);
  session = await begin(c, session);
  const info = infoLoader(c.db, c.now);
  if (b.lines !== undefined) {
    const entries = list(b.lines, "Lines", MAX_LINES);
    const rows =
      await c.db`select id from stock_count_lines where session_id=${session.id}`;
    if (
      session.legacy_whole &&
      (entries.length !== rows.length ||
        new Set(entries.map((/** @type {any} */ l) => l.lineId)).size !== rows.length ||
        rows.some((/** @type {any} */ r) => !entries.some((/** @type {any} */ l) => l.lineId === r.id)))
    )
      invalid("Count every line exactly once");
    for (const e of entries)
      await applySave(c, session, await lineOf(c.db, session.id, e.lineId), e, info);
  }
  const open = await c.db`select id from stock_count_lines where session_id=${session.id} and counted_base is null and review_decision is distinct from 'rejected' order by id`;
  if (open.length && b.allowUncounted !== true)
    refuse(
      `${open.length} ${open.length === 1 ? "item still needs" : "items still need"} a count. Count ${open.length === 1 ? "it" : "them"}, or leave them out.`,
      "lines_not_counted",
      409,
    );
  for (const o of open) {
    await c.db`update stock_count_lines set review_decision='rejected',review_auto=true,review_note='Not counted',reviewed_at=${new Date(c.now)} where id=${o.id}`;
    await c.db`insert into stock_count_line_events (session_id,line_id,kind,actor_user_id,note) values (${session.id},${o.id},'rejected',${c.actor.userId},'Not counted')`;
  }
  const tol = await toleranceFor(c.db, ORGANIZATION, "count_variance", c.now);
  const lines =
    await c.db`select * from stock_count_lines where session_id=${session.id} and counted_base is not null order by id`;
  let auto = 0,
    needs = 0;
  for (const l of lines) {
    const fresh = await refreshLine(c.db, session, l, c.now, info);
    if (session.legacy_whole) continue;
    if (fresh.review_decision && !fresh.review_auto) continue;
    const j = judge(tol, fresh._m);
    if (j.within) {
      auto++;
      await c.db`update stock_count_lines set review_decision='accepted',review_auto=true,reason_code=coalesce(reason_code,${DEFAULT_REASON}),review_note=coalesce(review_note,'Within tolerance'),reviewed_at=${new Date(c.now)} where id=${l.id}`;
      await c.db`insert into stock_count_line_events (session_id,line_id,kind,actor_user_id,counted_base,expected_base) values (${session.id},${l.id},'auto_accepted',${c.actor.userId},${fresh.counted_base},${fresh.system_base})`;
    } else {
      needs++;
      await c.db`update stock_count_lines set review_decision=null,review_auto=false where id=${l.id}`;
    }
  }
  await c.db`update stock_count_sessions set status='submitted',submitted_at=${new Date(c.now)},submitted_by=${c.actor.userId} where id=${session.id}`;
  return { id: session.id, autoAccepted: auto, needsReview: needs };
}
/** @param {any} c @param {any} session @param {string} lineId @param {string} decision @param {{reasonCode?:string,note?:string}} o
 * @param {(p:string)=>Promise<any>} info @param {any} tol */
async function decideLine(c, session, lineId, decision, o, info, tol) {
  const line = await lineOf(c.db, session.id, lineId);
  if (line.counted_base == null && decision !== "rejected")
    invalid("Count this line before deciding on it", "line_not_counted");
  if (decision === "recount") {
    await c.db`update stock_count_lines set review_decision='recount',review_auto=false,previous_counted_base=counted_base,counted_base=null,variance_base=null,diff_centavos=null,recount_requested_at=${new Date(c.now)},recount_count=recount_count+1,review_note=${o.note ?? null},reviewed_by=${c.actor.userId},reviewed_at=${new Date(c.now)} where id=${line.id}`;
    await c.db`insert into stock_count_line_events (session_id,line_id,kind,actor_user_id,counted_base,expected_base,note) values (${session.id},${line.id},'recount_requested',${c.actor.userId},${line.counted_base},${line.system_base},${o.note ?? null})`;
    return;
  }
  if (decision === "rejected") {
    const note = text(o.note, "Say why this line is left out", 500);
    await c.db`update stock_count_lines set review_decision='rejected',review_auto=false,review_note=${note},reviewed_by=${c.actor.userId},reviewed_at=${new Date(c.now)} where id=${line.id}`;
    await c.db`insert into stock_count_line_events (session_id,line_id,kind,actor_user_id,counted_base,expected_base,note) values (${session.id},${line.id},'rejected',${c.actor.userId},${line.counted_base},${line.system_base},${note})`;
    return;
  }
  const fresh = await refreshLine(c.db, session, line, c.now, info);
  const variance = Number(fresh.variance_base);
  let reason = null;
  const note = o.note ?? line.review_note ?? line.note ?? null;
  if (variance !== 0) {
    const code = o.reasonCode ?? line.reason_code;
    if (!code)
      invalid("Choose a reason for this difference.", "reason_required");
    reason = (
      await requireReason(c.db, ORGANIZATION, code, {
        direction: variance > 0 ? "in" : "out",
        note,
        photoCount: line.photo_file_id ? 1 : 0,
      })
    ).code;
  }
  void tol;
  await c.db`update stock_count_lines set review_decision='accepted',review_auto=false,reason_code=${reason},review_note=${o.note ?? line.review_note ?? null},reviewed_by=${c.actor.userId},reviewed_at=${new Date(c.now)} where id=${line.id}`;
  await c.db`insert into stock_count_line_events (session_id,line_id,kind,actor_user_id,counted_base,expected_base,note) values (${session.id},${line.id},'accepted',${c.actor.userId},${fresh.counted_base},${fresh.system_base},${o.note ?? null})`;
}
/** counts/review and counts/request-recount. @param {any} c @param {any} b @param {any} session @param {string|null} forced */
async function runReview(c, b, session, forced) {
  state(session, ["submitted"]);
  await approverNotCounter(c.db, session, c.actor);
  const decision = forced ?? choice(b.decision, ["accepted", "rejected", "recount"]);
  const ids = list(
    b.lineIds ?? (b.lineId ? [b.lineId] : undefined),
    "Lines",
    SAVE_MAX,
  );
  const info = infoLoader(c.db, c.now);
  const tol = await toleranceFor(c.db, ORGANIZATION, "count_variance", c.now);
  for (const lineId of ids)
    await decideLine(c, session, lineId, decision, b, info, tol);
  if (decision === "recount")
    await c.db`update stock_count_sessions set status='counting',submitted_at=null,submitted_by=null where id=${session.id}`;
  return {
    id: session.id,
    decided: ids.length,
    status: decision === "recount" ? "counting" : "submitted",
  };
}
/** @param {number} n @param {string} noun */
const plural = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** counts/approve: ONE adjustment, a reason on every line. @param {any} c @param {any} b @param {any} session */
async function runApprove(c, b, session) {
  state(session, ["submitted"]);
  await approverNotCounter(c.db, session, c.actor);
  const info = infoLoader(c.db, c.now);
  const tol = await toleranceFor(c.db, ORGANIZATION, "count_variance", c.now);
  const all =
    await c.db`select * from stock_count_lines where session_id=${session.id} order by id`;
  const takeRest = session.legacy_whole || b.acceptRemaining === true;
  /** @type {any[]} */ const post_ = [];
  let pending = 0,
    recount = 0,
    uncounted = 0;
  for (const l of all) {
    if (l.review_decision === "rejected") continue;
    if (l.review_decision === "recount") {
      recount++;
      continue;
    }
    if (l.counted_base == null) {
      uncounted++;
      continue;
    }
    const fresh = await refreshLine(c.db, session, l, c.now, info);
    const variance = Number(fresh.variance_base);
    let decided = fresh.review_decision === "accepted";
    if (decided && fresh.review_auto && variance !== 0 && !judge(tol, fresh._m).within) {
      await c.db`update stock_count_lines set review_decision=null,review_auto=false where id=${l.id}`;
      decided = false;
    }
    if (!decided && variance !== 0 && !takeRest) {
      pending++;
      continue;
    }
    if (variance !== 0) post_.push({ ...fresh, _auto: !decided || fresh.review_auto });
  }
  if (uncounted) invalid("Every line must be counted");
  if (recount)
    refuse(
      `${plural(recount, "line")} ${recount === 1 ? "is" : "are"} waiting for a recount.`,
      "recount_pending",
    );
  if (pending)
    refuse(
      `${plural(pending, "line")} still ${pending === 1 ? "needs" : "need"} your decision. Accept, reject or ask for a recount.`,
      "review_required",
    );

  /** @type {Map<string,string>} */ const reasonCache = new Map();
  for (const l of post_) {
    const variance = Number(l.variance_base);
    const note =
      l.review_note ?? l.note ?? (l._auto ? "Stock count" : null);
    const code = l.reason_code ?? DEFAULT_REASON;
    const key = `${code}|${variance > 0 ? "in" : "out"}|${note ? 1 : 0}|${l.photo_file_id ? 1 : 0}`;
    if (!reasonCache.has(key))
      reasonCache.set(
        key,
        (
          await requireReason(c.db, ORGANIZATION, code, {
            direction: variance > 0 ? "in" : "out",
            note,
            photoCount: l.photo_file_id ? 1 : 0,
          })
        ).code,
      );
    l._reason = reasonCache.get(key);
  }
  const location = await locationOf(c.db, session.location_id);
  const adjustmentId = crypto.randomUUID();
  const number = await nextDocNumber(c.db, ORGANIZATION, {
    type: "ADJ",
    locationCode: docLoc(location.code),
    at: c.now,
  });
  const header =
    typeof b.reasonCode === "string" && b.reasonCode.trim()
      ? b.reasonCode.trim().slice(0, 100)
      : "stock_count";
  await c.db`insert into inventory_adjustments (id,organization_id,adjustment_number,adjustment_type,reason_code,source_count_id,status,requested_by,approved_by) values (${adjustmentId},${ORGANIZATION},${number},'stock_count',${header},${session.id},'approved',${session.created_by},${c.actor.userId})`;
  const rows = post_.map((l) => ({
    ...l,
    location_id: l.location_id ?? session.location_id,
  }));
  await enforceInventoryAuthority(
    c,
    {
      ...session,
      id: adjustmentId,
      source_count_id: session.id,
      reason_code: header,
      adjustment_number: number,
    },
    rows,
    "inventory.count.submit",
  );
  for (const l of rows)
    await c.db`insert into inventory_adjustment_lines (organization_id,adjustment_id,product_id,lot_id,location_id,stock_status,variance_base,reason_code) values (${ORGANIZATION},${adjustmentId},${l.product_id},${l.lot_id},${l.location_id},${l.stock_status},${l.variance_base},${l._reason})`;
  const movementIds = [];
  for (let i = 0; i < rows.length; i += POST_CHUNK) {
    const m = await post(
      c,
      {
        ...b,
        idempotencyKey: i === 0 ? b.idempotencyKey : `${b.idempotencyKey}:p${i / POST_CHUNK}`,
      },
      "inventory_adjustment",
      "stock_count",
      adjustmentId,
      rows.slice(i, i + POST_CHUNK).map((l) => varianceLine(l, l.location_id)),
    );
    movementIds.push(m.movementId);
  }
  await c.db`update inventory_adjustments set status='posted',movement_id=${movementIds[0] ?? null} where id=${adjustmentId}`;
  await c.db`update stock_count_sessions set status='posted',approved_by=${c.actor.userId},adjustment_id=${adjustmentId},movement_ids=${movementIds.length > 1 ? JSON.stringify(movementIds) : null}::text::jsonb where id=${session.id}`;
  await c.db`update stock_count_lines set review_decision='accepted',reviewed_by=coalesce(reviewed_by,${c.actor.userId}),reviewed_at=coalesce(reviewed_at,${new Date(c.now)}) where session_id=${session.id} and counted_base is not null and review_decision is null`;
  return {
    id: session.id,
    adjustmentId,
    adjustmentNumber: number,
    movementId: movementIds[0] ?? null,
    posted: rows.length,
  };
}
/** @param {any} row @param {string} locationId */
function varianceLine(row, locationId) {
  const v = Number(row.variance_base);
  return {
    productId: row.product_id,
    quantityBase: Math.abs(v),
    uom: "base",
    fromLocationId: v < 0 ? locationId : null,
    toLocationId: v > 0 ? locationId : null,
    stockStatus: row.stock_status,
    lotId: row.lot_id,
    ...(v > 0 && row.unit_cost_minor != null
      ? { unitCostMinor: Number(row.unit_cost_minor) }
      : {}),
  };
}
/** @param {any} c @param {any} b @param {any} session */
async function runCancel(c, b, session) {
  state(session, ["planned", "counting", "submitted"]);
  await c.db`update stock_count_sessions set status='cancelled' where id=${session.id}`;
  void b;
  return { id: session.id };
}
/** Hand a count to someone else while it has not been approved. @param {any} c @param {any} b @param {any} session */
async function runAssign(c, b, session) {
  state(session, ["planned", "counting"]);
  const to = text(b.assignedTo, "Counter", 100);
  await mustBeAbleToCount(c, to, session.location_id);
  await c.db`update stock_count_sessions set created_by=${to},assigned_to=${to} where id=${session.id}`;
  return { id: session.id };
}
/** @param {any} c @param {any} b @param {any} session */
async function runBegin(c, b, session) {
  state(session, ["planned", "counting"]);
  mustBeCounter(c, session);
  await begin(c, session);
  void b;
  return { id: session.id, status: "counting" };
}

/** counts/schedule-save @param {any} c @param {any} b @param {Place} loc */
async function runScheduleSave(c, b, loc) {
  const scope = readScope(b);
  const cadence = clampInt(b.cadenceDays, 1, 366, "Repeat every (days)");
  const nextDue = b.nextDue == null ? manilaDate(c.now) : isoDate(b.nextDue, "Next date");
  const assignedTo = b.assignedTo == null ? null : text(b.assignedTo, "Counter", 100);
  if (assignedTo) await mustBeAbleToCount(c, assignedTo, loc.id);
  const values = {
    name: text(b.name, "Name", 160),
    countType: choice(b.countType, ["cycle", "full", "spot"], scope.type === "all" ? "full" : "cycle"),
  };
  if (b.id) {
    const [old] =
      await c.db`select * from stock_count_schedules where id=${id(b.id)} and organization_id=${ORGANIZATION} for update`;
    if (!old) throw new ApiError("not_found", 404, "Schedule not found");
    await c.db`update stock_count_schedules set name=${values.name},location_id=${loc.id},scope=${JSON.stringify(scope)}::text::jsonb,include_sublocations=${b.includeSublocations === true},count_type=${values.countType},blind_count=${b.blindCount !== false},assigned_to=${assignedTo},cadence_days=${cadence},next_due=${nextDue},active=${b.active !== false} where id=${old.id}`;
    return { id: old.id };
  }
  const [row] =
    await c.db`insert into stock_count_schedules (organization_id,name,location_id,scope,include_sublocations,count_type,blind_count,assigned_to,cadence_days,next_due,active,created_by) values (${ORGANIZATION},${values.name},${loc.id},${JSON.stringify(scope)}::text::jsonb,${b.includeSublocations === true},${values.countType},${b.blindCount !== false},${assignedTo},${cadence},${nextDue},${b.active !== false},${c.actor.userId}) returning id`;
  return { id: row.id };
}

/**
 * Plan every schedule that is due (Manila date). A schedule whose last count is still open is skipped,
 * so counts never pile up. Safe to run twice. @param {any} db @param {number} [now]
 */
export async function planDueCounts(db, now = Date.now()) {
  return tx(db, async (t) => {
    await stockLock(t, ORGANIZATION);
    const today = manilaDate(now);
    const due =
      await t`select * from stock_count_schedules where organization_id=${ORGANIZATION} and active and next_due<=${today}::date order by next_due,id for update`;
    /** @type {string[]} */ const planned = [];
    for (const s of due) {
      const [open] = s.last_session_id
        ? await t`select id from stock_count_sessions where id=${s.last_session_id} and status in ('planned','counting','submitted')`
        : [];
      if (!open) {
        const location = await locationOf(t, s.location_id);
        try {
          const made = await createSession(t, {
            location,
            scope: s.scope ?? { type: "all" },
            includeSub: s.include_sublocations,
            countType: s.count_type,
            blind: s.blind_count,
            counterId: s.assigned_to ?? s.created_by,
            plannerId: s.created_by,
            assignedTo: s.assigned_to,
            title: s.name,
            scheduledFor: today,
            status: "planned",
            scheduleId: s.id,
            now,
          });
          planned.push(made.id);
          await t`update stock_count_schedules set last_session_id=${made.id} where id=${s.id}`;
        } catch (error) {
          // Nothing to count today (empty place): try again at the next cadence rather than failing the job.
          if (!(error instanceof ApiError) || error.code !== "nothing_to_count")
            throw error;
        }
      }
      let next = String(new Date(s.next_due).toISOString().slice(0, 10));
      do {
        next = new Date(Date.parse(`${next}T00:00:00Z`) + s.cadence_days * 86400000)
          .toISOString()
          .slice(0, 10);
      } while (next <= today);
      await t`update stock_count_schedules set next_due=${next}::date where id=${s.id}`;
    }
    return { planned };
  });
}

// ---------------------------------------------------------------------------------------------
// Command table
// ---------------------------------------------------------------------------------------------

/** @param {string} cap @param {string} [alt] */
function gateSession(cap, alt) {
  return async (/** @type {any} */ c, /** @type {any} */ b) => {
    const row = await document(c.db, "stock_count_sessions", id(b.sessionId));
    await locationGate(c, cap, row.location_id);
    void alt;
    return row;
  };
}

/** Called by commands.js once its own commands exist. */
export function installCountCommands() {
  const gate = gateSession;
  commands["counts/plan"] = {
    cap: "inventory.count.submit",
    prepare: async (c, b) =>
      locationGate(c, "inventory.count.submit", id(b.locationId)),
    run: runPlan,
  };
  commands["counts/start"] = {
    cap: "inventory.count.submit",
    prepare: async (c, b) =>
      locationGate(c, "inventory.count.submit", id(b.locationId)),
    run: runStart,
  };
  commands["counts/begin"] = {
    cap: "inventory.count.submit",
    prepare: gate("inventory.count.submit"),
    run: runBegin,
  };
  commands["counts/save-lines"] = {
    cap: "inventory.count.submit",
    prepare: gate("inventory.count.submit"),
    run: runSaveLines,
  };
  commands["counts/add-line"] = {
    cap: "inventory.count.submit",
    prepare: gate("inventory.count.submit"),
    run: runAddLine,
  };
  commands["counts/submit"] = {
    cap: "inventory.count.submit",
    prepare: gate("inventory.count.submit"),
    run: runSubmit,
  };
  commands["counts/assign"] = {
    cap: "inventory.count.approve",
    prepare: gate("inventory.count.approve"),
    run: runAssign,
  };
  commands["counts/review"] = {
    cap: "inventory.count.approve",
    prepare: gate("inventory.count.approve"),
    run: (c, b, row) => runReview(c, b, row, null),
  };
  commands["counts/request-recount"] = {
    cap: "inventory.count.approve",
    prepare: gate("inventory.count.approve"),
    run: (c, b, row) => runReview(c, b, row, "recount"),
  };
  commands["counts/approve"] = {
    cap: "inventory.count.approve",
    prepare: gate("inventory.count.approve"),
    run: runApprove,
  };
  commands["counts/cancel"] = {
    cap: "inventory.count.submit",
    prepare: gate("inventory.count.submit"),
    run: runCancel,
  };
  commands["counts/schedule-save"] = {
    cap: "inventory.count.approve",
    prepare: async (c, b) =>
      locationGate(c, "inventory.count.approve", id(b.locationId)),
    run: runScheduleSave,
  };
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

/** @param {any} ctx @param {string} name */
const param = (ctx, name) => ctx.url.searchParams.get(name);
/** @param {any} ctx */
function pageOf(ctx) {
  const limit = clampInt(param(ctx, "limit") ?? 50, 1, 200, "Page size");
  const cursor = clampInt(param(ctx, "cursor") ?? 0, 0, 1_000_000, "Page cursor");
  return { limit, cursor };
}
/** @param {any} s @param {Map<string,any>} locs @param {any} p */
function card(s, locs, p) {
  return {
    id: s.id,
    number: s.count_number,
    title: s.title,
    status: s.status,
    blindCount: s.blind_count,
    countType: s.count_type,
    locationId: s.location_id,
    location: locs.get(s.location_id)?.name ?? null,
    scope: scopeLabel(s.scope, s.include_sublocations),
    scheduledFor: s.scheduled_for ? String(new Date(s.scheduled_for).toISOString().slice(0, 10)) : null,
    submittedAt: s.submitted_at ? new Date(s.submitted_at).getTime() : null,
    createdAt: new Date(s.created_at).getTime(),
    progress: {
      total: Number(p?.total ?? 0),
      counted: Number(p?.counted ?? 0),
      recount: Number(p?.recount ?? 0),
      needsReview: Number(p?.needs_review ?? 0),
    },
  };
}
/** @param {any} db @param {string[]} sessionIds */
async function progressMap(db, sessionIds) {
  /** @type {Map<string,any>} */ const map = new Map();
  if (!sessionIds.length) return map;
  const rows = await db`select session_id,count(*)::int as total,
      count(*) filter (where counted_base is not null)::int as counted,
      count(*) filter (where review_decision='recount')::int as recount,
      count(*) filter (where counted_base is not null and review_decision is null)::int as needs_review
    from stock_count_lines where session_id in ${db(sessionIds)} group by session_id`;
  for (const r of rows) map.set(r.session_id, r);
  return map;
}

/** GET counts/mine: what I count, and (for approvers) what waits for my review. @param {any} ctx */
async function mineRoute(ctx) {
  const actor = await requireCapability(ctx, "inventory.read");
  const locations = await visibleLocations(ctx);
  const locs = new Map(locations.map((l) => [l.id, l]));
  const ids = locations.map((l) => l.id);
  if (!ids.length) return { mine: [], toReview: [] };
  const mineRows = await ctx.db`select s.* from stock_count_sessions s
    where s.organization_id=${ORGANIZATION} and s.created_by=${actor.userId} and s.status in ('planned','counting') and s.location_id in ${ctx.db(ids)}
    order by coalesce(s.scheduled_for,s.created_at::date),s.created_at`;
  /** @type {any[]} */ let reviewRows = [];
  if (roleHas(actor.role, "inventory.count.approve"))
    reviewRows = await ctx.db`select s.* from stock_count_sessions s
      where s.organization_id=${ORGANIZATION} and s.status='submitted' and s.created_by<>${actor.userId} and s.location_id in ${ctx.db(ids)}
        and not exists (select 1 from stock_count_lines l where l.session_id=s.id and l.counted_by=${actor.userId})
      order by s.submitted_at,s.created_at`;
  const prog = await progressMap(ctx.db, [...mineRows, ...reviewRows].map((s) => s.id));
  const mine = mineRows.map((/** @type {any} */ s) => card(s, locs, prog.get(s.id)));
  const toReview = reviewRows.map((/** @type {any} */ s) => card(s, locs, prog.get(s.id)));
  return { mine, toReview };
}

/** @param {any} l @param {any} i @param {{see:boolean}} o @param {any} [m] */
function presentLine(l, i, o, m) {
  const counted = l.counted_base == null ? null : qty(Number(l.counted_base), i);
  const row = {
    id: l.id,
    locationId: l.location_id,
    bin: l.bin_code,
    productId: l.product_id,
    code: l.pcode,
    name: l.pname,
    lotId: l.lot_id,
    lotNumber: l.lot_number ?? null,
    expiresAt: l.expires_at ? new Date(l.expires_at).getTime() : null,
    stockStatus: l.stock_status,
    source: l.source,
    basePerCase: i.units.basePerCase,
    basePerPiece: i.units.basePerPiece,
    counted,
    countedAt: l.counted_at ? new Date(l.counted_at).getTime() : null,
    finding: l.finding,
    note: l.note,
    photoFileId: l.photo_file_id,
    needsRecount: l.review_decision === "recount",
    recountNote: l.review_decision === "recount" ? l.review_note : null,
    previousCounted:
      l.previous_counted_base == null || !o.see ? undefined : qty(Number(l.previous_counted_base), i),
  };
  if (!row.previousCounted) delete row.previousCounted;
  if (!o.see || !m) return row;
  return {
    ...row,
    expected: qty(m.expected, i),
    variance: m.variance == null ? null : qty(m.variance, i),
    diffCentavos: m.diff,
    unitCostKnown: m.cost != null,
  };
}

/** GET counts/lines: the counter's list in bin order, paged. @param {any} ctx */
async function linesRoute(ctx) {
  const actor = await requireCapability(ctx, "inventory.read");
  const sessionId = id(param(ctx, "sessionId"), "Count");
  const [session] =
    await ctx.db`select * from stock_count_sessions where id=${sessionId} and organization_id=${ORGANIZATION}`;
  if (!session) throw new ApiError("not_found", 404, "Stock document not found");
  await locationGate(ctx, "inventory.read", session.location_id);
  const counter = await isCounter(ctx.db, session, actor);
  const see = canSeeExpected(session, actor, counter);
  const { limit, cursor } = pageOf(ctx);
  const filter = choice(param(ctx, "filter"), ["all", "todo", "counted", "recount", "found"], "all");
  const q = (param(ctx, "q") ?? "").trim();
  const like = q ? `%${q.replace(/[\\%_]/g, (/** @type {string} */ m) => `\\${m}`)}%` : null;
  const rows = await ctx.db`select l.*,p.code as pcode,p.name as pname,p.category as pcategory,lot.lot_number,lot.expires_at,loc.code as bin_code
    from stock_count_lines l join products p on p.id=l.product_id
    left join inventory_lots lot on lot.id=l.lot_id
    join inventory_locations loc on loc.id=coalesce(l.location_id,${session.location_id})
    where l.session_id=${session.id}
      and (${filter}='all' or (${filter}='todo' and l.counted_base is null) or (${filter}='counted' and l.counted_base is not null)
           or (${filter}='recount' and l.review_decision='recount') or (${filter}='found' and l.source='found'))
      and (${like}::text is null or p.code ilike ${like} or p.name ilike ${like})
    order by loc.code,p.code,lot.lot_number nulls first,l.stock_status,l.id
    limit ${limit + 1} offset ${cursor}`;
  const info = infoLoader(ctx.db, ctx.now);
  const page = rows.slice(0, limit);
  const lines = [];
  for (const l of page) {
    const i = await info(l.product_id);
    lines.push(
      presentLine(l, i, { see }, see ? await measure(ctx.db, session, l, ctx.now, info) : null),
    );
  }
  return {
    session: {
      id: session.id,
      number: session.count_number,
      title: session.title,
      status: session.status,
      blindCount: session.blind_count,
      locationId: session.location_id,
      scope: scopeLabel(session.scope, session.include_sublocations),
    },
    progress: await progressOf(ctx.db, session.id),
    canSeeExpected: see,
    lines,
    nextCursor: rows.length > limit ? String(cursor + limit) : null,
  };
}

/** GET counts/review: biggest peso difference first, tolerance chips, summary. @param {any} ctx */
async function reviewRoute(ctx) {
  const actor = await requireCapability(ctx, "inventory.count.approve");
  const sessionId = id(param(ctx, "sessionId"), "Count");
  const [session] =
    await ctx.db`select * from stock_count_sessions where id=${sessionId} and organization_id=${ORGANIZATION}`;
  if (!session) throw new ApiError("not_found", 404, "Stock document not found");
  await locationGate(ctx, "inventory.read", session.location_id);
  const counter = await isCounter(ctx.db, session, actor);
  const see = canSeeExpected(session, actor, counter);
  const { limit, cursor } = pageOf(ctx);
  const filter = choice(
    param(ctx, "filter"),
    ["all", "needs_review", "auto", "accepted", "rejected", "recount", "variance"],
    "all",
  );
  const sort = choice(param(ctx, "sort"), ["diff", "bin"], "diff");
  const rows = await ctx.db`select l.*,p.code as pcode,p.name as pname,p.category as pcategory,lot.lot_number,lot.expires_at,loc.code as bin_code
    from stock_count_lines l join products p on p.id=l.product_id
    left join inventory_lots lot on lot.id=l.lot_id
    join inventory_locations loc on loc.id=coalesce(l.location_id,${session.location_id})
    where l.session_id=${session.id}
      and (${filter}='all'
        or (${filter}='needs_review' and l.counted_base is not null and l.review_decision is null)
        or (${filter}='auto' and l.review_auto and l.review_decision='accepted')
        or (${filter}='accepted' and l.review_decision='accepted' and not l.review_auto)
        or (${filter}='rejected' and l.review_decision='rejected')
        or (${filter}='recount' and l.review_decision='recount')
        or (${filter}='variance' and coalesce(l.variance_base,0)<>0))
    order by
      case when ${sort}='diff' then (case when l.variance_base is null then 1 else 0 end) end,
      case when ${sort}='diff' then l.diff_centavos end desc nulls first,
      case when ${sort}='diff' then abs(coalesce(l.variance_base,0)) end desc,
      loc.code,p.code,lot.lot_number nulls first,l.id
    limit ${limit + 1} offset ${cursor}`;
  const info = infoLoader(ctx.db, ctx.now);
  const tol = await toleranceFor(ctx.db, ORGANIZATION, "count_variance", ctx.now);
  const page = rows.slice(0, limit);
  const lines = [];
  for (const l of page) {
    const i = await info(l.product_id);
    const m = await measure(ctx.db, session, l, ctx.now, info);
    const j = judge(tol, m);
    lines.push({
      ...presentLine(l, i, { see }, m),
      decision: l.review_decision,
      auto: l.review_auto,
      reasonCode: l.reason_code,
      reviewNote: l.review_note,
      countedBy: l.counted_by,
      recountCount: l.recount_count,
      tolerance: { within: j.within, reason: j.reason },
    });
  }
  const [sum] = await ctx.db`select count(*)::int as total,
      count(*) filter (where counted_base is not null)::int as counted,
      count(*) filter (where coalesce(variance_base,0)<>0)::int as with_difference,
      count(*) filter (where review_auto and review_decision='accepted')::int as auto,
      count(*) filter (where counted_base is not null and review_decision is null)::int as needs_review,
      count(*) filter (where review_decision='accepted' and not review_auto)::int as accepted,
      count(*) filter (where review_decision='rejected')::int as rejected,
      count(*) filter (where review_decision='recount')::int as recount,
      coalesce(sum(diff_centavos) filter (where variance_base<0),0)::text as short_centavos,
      coalesce(sum(diff_centavos) filter (where variance_base>0),0)::text as over_centavos,
      count(*) filter (where variance_base<>0 and diff_centavos is null)::int as unpriced
    from stock_count_lines where session_id=${session.id}`;
  const canApprove =
    session.status === "submitted" &&
    !counter &&
    roleHas(actor.role, "inventory.count.approve");
  return {
    session: {
      id: session.id,
      number: session.count_number,
      title: session.title,
      status: session.status,
      blindCount: session.blind_count,
      locationId: session.location_id,
      scope: scopeLabel(session.scope, session.include_sublocations),
      submittedAt: session.submitted_at ? new Date(session.submitted_at).getTime() : null,
    },
    canSeeExpected: see,
    canApprove,
    tolerance: {
      maxCentavos: tol.maxCentavos,
      maxPieces: tol.maxQtyBase,
      isDefault: tol.isDefault,
    },
    summary: {
      total: sum.total,
      counted: sum.counted,
      withDifference: sum.with_difference,
      autoAccepted: sum.auto,
      needsReview: sum.needs_review,
      accepted: sum.accepted,
      rejected: sum.rejected,
      recount: sum.recount,
      shortCentavos: Number(sum.short_centavos),
      overCentavos: Number(sum.over_centavos),
      netCentavos: Number(sum.over_centavos) - Number(sum.short_centavos),
      unpricedLines: sum.unpriced,
    },
    lines,
    nextCursor: rows.length > limit ? String(cursor + limit) : null,
  };
}

/** GET counts/preview: how many lines a scope would give. @param {any} ctx */
async function previewRoute(ctx) {
  await requireCapability(ctx, "inventory.count.submit");
  const loc = await locationGate(ctx, "inventory.count.submit", id(param(ctx, "locationId"), "Location"));
  const search = param(ctx, "search");
  const category = param(ctx, "category");
  const scope = readScope({
    scope: {
      ...(search ? { search } : {}),
      ...(category ? { category } : {}),
      ...(param(ctx, "fastMovers") === "1"
        ? { fastMovers: { days: Number(param(ctx, "days") ?? 30), top: Number(param(ctx, "top") ?? 50) } }
        : {}),
      ...(param(ctx, "binFrom") ? { binFrom: param(ctx, "binFrom") } : {}),
      ...(param(ctx, "binTo") ? { binTo: param(ctx, "binTo") } : {}),
    },
  });
  const sub = param(ctx, "includeSublocations") === "1";
  const places = await placesFor(ctx.db, loc, sub, scope);
  const roster = await buildRoster(ctx.db, places, scope, ctx.now);
  return {
    lines: roster.length,
    products: new Set(roster.map((r) => r.productId)).size,
    places: places.length,
    tooLarge: roster.length > MAX_LINES,
    scope: scopeLabel(scope, sub),
  };
}
/** GET counts/counters: people who can be given this count. @param {any} ctx */
async function countersRoute(ctx) {
  await requireCapability(ctx, "inventory.count.submit");
  const loc = await locationGate(ctx, "inventory.count.submit", id(param(ctx, "locationId"), "Location"));
  return countersAt(ctx, loc.id);
}
/** GET counts/schedules @param {any} ctx */
async function schedulesRoute(ctx) {
  await requireCapability(ctx, "inventory.count.approve");
  const locations = await visibleLocations(ctx);
  const locs = new Map(locations.map((l) => [l.id, l]));
  if (!locs.size) return [];
  const rows =
    await ctx.db`select * from stock_count_schedules where organization_id=${ORGANIZATION} and location_id in ${ctx.db([...locs.keys()])} order by next_due,name`;
  return rows.map((/** @type {any} */ s) => ({
    id: s.id,
    name: s.name,
    locationId: s.location_id,
    location: locs.get(s.location_id)?.name ?? null,
    scope: scopeLabel(s.scope, s.include_sublocations),
    cadenceDays: s.cadence_days,
    nextDue: String(new Date(s.next_due).toISOString().slice(0, 10)),
    blindCount: s.blind_count,
    assignedTo: s.assigned_to,
    active: s.active,
  }));
}

/** Wire the count reads and the daily scheduler. Called from inventory/index.js.
 * @param {import('../../core/router.js').Router} router @param {any} core */
export function installCountRoutes(router, core) {
  const prefix = "/api/v1/inventory/counts";
  router.get(`${prefix}/mine`, mineRoute);
  router.get(`${prefix}/lines`, linesRoute);
  router.get(`${prefix}/review`, reviewRoute);
  router.get(`${prefix}/preview`, previewRoute);
  router.get(`${prefix}/counters`, countersRoute);
  router.get(`${prefix}/schedules`, schedulesRoute);
  /** @param {{db:any}} ctx */
  const run = async ({ db }) => {
    const r = await planDueCounts(db);
    if (r.planned.length) await core.publish("inventory");
  };
  core.registerJob("inventory.plan-counts", run);
  core.scheduler.daily("05:30", "Asia/Manila", "inventory.plan-counts", run);
}
