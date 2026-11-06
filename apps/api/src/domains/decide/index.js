import { tx } from "@sunpride/db/client";
import { requireCapability, roleHas } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { isUuid } from "../../core/util.js";
import { scopeFilterForActor } from "../org/scope.js";
import { toleranceFor } from "../inventory/tolerances.js";
import { uploadCountPhoto } from "./count-photo.js";

/**
 * IP-NAV: ONE Decide inbox for every approval (SPEC 3.6, 3.9, 8).
 *
 * The inbox does not decide anything by itself. Each row is a document that is waiting for a person, read through the owning
 * lane's own read route (so scope and blind-count rules are the lane's), and Approve / Reject is the owning document's own
 * command, called with the same body its own screen sends. The document's command enforces maker is not checker (the person
 * who asked, counted, sent or received cannot decide); the inbox repeats the rule up front so the screen can say so plainly
 * instead of showing a button that will be refused.
 *
 * Kinds: load_difference, transfer_variance, reload_difference, load_in_difference, count_review, disposition,
 * cash_variance (store till counts and forced closes; van settlement variances are shown and opened, decided in the trip),
 * override_review (a second look at a void, refund, price or discount that was approved at the till).
 */

const KINDS = /** @type {const} */ ({
  load_difference: "Load difference",
  transfer_variance: "Transfer difference",
  reload_difference: "Reload difference",
  load_in_difference: "Load-in difference",
  count_review: "Count review",
  disposition: "Bad order",
  cash_variance: "Cash difference",
  override_review: "Till override",
});
const OVERRIDE_KINDS = ["void_sale", "refund", "price", "discount", "void_line"];
const OVERRIDE_WORDS = /** @type {Record<string,string>} */ ({
  void_sale: "Voided sale",
  refund: "Refund",
  price: "Price change",
  discount: "Discount",
  void_line: "Removed item",
});
const OVERRIDE_DAYS = 14;

