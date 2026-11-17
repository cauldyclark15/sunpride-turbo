import { requireCapability } from "./capabilities.js";
import { ApiError, invalid } from "./errors.js";
import { isPlainObject, isUuid } from "./util.js";
import { scopeFilterForActor } from "../domains/org/scope.js";

/**
 * SP-0188 "Phone saves for the office": every phone save the server had to refuse is kept in
 * `op_refusals` (see keepRefusal in sync.js). Admins list them in plain words and mark them Done.
 * Capability: `admin.manage`, the same one admins use for People and Setup.
 */

/** Plain words for every phone op type (exact names first, then by family). */
const OP_NAMES = /** @type {Record<string,string>} */ ({
  "census.capture": "New customer",
  "visit.checkIn": "Start visit",
  "visit.checkOut": "End visit",
  "visit.activity": "Visit task",
  "dsr.visit.checkIn": "Start visit",
  "dsr.visit.checkOut": "End visit",
  "dsr.visit.activity": "Visit task",
  "availability.record": "Shelf check",
  "dsr.availability.record": "Shelf check",
  "availability.proposal": "Shelf check change",
  "collections.capture": "Collection",
  "jointcall.capture": "Work-With",
  "workforce.clockIn": "Clock in",
  "workforce.clockOut": "Clock out",
  "workforce.prospect": "Prospect",
  "outlet.census": "Store change",
  "outlet.change": "Store change",
  "order.intent": "Order",
  "order_intent": "Order",
  "sale.record": "Sale",
  "sale.void": "Cancelled sale",
  "return.record": "Return",
  "refund.record": "Refund",
  "payment.record": "Payment",
  "cash.reconcile": "Cash count",
  "stock.reconcile": "Stock count",
  "trip.start": "Start trip",
  "trip.close": "Close trip",
  "load.confirm": "Truck load",
  "load.accept": "Truck load",
  "reload.receive": "Truck reload",
  "crew.switch": "Crew change",
  "truck.damage": "Damaged stock",
  "delivery.confirm": "Delivery",
  "delivery.timing": "Delivery time",
  "call.start": "Start call",
  "call.step": "Call step",
  "call.close": "End call",
  "retail.capture": "Store check",
  "fiscal.print": "Receipt",
  "location.record": "Location",
  "integrity.checkInRefused": "Start visit",
  "store.shift.open": "Open shift",
  "store.shift.close": "Close shift",
  "store.shift.suspend": "Pause shift",
  "store.shift.resume": "Resume shift",
});

/** @param {string|null|undefined} opType */
export function opName(opType) {
  if (!opType) return "Saved work";
  const exact = OP_NAMES[opType];
  if (exact) return exact;
  if (/^(store|storepos)\./.test(opType)) return "Store sale";
  if (/^(sale|van|route)\./.test(opType)) return "Sale";
  if (/^(order|presell)\./.test(opType)) return "Order";
  if (/^(visit|dsr)\./.test(opType)) return "Visit";
  if (/collection/.test(opType)) return "Collection";
  return "Saved work";
}

/** Office wording of the phone's refusal reasons (Android SyncStatus.REASONS, adapted). */
const WHY = /** @type {Record<string,string>} */ ({
  invalid_request: "Some details could not be read",
  invalid_plan: "The visit was changed or closed in the office first",
  out_of_scope: "This store or work is not assigned to this salesman",
  dependency_missing: "An earlier step (for example the visit start) was not saved",
  invalid_transition: "The visit was already ended or changed",
  call_open: "Another call was still open",
  mcp_order: "Stores were visited out of plan order",
  wrong_date: "The phone's date did not match the visit date",
  idempotency_conflict: "A different save was already recorded under the same entry",
  evidence_pending_review: "A visit photo was still waiting for a check",
  unsupported_operation: "The phone's app version cannot send this",
  load_not_posted: "The truck load was not posted yet",
  stock_conflict: "Stock had changed in the office",
  mock_location_refused: "The phone's location looked faked",
  place_mismatch: "The salesman was not at the store's location",
  places_unavailable: "The store's location could not be checked",
  work_with_incomplete: "The joint call was missing a required part",
});

