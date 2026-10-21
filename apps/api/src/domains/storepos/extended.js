import { tx } from "@sunpride/db/client";
import { ApiError } from "../../core/errors.js";
import { OpRejected, OP_CODES } from "../../core/sync.js";
import { hooks, setHooks } from "../../core/hooks.js";
import { requireCapability, roleHas } from "../../core/capabilities.js";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { currentActor, currentDeviceActor } from "../van/access.js";
import { scopeFilterForActor, outletOwnerUnit } from "../org/scope.js";
import { uuid, integer, refuse, text, choice, today } from "../van/model.js";
import { registerFor, modeAt } from "./model.js";
import { STORE_OPS, storeOperation, decideReversal } from "./operations.js";
import { phone } from "./commercial.js";
import { date as realDate } from "../orders/validation.js";
import { verifyPin } from "./security.js";
import { commands as inventory } from "../inventory/commands.js";
import { enqueueRefresh } from "../analytics/refresh.js";

/** F-R01..R08 store extension, not another router/auth/sync engine. @param {any} router @param {any} platform */
export function installExtended(router, platform) {
  const previous = hooks.canClaimMedia;
  setHooks({
    canClaimMedia: async (
      /** @type {any} */ db,
      /** @type {any} */ actor,
      /** @type {any} */ claim,
    ) => {
      if (claim.purpose !== "bank-deposit") return previous(db, actor, claim);
      try {
        const fresh = await currentDeviceActor(db, actor, claim.deviceId);
        await registerFor(db, fresh.actor, uuid(claim.ownerId), "van.operate");
        return true;
      } catch {
        return false;
      }
    },
  });
  for (const kind of STORE_OPS)
    platform.registerOp(kind, async (/** @type {any} */ c) => {
      try {
        const result = await storeOperation(c);
        if (kind === "store.sale")
          await suggestForRegister(
            c.db,
            c.actor,
            await registerFor(c.db, c.actor, c.payload.registerId),
          );
        await c.enqueue({
          kind: "analytics.refresh",
          key: today(),
          payload: { date: today() },
        });
        await c.change(
          "storepos",
          result.entityId,
          `unit:${c.actor.orgUnitId}`,
        );
        c.publish("storepos");
        c.publish("orders");
        c.publish("analytics");
        return result;
      } catch (e) {
        if (e instanceof ApiError)
          throw new OpRejected(
            e.status === 403
              ? "out_of_scope"
              : OP_CODES.includes(e.code)
                ? e.code
                : e.code === "stale_snapshot"
                  ? "stock_conflict"
                  : "invalid_request",
          );
        throw e;
      }
    });
  router.get("/api/v1/storepos/report", report);
  router.get("/api/v1/storepos/operations", office);
  router.get(
    "/api/v1/storepos/customers/lookup",
    async (/** @type {any} */ c) => {
      const actor = await currentActor(c.db, c.actor);
      await requireCapability({ ...c, actor }, "van.operate");
      const [row] =
        await c.db`select c.id,c.name,c.phone,coalesce((select sum(p.delta) from store_points p where p.customer_id=c.id),0)::text as points from store_customers c where phone=${phone(c.url.searchParams.get("phone"))}`;
      return { customer: row ?? null };
    },
  );
  router.post("/api/v1/storepos/mode/switch", switchMode);
  const specs = {
    "registers/link": { cap: "admin.manage", work: link },
    "reversals/decide": { cap: "van.cash.approve", work: decideReversal },
    "reorder/save": { cap: "admin.manage", work: reorder },
    "reorder/suggest": {
      cap: "admin.manage",
      work: async (
        /** @type {any} */ db,
        /** @type {any} */ actor,
        /** @type {any} */ p,
      ) => ({
        id: await suggestForRegister(
          db,
          actor,
          await registerFor(db, actor, p.registerId, "admin.manage"),
        ),
      }),
    },
    "replenishments/prepare": { cap: "inventory.write", work: prepareTransfer },
    "replenishments/decide": { cap: "inventory.approve", work: decideTransfer },
    "deposits/decide": { cap: "van.cash.approve", work: decideDeposit },
    "targets/save": { cap: "admin.manage", work: target },
  };
  for (const [path, spec] of Object.entries(specs))
    router.post(`/api/v1/storepos/${path}`, async (/** @type {any} */ c) => {
      const p = c.body;
      if (!p || typeof p !== "object" || Array.isArray(p))
        refuse("Supply a command object");
      const result = await tx(c.db, async (/** @type {any} */ db) => {
        const actor = await currentActor(db, c.actor);
        await requireCapability({ db, actor }, spec.cap);
        await registerFor(db, actor, uuid(p.registerId), spec.cap);
        await db`select set_config('sunpride.actor',${actor.userId},true)`;
        const key = uuid(p.requestKey),
          hash = sha256Hex(canonicalJson({ path, p }));
        await db`select pg_advisory_xact_lock(hashtext(${actor.profileId + key}))`;
        const [prior] =
          await db`select * from store_pos_commands where actor_profile_id=${actor.profileId} and request_key=${key}`;
        if (prior) {
          if (prior.payload_hash !== hash)
            refuse("Request key has changed content", "idempotency_conflict");
          return prior.response;
        }
        const value = await spec.work(db, actor, p);
        await db`insert into store_pos_commands(actor_profile_id,request_key,payload_hash,response) values(${actor.profileId},${key},${hash},${value})`;
        return value;
      });
      c.publish("storepos");
      c.publish("inventory");
      c.publish("orders");
      c.publish("analytics");
      await enqueueRefresh(c, {
        kind: "order",
        date: today(),
        unitId: c.actor.orgUnitId,
      });
      return result;
    });
}
/** F-R01 local switch is online, requires office allowance and never switches over unsynced/open work.
 * @param {any} c */