/** @param {any} n */
const peso = (n) =>
  `₱${(Number(n) / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** @param {any} v */
const ms = (v) => (v ? new Date(v).getTime() : null);

/**
 * "Up to ₱500 or 1 case is accepted by itself" in words. @param {string} event @param {any} db @param {number} at
 * @param {string} what
 */
async function toleranceRule(db, event, at, what) {
  try {
    const t = await toleranceFor(db, "sunpride", event, at);
    const parts = [];
    if (t.maxCentavos != null) parts.push(peso(t.maxCentavos));
    if (t.maxCases != null) parts.push(`${t.maxCases} ${t.maxCases === 1 ? "case" : "cases"}`);
    if (t.maxQtyBase != null) parts.push(`${t.maxQtyBase} ${t.maxQtyBase === 1 ? "piece" : "pieces"}`);
    if (!parts.length) return null;
    return `${what} above ${parts.join(" or ")} needs a person to decide${t.isDefault ? " (standard setting)" : ""}.`;
  } catch {
    return null;
  }
}

/** @param {any} db @param {string[]} userIds */
async function namesByUser(db, userIds) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await db`select user_id,name from profiles where user_id in ${db(ids)}`;
  return new Map(rows.map((/** @type {any} */ r) => [r.user_id, r.name]));
}

/**
 * Where a handler of another domain answers, called the way the router would. Reads and commands both.
 * @param {any} router @param {any} c @param {"GET"|"POST"} method @param {string} path @param {{query?:Record<string,string>, body?:any}} [o]
 */
async function call(router, c, method, path, o = {}) {
  const found = router.match(method, path);
  if (!found || "methodNotAllowed" in found)
    throw new ApiError("not_found", 404, "That action is not available");
  const url = new URL(path, c.url);
  for (const [k, v] of Object.entries(o.query ?? {})) url.searchParams.set(k, v);
  return found.route.handler({
    ...c,
    url,
    params: found.params,
    body: o.body ?? null,
  });
}

/**
 * @typedef {{
 *  id:string, kind:keyof typeof KINDS, kindLabel:string, title:string, documentNumber:string|null,
 *  askedBy:string|null, askedAt:number|null, valueCentavos:number|null, rule:string|null, link:string|null,
 *  canDecide:boolean, blockedReason:string|null, makerChecker:string, lines:Array<{label:string,value:string}>,
 *  needs:{chargeTo?:boolean}, openOnly?:boolean, sentBack?:{by:string|null,reason:string,at:number}|null,
 *  ref:string, extra?:any
 * }} Item
 */

const MAKER_CHECKER =
  "The person who asked for this, counted it, sent it or received it cannot decide it. The system checks that for you.";

// ------------------------------------------------------------------------ sources

/** Van loads whose count differs from the plan (existing load-difference read). @param {any} router @param {any} c @param {any} actor */
async function loadDifferences(router, c, actor) {
  const res = await call(router, c, "GET", "/api/v1/van/load-differences");
  const rule = await toleranceRule(c.db, "load_out_difference", c.now, "A load difference");
  return /** @type {Item[]} */ (
    res.items.map((/** @type {any} */ l) => {
      const differing = l.lines.filter((/** @type {any} */ x) => x.differs);
      return {
        id: `load_difference:${l.tripId}`,
        ref: l.tripId,
        kind: "load_difference",
        kindLabel: KINDS.load_difference,
        title: `${l.truck}: ${l.sellerName} counted a different load`,
        documentNumber: l.tripNumber,
        askedBy: l.sellerName,
        askedAt: l.requestedAt,
        valueCentavos: l.differenceCentavos == null ? null : Number(l.differenceCentavos),
        rule,
        link: `/van-trips?tripId=${l.tripId}`,
        canDecide: Boolean(l.canDecide),
        blockedReason: l.canDecide
          ? null
          : roleHas(actor.role, "van.load.approve")
            ? "This is your own load, or you counted it. A different supervisor must decide."
            : "Your role cannot approve loads.",
        makerChecker: MAKER_CHECKER,
        lines: differing.slice(0, 8).map((/** @type {any} */ x) => ({
          label: x.productName,
          value: `planned ${x.expected}, counted ${x.counted}${x.reason ? ` (${String(x.reason).replaceAll("_", " ")})` : ""}`,
        })),
        needs: {},
      };
    })
  );
}

const TRANSFER_RULE_EVENT = /** @type {Record<string,string>} */ ({
  van_reload: "transfer_receive_variance",
  van_load_in: "load_in_difference",
});
/** Documents that were received with a difference above the allowed one. @param {any} router @param {any} c @param {any} actor */
async function transferDifferences(router, c, actor) {
  const res = await call(router, c, "GET", "/api/v1/inventory/transfers/list", {
    query: { status: "review_needed" },
  });
  const list = res.transfers.filter((/** @type {any} */ t) => t.type !== "van_load_out");
  if (!list.length) return [];
  const touched = new Map(
    (
      await c.db`select id,updated_at from stock_transfers where id in ${c.db(list.map((/** @type {any} */ t) => t.id))}`
    ).map((/** @type {any} */ r) => [r.id, new Date(r.updated_at).getTime()]),
  );
  const backs = new Map(
    (
      await c.db`select distinct on (ref_id) ref_id,reason,created_at,actor_user_id from decide_log where kind='transfer_send_back' and ref_id in ${c.db(list.map((/** @type {any} */ t) => t.id))} order by ref_id,created_at desc`
    ).map((/** @type {any} */ r) => [r.ref_id, r]),
  );
  const who = await namesByUser(c.db, [...backs.values()].map((/** @type {any} */ b) => b.actor_user_id));
  const rules = new Map();
  /** @param {string} type */
  const ruleFor = async (type) => {
    const ev = TRANSFER_RULE_EVENT[type] ?? "transfer_receive_variance";
    if (!rules.has(ev))
      rules.set(
        ev,
        await toleranceRule(c.db, ev, c.now, "A difference on a delivered document"),
      );
    return rules.get(ev);
  };
  const out = [];
  for (const t of list) {
    const kind =
      t.type === "van_reload"
        ? "reload_difference"
        : t.type === "van_load_in"
          ? "load_in_difference"
          : "transfer_variance";
    const sender = t.people?.dispatchedBy ?? null,
      receiver = t.people?.receivedBy ?? null;
    const mine = [sender?.id, receiver?.id].includes(actor.userId);
    const can = roleHas(actor.role, "inventory.approve") && !mine;
    const back = backs.get(t.id);
    const sentBack =
      back && new Date(back.created_at).getTime() >= (touched.get(t.id) ?? 0)
        ? { by: who.get(back.actor_user_id) ?? null, reason: back.reason, at: new Date(back.created_at).getTime() }
        : null;
    out.push({
      id: `${kind}:${t.id}`,
      ref: t.id,
      kind,
      kindLabel: KINDS[/** @type {keyof typeof KINDS} */ (kind)],
      title: `${t.typeLabel ?? "Document"}: ${t.source?.name ?? "?"} to ${t.destination?.name ?? "?"} was received with a difference`,
      documentNumber: t.number,
      askedBy: receiver?.name ?? sender?.name ?? null,
      askedAt: ms(t.dates?.received ?? t.dates?.firstReceived ?? t.dates?.dispatched ?? t.dates?.created),
      valueCentavos: Number(t.varianceValueCentavos ?? 0),
      rule: await ruleFor(t.type),
      link: `/operations/transfers/${t.id}`,
      canDecide: can,
      blockedReason: can
        ? null
        : mine
          ? "You sent or received this, so a different person must decide the difference."
          : "Only an approver (or the owner) can decide a difference on a delivered document. Ask one.",
      makerChecker: MAKER_CHECKER,
      lines: [
        sender ? { label: "Sent by", value: sender.name ?? "—" } : null,
        receiver ? { label: "Received by", value: receiver.name ?? "—" } : null,
      ].filter(Boolean),
      needs: { chargeTo: true },
      sentBack,
    });
  }
  return /** @type {Item[]} */ (out);
}

/** Submitted counts waiting for a different person. @param {any} router @param {any} c @param {any} actor */
async function countReviews(router, c, actor) {
  if (!roleHas(actor.role, "inventory.count.approve")) return [];
  const res = await call(router, c, "GET", "/api/v1/inventory/counts/mine");
  const cards = res.toReview;
  if (!cards.length) return [];
  const ids = cards.map((/** @type {any} */ x) => x.id);
  const sums = new Map(
    (
      await c.db`select session_id,coalesce(sum(abs(diff_centavos)),0)::bigint as v,count(*) filter (where counted_base is not null and review_decision is null)::int as open
        from stock_count_lines where session_id in ${c.db(ids)} group by session_id`
    ).map((/** @type {any} */ r) => [r.session_id, r]),
  );
  const owners = new Map(
    (
      await c.db`select id,created_by from stock_count_sessions where id in ${c.db(ids)}`
    ).map((/** @type {any} */ r) => [r.id, r.created_by]),
  );
  const names = await namesByUser(c.db, [...owners.values()]);
  const rule = await toleranceRule(c.db, "count_variance", c.now, "A count difference");
  return /** @type {Item[]} */ (
    cards.map((/** @type {any} */ x) => ({
      id: `count_review:${x.id}`,
      ref: x.id,
      kind: "count_review",
      kindLabel: KINDS.count_review,
      title: `${x.location ?? "A place"}: ${x.title ?? "stock count"} is counted and waiting`,
      documentNumber: x.number,
      askedBy: names.get(owners.get(x.id)) ?? null,
      askedAt: x.submittedAt ?? x.createdAt,
      valueCentavos: sums.has(x.id) ? Number(sums.get(x.id).v) : null,
      rule,
      link: `/operations/counts/review?session=${x.id}`,
      canDecide: true,
      blockedReason: null,
      makerChecker: "The person who counted cannot approve their own count. The list only shows counts you did not count.",
      lines: [
        { label: "Lines counted", value: `${x.progress.counted} of ${x.progress.total}` },
        { label: "Lines with a difference to decide", value: String(sums.get(x.id)?.open ?? x.progress.needsReview) },
      ],
      needs: {},
    }))
  );
}

/** Bad-order requests. @param {any} router @param {any} c @param {any} actor */
async function dispositions(router, c, actor) {
  const res = await call(router, c, "GET", "/api/v1/inventory/dispositions", { query: { status: "requested" } });
  const names = await namesByUser(c.db, res.requests.map((/** @type {any} */ d) => d.requestedBy));
  return /** @type {Item[]} */ (
    res.requests.map((/** @type {any} */ d) => {
      const level = d.approvalLevel === "manager";
      const mine = d.requestedBy === actor.userId;
      const roleOk = roleHas(actor.role, level ? "inventory.approve" : "inventory.adjustment.approve");
      return {
        id: `disposition:${d.id}`,
        ref: d.id,
        kind: "disposition",
        kindLabel: KINDS.disposition,
        title: `${d.decisionLabel}: ${d.name}${d.quantity?.display ? ` (${d.quantity.display})` : ""} at ${d.locationName ?? "a place"}`,
        documentNumber: d.number,
        askedBy: names.get(d.requestedBy) ?? null,
        askedAt: d.requestedAt,
        valueCentavos: d.valueCentavos,
        rule:
          d.approvalLimitCentavos != null
            ? level
              ? `Above ${peso(d.approvalLimitCentavos)}: a manager decides.`
              : `Up to ${peso(d.approvalLimitCentavos)}: a supervisor decides.`
            : null,
        link: "/operations/stock/bad-orders",
        canDecide: Boolean(d.canDecide) && !d.needsPhoto,
        blockedReason: d.canDecide
          ? d.needsPhoto
            ? "A photo is needed before this can be approved."
            : null
          : mine
            ? "You asked for this, so someone else must approve it."
            : roleOk
              ? "You cannot decide this one."
              : level
                ? "Above the supervisor limit: a manager must approve."
                : "Your role cannot approve bad orders.",
        makerChecker: MAKER_CHECKER,
        lines: [
          { label: "Why", value: [d.reasonCode, d.note].filter(Boolean).join(": ") || "—" },
          { label: "Photos", value: String(d.photos ?? 0) },
        ],
        needs: {},
      };
    })
  );
}

/** Store counts at close (and forced closes) waiting for a second person, plus van settlement variances. @param {any} c @param {any} actor */
async function cashVariances(c, actor) {
  /** @type {Item[]} */ const out = [];
  const scope = await scopeFilterForActor(c.db, actor);
  const ids = scope.unitIds?.length ? scope.unitIds : ["00000000-0000-0000-0000-000000000000"];
  if (roleHas(actor.role, "van.cash.approve")) {
    const rows = await c.db`select k.id as closure_id,k.kind,k.variance_centavos,k.declared_centavos,k.expected_centavos,k.closed_at,k.force_reason,k.forced_by,
        s.id as shift_id,s.cashier_id,s.doc_number,r.name as register_name,l.name as store_name,p.name as cashier_name,fb.name as forced_by_name,
        (select tolerance_centavos from store_register_policies q where q.register_id=r.id and q.effective_from<=now() and (q.effective_to is null or q.effective_to>now())) as tolerance
      from store_shift_closures k join store_shifts s on s.id=k.shift_id join store_registers r on r.id=s.register_id join inventory_locations l on l.id=r.location_id
        join profiles p on p.id=s.cashier_id left join profiles fb on fb.id=k.forced_by
      where k.needs_review and not exists (select 1 from store_shift_decisions d where d.closure_id=k.id) and l.deleted_at is null
        and (${scope.unitIds === null} or l.org_unit_id in ${c.db(ids)})
      order by k.closed_at,k.id limit 100`;
    for (const k of rows) {
      const forced = k.kind === "forced";
      const mine = k.cashier_id === actor.profileId,
        closedByMe = forced && k.forced_by === actor.profileId;
      out.push({
        id: `cash_variance:${k.closure_id}`,
        ref: k.closure_id,
        kind: "cash_variance",
        kindLabel: forced ? "Forced close" : KINDS.cash_variance,
        title: forced
          ? `${k.store_name} ${k.register_name}: ${k.cashier_name}'s session was closed by the office with no count`
          : `${k.store_name} ${k.register_name}: ${k.cashier_name}'s till is ${Number(k.variance_centavos) < 0 ? "short" : "over"} ${peso(Math.abs(Number(k.variance_centavos)))}`,
        documentNumber: k.doc_number ?? null,
        askedBy: forced ? (k.forced_by_name ?? null) : k.cashier_name,
        askedAt: ms(k.closed_at),
        valueCentavos: forced ? null : Math.abs(Number(k.variance_centavos)),
        rule: forced
          ? `A session closed without a count always needs a second person.${k.force_reason ? ` Reason given: ${k.force_reason}` : ""}`
          : k.tolerance != null
            ? `This register allows a difference up to ${peso(k.tolerance)}. This one is above it.`
            : "This till count is outside the allowed difference.",
        link: "/operations/stores-pos",
        canDecide: !mine && !closedByMe,
        blockedReason: mine
          ? "This is your own till count. A second person must decide it."
          : closedByMe
            ? "You closed this session, so someone else must review it."
            : null,
        makerChecker: forced
          ? "Whoever force-closed this session, and the cashier, cannot review it. The system checks that for you."
          : "The cashier who counted this till cannot decide it. A second person must. The system checks that for you.",
        lines: forced
          ? [{ label: "Count", value: "None was taken: the office closed the session" }]
          : [
              { label: "Expected in the drawer", value: peso(k.expected_centavos) },
              { label: "Counted", value: peso(k.declared_centavos) },
            ],
        needs: {},
        extra: { forced },
      });
    }
  }
  if (roleHas(actor.role, "van.stock.approve")) {
    const rows = await c.db`select vc.id,vc.level,vc.variance_centavos,vc.tolerance_basis_points,vc.due_at,vc.sales_centavos,t.id as trip_id,t.trip_number,t.salesperson_profile_id,
        coalesce(v.name,v.vehicle_code) as truck,p.name as seller_name,st.created_at
      from van_variance_cases vc join van_settlements st on st.id=vc.settlement_id join van_trips t on t.id=st.trip_id join profiles p on p.id=t.salesperson_profile_id
        join vehicles v on v.id=t.vehicle_id
      where vc.level<>'disposed' and t.deleted_at is null and (${scope.unitIds === null} or t.org_unit_id in ${c.db(ids)})
      order by vc.due_at limit 100`;
    for (const k of rows)
      out.push({
        id: `cash_variance:${k.id}`,
        ref: k.id,
        kind: "cash_variance",
        kindLabel: KINDS.cash_variance,
        title: `${k.truck}: ${k.seller_name}'s trip settled with a cash and stock difference`,
        documentNumber: k.trip_number,
        askedBy: k.seller_name,
        askedAt: ms(k.created_at),
        valueCentavos: k.variance_centavos == null ? null : Math.abs(Number(k.variance_centavos)),
        rule: `Allowed: ${(k.tolerance_basis_points / 100).toFixed(2)}% of sales. Above it the supervisor sends it to the area manager, who records the final answer.`,
        link: `/van-trips?tripId=${k.trip_id}`,
        canDecide: false,
        blockedReason: null,
        openOnly: true,
        makerChecker: "A different supervisor than the one who settled the trip decides. This one is decided inside the trip, with its evidence.",
        lines: [{ label: "Sales on the trip", value: peso(k.sales_centavos) }],
        needs: {},
      });
  }
  return out;
}