/** @param {string|null|undefined} code */
export function whyText(code) {
  return (code && WHY[code]) || "It could not be saved as sent";
}

/** @param {any} v */
const json = (v) => (typeof v === "string" ? JSON.parse(v) : v);

/** @param {any} r */
function row(r) {
  return {
    id: r.id,
    createdAt: new Date(r.created_at).getTime(),
    salesman: r.salesman ?? "Unknown person",
    app: r.app === "van-sales-android" ? "Van app" : r.app === "field-android" ? "Field app" : r.app,
    what: opName(r.op_type),
    why: whyText(r.code),
    code: r.code,
    opType: r.op_type,
    resolvedAt: r.resolved_at ? new Date(r.resolved_at).getTime() : null,
    resolvedBy: r.resolved_by_name ?? r.resolved_by ?? null,
    note: r.note ?? null,
  };
}

/** @param {import('./context.js').Ctx} ctx */
async function scoped(ctx) {
  const actor = await requireCapability(ctx, "admin.manage");
  const { unitIds } = await scopeFilterForActor(ctx.db, actor);
  return { actor, unitIds };
}

/** @param {import('./context.js').Ctx} ctx @param {string[]|null} unitIds @param {string|null} id @param {boolean} open */
async function select(ctx, unitIds, id, open) {
  const nationwide = unitIds === null;
  return await ctx.db`
    select r.*, p.name as salesman, rp.name as resolved_by_name
    from op_refusals r
    left join profiles p on p.id = r.profile_id
    left join profiles rp on rp.user_id::text = r.resolved_by or rp.auth_subject = r.resolved_by
    where (${id}::uuid is null or r.id = ${id}::uuid)
      and (${!open} or r.resolved_at is null)
      -- Location pings are kept but never need the office; they would flood the list.
      and (r.op_type is null or r.op_type not like 'location.%')
      and (${nationwide} or p.org_unit_id::text = any(${ctx.db.array(unitIds ?? [], "TEXT")}))
    order by r.created_at desc
    limit 200`;
}

/** @param {import('./router.js').Router} router */
export function installOpRefusals(router) {
  router.get("/api/v1/phone-saves", async (ctx) => {
    const { unitIds } = await scoped(ctx);
    const show = ctx.url.searchParams.get("show") ?? "open";
    const rows = await select(ctx, unitIds, null, show !== "all");
    return { rows: rows.map(row) };
  });
  router.get("/api/v1/phone-saves/:id", async (ctx) => {
    const { unitIds } = await scoped(ctx);
    const id = ctx.params.id;
    if (!isUuid(id)) throw invalid("Unknown phone save");
    const [r] = await select(ctx, unitIds, id, false);
    if (!r) throw new ApiError("not_found", 404, "Phone save not found.");
    const op = json(r.payload);
    return {
      ...row(r),
      values: isPlainObject(op) && isPlainObject(op.payload) ? op.payload : {},
      sent: op,
    };
  });
  router.post("/api/v1/phone-saves/:id/done", async (ctx) => {
    const { actor, unitIds } = await scoped(ctx);
    const id = ctx.params.id;
    if (!isUuid(id)) throw invalid("Unknown phone save");
    const [r] = await select(ctx, unitIds, id, false);
    if (!r) throw new ApiError("not_found", 404, "Phone save not found.");
    const body = isPlainObject(ctx.body) ? ctx.body : {};
    const note =
      typeof body.note === "string" && body.note.trim()
        ? body.note.trim().slice(0, 500)
        : null;
    const by = actor.userId ?? actor.subject;
    await ctx.db`update op_refusals set resolved_at = coalesce(resolved_at, now()),
      resolved_by = coalesce(resolved_by, ${by}), note = coalesce(${note}, note) where id = ${id}`;
    await ctx.db`insert into audit_logs(subject,action,entity_type,entity_id,details)
      values(${by},'SP-0188.phone_save.done','op_refusal',${id},${JSON.stringify({ note })})`;
    const [done] = await select(ctx, unitIds, id, false);
    return row(done);
  });
}