async function switchMode(c) {
  const p = c.body;
  const fresh = await currentDeviceActor(c.db, c.actor, uuid(p.deviceId));
  const [reserved] =
    await c.db`insert into store_pin_attempts(device_id,next_attempt_at) values(${fresh.device.id},now()+interval '30 seconds') on conflict(device_id) do update set next_attempt_at=excluded.next_attempt_at where store_pin_attempts.next_attempt_at<=now() returning device_id`;
  if (!reserved)
    throw new ApiError(
      "rate_limited",
      429,
      "Wait 30 seconds before another PIN attempt",
    );
  return tx(c.db, async (/** @type {any} */ db) => {
    const { actor, device } = await currentDeviceActor(
      db,
      c.actor,
      fresh.device.id,
    );
    const mode = await modeAt(db, device.id);
    if (!mode?.allow_local_switch || !mode.register_id)
      refuse("The office has not allowed local mode switching");
    const r = await registerFor(db, actor, mode.register_id, "van.operate");
    const [policy] =
      await db`select * from store_register_policies where register_id=${r.id} and effective_from<=now() and (effective_to is null or effective_to>now())`;
    verifyPin(policy, p.pin);
    const next = choice(p.mode, ["van", "store"]);
    const [open] =
      await db`select 1 from store_shifts s left join store_shift_closures c on c.shift_id=s.id where s.device_id=${device.id} and c.id is null`;
    const [trip] =
      await db`select 1 from van_trips where started_device_id=${device.id} and status not in ('closed','cancelled') and deleted_at is null`;
    if (open || trip)
      refuse("Close the session or settle the van trip before changing mode");
    const [stamp] = await db`select clock_timestamp() as at`;
    await db`update pos_device_modes set effective_to=${stamp.at} where id=${mode.id}`;
    const [row] =
      await db`insert into pos_device_modes(device_id,register_id,mode,effective_from,actor_profile_id,allow_local_switch) values(${device.id},${r.id},${next},${stamp.at},${actor.profileId},true) returning id`;
    c.publish("van");
    c.publish("storepos");
    return { id: row.id };
  });
}
/** F-R03 store outlet ownership must match the physical register. @param {any} db @param {any} actor @param {any} p */
async function link(db, actor, p) {
  const r = await registerFor(db, actor, p.registerId, "admin.manage");
  const owner = await outletOwnerUnit(db, uuid(p.outletId), Date.now());
  if (owner !== r.org_unit_id)
    refuse("Choose a commercial store in the same area");
  const [open] =
    await db`select 1 from store_shifts s left join store_shift_closures c on c.shift_id=s.id where s.register_id=${r.id} and c.id is null`;
  if (open)
    refuse("Close the cashier session before changing its commercial store");
  await db`update store_registers set outlet_id=${p.outletId} where id=${r.id}`;
  return { id: r.id };
}
/** F-R05 effective-dated reorder point, canonical source and transfer approval. @param {any} db @param {any} actor @param {any} p */
async function reorder(db, actor, p) {
  const r = await registerFor(db, actor, p.registerId, "admin.manage");
  const [source] =
    await db`select * from inventory_locations where id=${uuid(p.sourceLocationId)} and active and allows_picking and deleted_at is null`;
  if (!source || source.id === r.location_id)
    refuse("Choose an active source warehouse or van");
  await requireCapability({ db, actor }, "inventory.read", source.org_unit_id);
  const [product] =
    await db`select id from products where id=${uuid(p.productId)} and active and deleted_at is null`;
  if (!product) refuse("Choose an active product");
  const min = integer(p.minimumBase),
    max = integer(p.targetBase, true);
  if (max <= min) refuse("Target stock must exceed the reorder point");
  const from = p.effectiveFrom ? new Date(p.effectiveFrom) : new Date();
  if (!Number.isFinite(+from) || +from < Date.now() - 1000)
    refuse("Use a current or future effective date");
  const [future] =
    await db`select id from store_reorder_points where register_id=${r.id} and product_id=${product.id} and effective_from>=${from}`;
  if (future)
    refuse("A reorder change is already scheduled; review that rule first");
  await db`update store_reorder_points set effective_to=${from} where register_id=${r.id} and product_id=${product.id} and effective_from<${from} and (effective_to is null or effective_to>${from})`;
  const [row] =
    await db`insert into store_reorder_points(register_id,product_id,source_location_id,minimum_base,target_base,effective_from) values(${r.id},${product.id},${source.id},${String(min)},${String(max)},${from}) returning id`;
  return { id: row.id };
}
/** F-R05 idempotent suggestions are not stock or approved transfers. @param {any} db @param {any} actor @param {any} r */
export async function suggestForRegister(db, actor, r) {
  const rules =
    await db`select p.*,coalesce(b.available_base,0) as available from store_reorder_points p left join inventory_balances b on b.product_id=p.product_id and b.location_id=${r.location_id} and b.deleted_at is null where p.register_id=${r.id} and p.effective_from<=now() and (p.effective_to is null or p.effective_to>now()) and coalesce(b.available_base,0)<p.minimum_base`;
  for (const rule of rules)
    await db`insert into store_replenishments(rule_id,quantity_base,requested_by) values(${rule.id},${String(BigInt(rule.target_base) - BigInt(rule.available))},${actor.profileId}) on conflict(rule_id) where status='pending' do nothing`;
  return r.id;
}
/** @param {any} db @param {any} actor @param {any} p */
async function prepareTransfer(db, actor, p) {
  const [s] =
    await db`select s.*,r.source_location_id,r.product_id from store_replenishments s join store_reorder_points r on r.id=s.rule_id where s.id=${uuid(p.id)} and r.register_id=${p.registerId} and s.status='pending' for update of s`;
  if (!s || s.transfer_id)
    refuse("Choose an unprepared replenishment suggestion");
  const r = await registerFor(db, actor, p.registerId, "inventory.write");
  const body = {
    idempotencyKey: p.requestKey,
    sourceLocationId: s.source_location_id,
    destinationLocationId: r.location_id,
    inTransitLocationId: uuid(p.inTransitLocationId),
    lines: [{ productId: s.product_id, quantityBase: Number(s.quantity_base) }],
    note: "Store reorder suggestion; approval required",
  };
  const ctx = { db, actor, now: Date.now() };
  await inventory["transfers/request"].prepare(ctx, body);
  const result = await inventory["transfers/request"].run(ctx, body, null);
  await db`update store_replenishments set transfer_id=${result.id} where id=${s.id}`;
  return { id: s.id };
}
/** @param {any} db @param {any} actor @param {any} p */
async function decideTransfer(db, actor, p) {
  const [s] =
    await db`select s.* from store_replenishments s join store_reorder_points r on r.id=s.rule_id where s.id=${uuid(p.id)} and r.register_id=${p.registerId} and s.status='pending' for update of s`;
  if (!s || s.requested_by === actor.profileId)
    refuse("A second person must decide this suggestion");
  const decision = choice(p.decision, ["approved", "rejected"]);
  if (decision === "approved") {
    if (!s.transfer_id)
      refuse("Prepare the canonical warehouse transfer first");
    const [line] =
      await db`select id from stock_transfer_lines where transfer_id=${s.transfer_id}`;
    const body = {
      idempotencyKey: p.requestKey,
      transferId: s.transfer_id,
      lines: [{ lineId: line.id, approvedBase: Number(s.quantity_base) }],
    };
    const ctx = { db, actor, now: Date.now() };
    const row = await inventory["transfers/approve"].prepare(ctx, body);
    await inventory["transfers/approve"].run(ctx, body, row);
  }
  await db`update store_replenishments set status=${decision},decided_by=${actor.profileId} where id=${s.id}`;
  return { id: s.id };
}
/** @param {any} db @param {any} actor @param {any} p */
async function decideDeposit(db, actor, p) {
  const [d] =
    await db`select * from store_deposits where id=${uuid(p.id)} and register_id=${p.registerId} for update`;
  if (!d || d.status !== "needs_review" || d.requested_by === actor.profileId)
    refuse("A second person must review a deposit discrepancy");
  await db`update store_deposits set status=${choice(p.decision, ["accepted", "investigate"])},decided_by=${actor.profileId},decision_note=${text(p.reason, 300, true)} where id=${d.id}`;
  return { id: d.id };
}
/** @param {any} db @param {any} actor @param {any} p */
async function target(db, actor, p) {
  const from = realDate(p.from),
    to = realDate(p.to),
    amount = String(integer(p.amountCentavos));
  if (to < from) refuse("Choose a valid target date range");
  const existing =
    await db`select id,from_date::text,to_date::text,amount_centavos::text from store_daily_targets where register_id=${p.registerId} and from_date<=${to} and to_date>=${from} for update`;
  for (const old of existing) {
    await db`delete from store_daily_targets where id=${old.id}`;
    if (old.from_date < from)
      await db`insert into store_daily_targets(register_id,from_date,to_date,amount_centavos) values(${p.registerId},${old.from_date},${from}::date-1,${old.amount_centavos})`;
    if (old.to_date > to)
      await db`insert into store_daily_targets(register_id,from_date,to_date,amount_centavos) values(${p.registerId},${to}::date+1,${old.to_date},${old.amount_centavos})`;
  }
  const [row] =
    await db`insert into store_daily_targets(register_id,from_date,to_date,amount_centavos) values(${p.registerId},${from},${to},${amount}) returning id`;
  return { id: row.id };
}
/** F-R02/R03/R05/R06 office queues, authorized before every read. @param {any} c */
async function office(c) {
  const actor = await currentActor(c.db, c.actor);
  const r = await registerFor(
    c.db,
    actor,
    uuid(c.url.searchParams.get("registerId")),
  );
  const { db } = c;
  const reversals =
    await db`select v.id,v.kind,v.reason,v.status,s.receipt_number as number,h.cashier_id from store_reversals v join store_sales s on s.id=v.sale_id join store_shifts h on h.id=v.shift_id where h.register_id=${r.id} order by v.created_at desc limit 100`;
  const deposits =
    await db`select id,bank,reference,amount_centavos::text as amount,status,requested_by,expected_centavos::text as expected,discrepancy_centavos::text as difference from store_deposits where register_id=${r.id} order by created_at desc limit 100`;
  const replenishments =
    await db`select s.id,s.status,s.transfer_id,s.requested_by,p.name,s.quantity_base::text as quantity from store_replenishments s join store_reorder_points r on r.id=s.rule_id join products p on p.id=r.product_id where r.register_id=${r.id} order by s.created_at desc limit 100`;
  const reads =
    await db`select id,kind,sequence::text,snapshot from store_reads where register_id=${r.id} order by captured_at desc limit 100`;
  const scope = await scopeFilterForActor(db, actor);
  const ids = scope.unitIds ?? [];
  const locations =
    await db`select id,name,type from inventory_locations where active and deleted_at is null and (${scope.unitIds === null} or org_unit_id in ${db(ids.length ? ids : ["00000000-0000-0000-0000-000000000000"])}) order by name limit 501`;
  const products =
    await db`select id,name,code from products where active and deleted_at is null order by name limit 501`;
  const outlets =
    await db`select o.id,o.name from outlets o where o.status='active' and o.deleted_at is null and o.custodian_org_unit_id=${r.org_unit_id} order by name limit 501`;
  return {
    register: {
      id: r.id,
      name: r.name,
      store: r.store_name,
      outletId: r.outlet_id,
    },
    reversals: reversals.map((/** @type {any} */ v) => ({
      ...v,
      canDecide:
        roleHas(actor.role, "van.cash.approve") &&
        v.cashier_id !== actor.profileId,
    })),
    deposits: deposits.map((/** @type {any} */ d) => ({
      ...d,
      expected:
        roleHas(actor.role, "van.cash.approve") &&
        d.requested_by !== actor.profileId
          ? d.expected
          : null,
      difference:
        roleHas(actor.role, "van.cash.approve") &&
        d.requested_by !== actor.profileId
          ? d.difference
          : null,
      canDecide:
        roleHas(actor.role, "van.cash.approve") &&
        d.requested_by !== actor.profileId,
    })),
    replenishments: replenishments.map((/** @type {any} */ v) => ({
      ...v,
      canDecide: v.requested_by !== actor.profileId,
    })),
    reads,
    locations,
    products,
    outlets,
    canManage: roleHas(actor.role, "admin.manage"),
    canPrepare: roleHas(actor.role, "inventory.write"),
    canApprove: roleHas(actor.role, "inventory.approve"),
  };
}
/** F-R08 source is analytics_sales_facts, the same warehouse definition consumed by every cockpit page.
 * @param {any} c */