/** Void, refund, price and discount overrides approved at the till, not yet looked at by a second supervisor. @param {any} c @param {any} actor */
async function overrides(c, actor) {
  if (!roleHas(actor.role, "van.cash.approve")) return [];
  const scope = await scopeFilterForActor(c.db, actor);
  const ids = scope.unitIds?.length ? scope.unitIds : ["00000000-0000-0000-0000-000000000000"];
  const rows = await c.db`select o.id,o.kind,o.amount_centavos,o.reason,o.captured_at,o.supervisor_profile_id,o.cashier_profile_id,r.name as register_name,l.name as store_name,
      sp.name as supervisor_name,cp.name as cashier_name,o.ref_id
    from store_overrides o join store_registers r on r.id=o.register_id join inventory_locations l on l.id=r.location_id
      join profiles sp on sp.id=o.supervisor_profile_id left join profiles cp on cp.id=o.cashier_profile_id
    where o.kind in ${c.db(OVERRIDE_KINDS)} and o.captured_at>now()-${OVERRIDE_DAYS}*interval '1 day' and l.deleted_at is null
      and not exists (select 1 from decide_log g where g.kind='override_review' and g.ref_id=o.id::text)
      and (${scope.unitIds === null} or l.org_unit_id in ${c.db(ids)})
    order by o.captured_at limit 100`;
  return /** @type {Item[]} */ (
    rows.map((/** @type {any} */ o) => {
      const involved = [o.supervisor_profile_id, o.cashier_profile_id].includes(actor.profileId);
      return {
        id: `override_review:${o.id}`,
        ref: o.id,
        kind: "override_review",
        kindLabel: KINDS.override_review,
        title: `${o.store_name} ${o.register_name}: ${OVERRIDE_WORDS[o.kind] ?? o.kind} approved by ${o.supervisor_name}${o.cashier_name ? ` for ${o.cashier_name}` : ""}`,
        documentNumber: null,
        askedBy: o.cashier_name ?? null,
        askedAt: ms(o.captured_at),
        valueCentavos: o.amount_centavos == null ? null : Number(o.amount_centavos),
        rule: "A void, refund, price change or discount approved at the till gets a second look from someone who was not there.",
        makerChecker: "The supervisor who approved it at the till, and the cashier, cannot review it. The system checks that for you.",
        link: "/operations/stores-pos/overrides",
        canDecide: !involved,
        blockedReason: involved ? "You approved this at the till or were the cashier. Someone else must look at it." : null,
        lines: o.reason ? [{ label: "Reason given", value: o.reason }] : [],
        needs: {},
      };
    })
  );
}