export async function report(c) {
  const actor = await currentActor(c.db, c.actor);
  await requireCapability({ ...c, actor }, "report.read");
  const scope = await scopeFilterForActor(c.db, actor),
    ids = scope.unitIds ?? [];
  const from = realDate(c.url.searchParams.get("from") ?? today()),
    to = realDate(c.url.searchParams.get("to") ?? from);
  if (to < from || (Date.parse(to) - Date.parse(from)) / 86400000 > 31)
    refuse("Choose a report period of up to 32 days");
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const registers =
    await c.db`select r.*,l.name as store_name from store_registers r join inventory_locations l on l.id=r.location_id where l.active and l.deleted_at is null and (${scope.unitIds === null} or l.org_unit_id in ${c.db(ids.length ? ids : ["00000000-0000-0000-0000-000000000000"])}) order by l.name,r.name limit 101`;
  if (registers.length > 100) refuse("Narrow the store reporting area");
  /** @type {Map<string,any>} */
  const stores = new Map();
  for (const r of registers) {
    if (r.outlet_id) {
      const owner = await outletOwnerUnit(c.db, r.outlet_id, Date.now());
      if (scope.unitIds !== null && (!owner || !ids.includes(owner))) continue;
    }
    if (!stores.has(r.location_id))
      stores.set(r.location_id, { ...r, registers: [] });
    stores.get(r.location_id).registers.push({ id: r.id, name: r.name });
  }
  const rows = [];
  for (const r of stores.values()) {
    const regIds = r.registers.map((/** @type {any} */ x) => x.id);
    const facts =
      await c.db`select f.service_date::text as day,f.category,sum(f.sales_centavos)::text as sales from analytics_sales_facts f join orders o on o.id=f.order_id join store_sales s on s.order_id=coalesce(o.original_order_id,o.id) join store_shifts h on h.id=s.shift_id where f.source_location_id=${r.location_id} and h.register_id in ${c.db(regIds)} and f.service_date between ${from}::date-${days} and ${to}::date and (${actor.role !== "sales"} or f.profile_id=${actor.profileId}) and (${scope.unitIds === null} or f.agent_unit_id in ${c.db(ids.length ? ids : ["00000000-0000-0000-0000-000000000000"])}) group by f.service_date,f.category order by f.service_date,f.category`;
    const current = facts.filter((/** @type {any} */ f) => f.day >= from),
      prior = facts.filter((/** @type {any} */ f) => f.day < from);
    const [basket] =
      await c.db`select count(distinct f.order_id) as n from analytics_sales_facts f join orders o on o.id=f.order_id join store_sales s on s.order_id=coalesce(o.original_order_id,o.id) join store_shifts h on h.id=s.shift_id where f.source_location_id=${r.location_id} and h.register_id in ${c.db(regIds)} and f.service_date between ${from} and ${to} and f.sales_centavos>=0 and (${actor.role !== "sales"} or f.profile_id=${actor.profileId}) and (${scope.unitIds === null} or f.agent_unit_id in ${c.db(ids.length ? ids : ["00000000-0000-0000-0000-000000000000"])})`;
    const [target] =
      await c.db`select coalesce(sum(t.amount_centavos),0)::text as n from store_daily_targets t cross join generate_series(${from}::date,${to}::date,'1 day') d where t.register_id in ${c.db(regIds)} and d::date between t.from_date and t.to_date`;
    const [shrink] =
      await c.db`select coalesce(sum(-l.variance_base) filter(where l.variance_base<0),0)::text as n from stock_count_lines l join stock_count_sessions s on s.id=l.session_id where s.location_id=${r.location_id} and s.status='posted' and (s.created_at at time zone 'Asia/Manila')::date between ${from} and ${to}`;
    const sales = current.reduce(
        (/** @type {any} */ n, /** @type {any} */ f) => n + Number(f.sales),
        0,
      ),
      previous = prior.reduce(
        (/** @type {any} */ n, /** @type {any} */ f) => n + Number(f.sales),
        0,
      );
    if (
      ![sales, previous, Number(target.n), Number(shrink.n)].every(
        Number.isSafeInteger,
      )
    )
      refuse("Narrow the report period; totals exceed the safe display bound");
    rows.push({
      id: r.location_id,
      name: r.store_name,
      register: r.registers.map((/** @type {any} */ x) => x.name).join(", "),
      registers: r.registers,
      sales,
      prior: previous,
      target: Number(target.n),
      basket: Number(basket.n) ? Math.round(sales / Number(basket.n)) : 0,
      orders: Number(basket.n),
      shrink: roleHas(actor.role, "inventory.count.approve")
        ? Number(shrink.n)
        : null,
      trend: current.map((/** @type {any} */ f) => ({
        day: f.day,
        category: f.category,
        sales: Number(f.sales),
      })),
      nextAction:
        sales < Number(target.n)
          ? "Review the sales gap and replenish low stock"
          : "Review counts, deposits and replenishment",
    });
  }
  return { from, to, rows, source: "analytics_sales_facts", currency: "PHP" };
}