/** @param {any} router @param {any} c @param {any} actor */
export async function gather(router, c, actor) {
  /** @type {Item[]} */ const items = [];
  /** @type {Array<{kind:string,message:string}>} */ const warnings = [];
  /** @param {string} name @param {()=>Promise<Item[]>} fn */
  const take = async (name, fn) => {
    try {
      items.push(...(await fn()));
    } catch (e) {
      warnings.push({
        kind: name,
        message: e instanceof ApiError && e.status < 500 ? e.message : "This list could not be read just now.",
      });
    }
  };
  await take("load_difference", () => loadDifferences(router, c, actor));
  await take("transfer_variance", () => transferDifferences(router, c, actor));
  await take("count_review", () => countReviews(router, c, actor));
  await take("disposition", () => dispositions(router, c, actor));
  await take("cash_variance", () => cashVariances(c, actor));
  await take("override_review", () => overrides(c, actor));
  items.sort(
    (a, b) =>
      Number(Boolean(a.sentBack)) - Number(Boolean(b.sentBack)) ||
      (a.askedAt ?? Infinity) - (b.askedAt ?? Infinity),
  );
  return { items, warnings };
}

// ------------------------------------------------------------------------ the decision

const REASON_MIN = 3;
/** @param {any} v */
const words = (v) => (typeof v === "string" ? v.trim().slice(0, 300) : "");

/**
 * POST decide/act {id, verdict: approve|reject, reason, idempotencyKey, chargeTo?, reasonCode?}
 * @param {any} router @param {any} c
 */
async function act(router, c) {
  const actor = await requireCapability(c, "inventory.read");
  const b = c.body;
  if (!b || typeof b !== "object" || Array.isArray(b))
    throw new ApiError("invalid_request", 400, "Send the decision as an object");
  const key = b.idempotencyKey;
  if (!isUuid(key))
    throw new ApiError("invalid_request", 400, "Send an idempotency key so a double tap decides once");
  const verdict = b.verdict;
  if (verdict !== "approve" && verdict !== "reject")
    throw new ApiError("invalid_request", 422, "Choose Approve or Reject");
  const reason = words(b.reason);
  if (verdict === "reject" && reason.length < REASON_MIN)
    throw new ApiError("invalid_request", 422, "Say why you are rejecting this, in a few words");
  const [kind, ...rest] = String(b.id ?? "").split(":");
  const ref = rest.join(":");
  if (!(kind in KINDS) || !ref)
    throw new ApiError("invalid_request", 422, "That is not an item in the inbox");

  const { items } = await gather(router, c, actor);
  const item = items.find((i) => i.id === b.id);
  if (!item)
    throw new ApiError("not_found", 404, "That item is no longer waiting. Someone may have decided it already.");
  if (item.openOnly)
    throw new ApiError("invalid_request", 422, "This one is decided inside its own page. Use Open.");
  if (!item.canDecide)
    throw new ApiError("forbidden", 403, item.blockedReason ?? "You cannot decide this one.");

  const note = reason || (verdict === "approve" ? "Approved in Decide" : "");
  /** @type {any} */ let result = null;
  switch (item.kind) {
    case "load_difference":
      result = await call(router, c, "POST", "/api/v1/van/loads/approve", {
        body: {
          tripId: item.ref,
          decision: verdict === "approve" ? "approve" : "reject",
          note,
          basis: b.basis === "clerk" ? "clerk" : "seller",
          chargeTo: b.chargeTo,
          idempotencyKey: key,
        },
      });
      break;
    case "transfer_variance":
    case "reload_difference":
    case "load_in_difference":
      if (verdict === "approve") {
        if (!["dispatch_side", "receive_side", "carrier", "driver"].includes(b.chargeTo))
          throw new ApiError(
            "invalid_request",
            422,
            "Say who carries the difference: sending side, receiving side, carrier or driver",
          );
        result = await call(router, c, "POST", "/api/v1/inventory/transfers/resolve-variance", {
          body: {
            transferId: item.ref,
            chargeTo: b.chargeTo,
            shortReasonCode: typeof b.reasonCode === "string" && b.reasonCode ? b.reasonCode : "SHORT-TRANSIT",
            overReasonCode: typeof b.reasonCode === "string" && b.reasonCode ? b.reasonCode : "FOUND",
            note,
            idempotencyKey: key,
          },
        });
      }
      else
        // IP-INT3: rejecting sends the document back to the receiving side to count again (the history keeps the reason);
        // it leaves this inbox until the receiver's new count brings it back with its own difference, if any.
        result = await call(router, c, "POST", "/api/v1/inventory/transfers/recount", {
          body: { transferId: item.ref, reason: note, idempotencyKey: key },
        });
      break;
    case "count_review":
      if (verdict === "approve") {
        result = await call(router, c, "POST", "/api/v1/inventory/counts/approve", {
          body: { sessionId: item.ref, acceptRemaining: true, idempotencyKey: key },
        });
      } else {
        const lines = await c.db`select id from stock_count_lines where session_id=${item.ref} and counted_base is not null
          order by (review_decision is null) desc,abs(coalesce(diff_centavos,0)) desc limit 500`;
        if (!lines.length) throw new ApiError("invalid_request", 422, "There is nothing counted to recount");
        result = await call(router, c, "POST", "/api/v1/inventory/counts/request-recount", {
          body: { sessionId: item.ref, lineIds: lines.map((/** @type {any} */ l) => l.id), note, idempotencyKey: key },
        });
      }
      break;
    case "disposition":
      result = await call(router, c, "POST", "/api/v1/inventory/dispositions/decide", {
        body: { dispositionId: item.ref, verdict, note, idempotencyKey: key },
      });
      break;
    case "cash_variance":
      result = await call(router, c, "POST", "/api/v1/storepos/shifts/decide", {
        body: {
          closureId: item.ref,
          decision: verdict === "approve" ? "accepted" : "investigate",
          reason: note,
          requestKey: key,
        },
      });
      break;
    case "override_review":
      break; // recorded below; there is no document verb for a second look
  }

  const logKind =
    item.kind === "transfer_variance" || item.kind === "reload_difference" || item.kind === "load_in_difference"
      ? verdict === "reject"
        ? "transfer_send_back"
        : "transfer_resolved"
      : item.kind;
  await tx(c.db, async (db) => {
    await db`insert into decide_log (kind,ref_id,verdict,reason,rule,document_number,value_centavos,actor_user_id,actor_profile_id,idempotency_key)
      values (${logKind === "override_review" ? "override_review" : logKind},${item.ref},${verdict === "approve" ? "approved" : "rejected"},${note || "Rejected"},${item.rule},${item.documentNumber},${item.valueCentavos},${actor.userId},${actor.profileId},${key})
      on conflict (kind,ref_id,idempotency_key) do nothing`;
  });
  await c.publish("inventory");
  return {
    id: item.id,
    verdict,
    status:
      item.kind === "transfer_variance" || item.kind === "reload_difference" || item.kind === "load_in_difference"
        ? verdict === "approve"
          ? "Difference written off and closed."
          : "Sent back for a recount."
        : verdict === "approve"
          ? "Approved."
          : "Rejected.",
    result: result ?? null,
  };
}

/** @param {any} router @param {any} c */
async function inbox(router, c) {
  const actor = await requireCapability(c, "inventory.read");
  const { items, warnings } = await gather(router, c, actor);
  /** @type {Record<string, number>} */ const counts = {};
  for (const i of items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
  const recent = await c.db`select g.kind,g.ref_id,g.verdict,g.reason,g.document_number,g.value_centavos,g.created_at,p.name as who
    from decide_log g join profiles p on p.id=g.actor_profile_id order by g.created_at desc limit 15`;
  return {
    asOf: c.now,
    total: items.length,
    counts,
    kinds: KINDS,
    items,
    warnings,
    recent: recent.map((/** @type {any} */ r) => ({
      kind: r.kind,
      refId: r.ref_id,
      verdict: r.verdict,
      reason: r.reason,
      documentNumber: r.document_number,
      valueCentavos: r.value_centavos == null ? null : Number(r.value_centavos),
      at: new Date(r.created_at).getTime(),
      by: r.who,
    })),
  };
}

/** @param {import('../../core/router.js').Router} router @param {any} _core */
export function install(router, _core) {
  router.get("/api/v1/decide/inbox", (c) => inbox(router, c));
  router.post("/api/v1/decide/act", (c) => act(router, c));
  // The web count screen's photo picker (a browser cannot make the phone's device-proved claim).
  router.post("/api/v1/inventory/counts/photo", uploadCountPhoto, { raw: true });
}
