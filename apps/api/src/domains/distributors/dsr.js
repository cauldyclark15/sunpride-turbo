import { actorFor } from "../../core/context.js";
import { reauthorizeDevice } from "../../core/devices.js";
import { ApiError, forbidden, invalid } from "../../core/errors.js";
import { OpRejected } from "../../core/sync.js";
import { outletOwnerUnit } from "../org/scope.js";
import { checkIn, activity, checkOut } from "../visits/commands.js";
import {
  callSnapshot,
  record as recordAvailability,
} from "../availability/calls.js";
import { schedulePjp } from "../coverage/pjp-schedule.js";
import { DSR_ACCESS, validateDsrProducts } from "./dsr-context.js";
import { authorize, master, policy, uuid, integer, today } from "./model.js";

const OPERATIONS = [
  "dsr.visit.checkIn",
  "dsr.visit.activity",
  "dsr.visit.checkOut",
  "dsr.availability.record",
];
/** F-407: membership is rechecked before CORE receipt replay, not only at bootstrap.
 * @param {any} db @param {any} actor @param {any} op */
export async function enforceDsrOp(db, actor, op) {
  if (!OPERATIONS.includes(op.opType))
    throw new OpRejected("unsupported_operation");
  const id = uuid(op.payload.distributorId);
  await db`select id from distributors where id=${id} for share`;
  const [member] =
    await db`select id,effective_from,effective_to from distributor_users where distributor_id=${id} and profile_id=${actor.profileId} and effective_from<=now() and (effective_to is null or effective_to>now()) for share`;
  const d = await authorize({ db, actor }, id, "dsr");
  if (
    d.status !== "accredited" ||
    !member ||
    op.clientTime < +new Date(member.effective_from)
  )
    throw forbidden("Distributor field access is not active for this capture");
  const outletId =
    op.opType === "dsr.visit.checkIn"
      ? op.payload.outletId
      : (
          await db`select outlet_id from visit_executions where id=${uuid(op.payload.visitId)} and assignee_profile_id=${actor.profileId} and org_unit_id=${actor.orgUnitId} and deleted_at is null`
        )[0]?.outlet_id;
  if (!outletId) throw forbidden("Not your captured call");
  const [grant] =
    await db`select g.effective_from from distributor_outlets g join outlets o on o.id=g.outlet_id where g.distributor_id=${d.id} and g.outlet_id=${uuid(outletId)} and g.effective_from<=now() and (g.effective_to is null or g.effective_to>now()) and o.status='active' and o.deleted_at is null for share of g,o`;
  if (!grant || op.clientTime < +new Date(grant.effective_from))
    throw forbidden("Store grant was withdrawn");
  return d;
}
/** Only this module mints the Symbol-marked context; it carries no employee role/capabilities.
 * @param {any} c @param {any} d */
export async function dsrContext(c, d) {
  if (c.actor.role !== "distributor")
    throw forbidden("Use a granted distributor field identity");
  await authorize(c, d.id, "dsr");
  /** @type {any} */ const current = await actorFor(c.db, c.actor.userId);
  if (
    !current ||
    current.role !== "distributor" ||
    current.orgUnitId !== d.device_org_unit_id
  )
    throw forbidden();
  const products = (await master(c, d.id)).payload.products ?? [];
  const allowed = new Set(products.map((/** @type {any} */ p) => p.productId));
  /** @param {string} id */
  async function outlet(id) {
    await authorize({ ...c, actor: current }, d.id, "dsr");
    const [row] =
      await c.db`select o.*,g.territory_id from distributor_outlets g join outlets o on o.id=g.outlet_id where g.distributor_id=${d.id} and g.outlet_id=${uuid(id)} and g.effective_from<=now() and (g.effective_to is null or g.effective_to>now()) and o.deleted_at is null and o.status='active' for share of g,o`;
    if (!row) throw forbidden("Store is not assigned to this distributor");
    const owner = await outletOwnerUnit(c.db, id, Date.now());
    if (!owner) throw forbidden();
    return { outlet: row, owner };
  }
  /** @param {string} capability @param {string} target */
  async function permission(capability, target) {
    if (!["visit.read", "visit.record", "outlet.read"].includes(capability))
      throw forbidden();
    await authorize({ ...c, actor: current }, d.id, "dsr");
    if (target !== current.orgUnitId) {
      const id =
        c.payload?.outletId ??
        (c.payload?.visitId
          ? (
              await c.db`select outlet_id from visit_executions where id=${uuid(c.payload.visitId)} and assignee_profile_id=${current.profileId}`
            )[0]?.outlet_id
          : null);
      if (!id || (await outlet(id)).owner !== target) throw forbidden();
    }
    return current;
  }
  return {
    ...c,
    actor: current,
    callflowProfile: "distributor_rep",
    [DSR_ACCESS]: {
      catalog: products,
      outlet,
      permission,
      employee: { id: null, org_unit_id: current.orgUnitId, position_id: null },
      allowed,
    },
  };
}
/** F-407 uses the existing PJP allocator and shared current MSL projection, not another planner.
 * @param {any} c @param {any} d @param {any} config @param {any} m */
export async function dsrBundle(c, d, config, m) {
  const cc = await dsrContext({ ...c, app: "field-android" }, d),
    day = today(c.now),
    settings = await policy(c, d.id);
  const ids = config.outlets.map((/** @type {any} */ o) => o.id);
  if (ids.length > 100)
    throw invalid("Narrow this phone assignment to at most 100 stores");
  const outlets = ids.length
    ? await c.db`select o.*,a.route_id,a.sequence,p.latitude,p.longitude from outlets o left join outlet_assignments a on a.outlet_id=o.id and a.deleted_at is null and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now()) left join outlet_pins p on p.outlet_id=o.id and p.status='verified' and p.deleted_at is null and p.effective_from<=now() and (p.effective_to is null or p.effective_to>now()) where o.id in ${c.db(ids)} and o.deleted_at is null order by o.id`
    : [];
  const cfg =
      settings.dsrPjpByProfile?.[c.actor.profileId] ?? settings.dsrPjp ?? {},
    weekdays = cfg.sellingWeekdays ?? [1, 2, 3, 4, 5, 6];
  if (
    !Array.isArray(weekdays) ||
    !weekdays.length ||
    weekdays.some((x) => !Number.isInteger(x) || x < 0 || x > 6)
  )
    throw invalid("Configure valid partner selling weekdays");
  const month = day.slice(0, 7),
    from = month + "-01",
    to = new Date(
      Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1),
    )
      .toISOString()
      .slice(0, 10);
  const scheduled = outlets.length
    ? schedulePjp(
        {
          org_unit_id: d.org_unit_id,
          effective_from: from + "T00:00:00+08:00",
          effective_to: to + "T00:00:00+08:00",
          anchor_date: "2026-01-05",
          selling_weekdays: weekdays,
          capacity_minutes: integer(cfg.capacityMinutes ?? 480, 30, 1440),
          travel_minutes: integer(cfg.travelMinutes ?? 10, 0, 240),
          stops: outlets.map((/** @type {any} */ o) => ({
            outletId: o.id,
            ...(cfg.stops ?? []).find(
              (/** @type {any} */ s) => s.outletId === o.id,
            ),
          })),
        },
        outlets,
        [
          ...new Set(outlets.map((/** @type {any} */ o) => o.classification)),
        ].map((classKey) => ({
          id: "SAMPLE-partner-frequency",
          org_unit_id: d.org_unit_id,
          class_key: classKey,
          interval_weeks: integer(cfg.intervalWeeks ?? 1, 1, 4),
          service_minutes: integer(cfg.serviceMinutes ?? 20, 1, 240),
          objectives: ["availability"],
          effective_from: from + "T00:00:00+08:00",
          effective_to: null,
        })),
        month,
      )
    : { slots: [], days: [] };
  /** @type {Record<string,any>} */ const availability = {};
  for (const o of outlets)
    availability[o.id] = await callSnapshot(cc, o.id, day);
  const visits =
    await c.db`select id,client_visit_id,outlet_id,state,started_at,ended_at,service_date from visit_executions where assignee_profile_id=${c.actor.profileId} and service_date=${day} and deleted_at is null order by started_at,id limit 201`;
  if (visits.length > 200) throw invalid("Too many calls in this working day");
  const calls =
    await c.db`select c.client_call_id,c.outlet_id,c.definition_snapshot,c.policy_snapshot,c.started_at,c.state,coalesce((select jsonb_agg(e.step_key order by e.created_at,e.id) from call_step_events e where e.call_id=c.id),'[]') as completed from call_executions c where c.profile_id=${c.actor.profileId} and c.device_id=${c.device?.id ?? null} and c.service_date=${day} order by c.started_at limit 201`;
  return {
    version: 1,
    profileId: c.actor.profileId,
    distributorId: d.id,
    distributorName: d.name,
    serviceDate: day,
    pjpSource: cfg.sourceRef ?? "SAMPLE configurable partner beat defaults",
    agenda: scheduled.slots,
    configuration: { ...config, nativeReady: true },
    availability,
    products: (m.payload.products ?? []).length
      ? (
          await c.db`select id as "productId",code,name,uom from products where id in ${c.db(m.payload.products.map((/** @type {any} */ p) => p.productId))} and active and deleted_at is null order by code`
        ).map((/** @type {any} */ row) => ({
          ...row,
          uom:
            m.payload.products.find(
              (/** @type {any} */ p) => p.productId === row.productId,
            )?.uom ?? row.uom,
        }))
      : [],
    outlets: outlets.map((/** @type {any} */ o) => ({
      id: o.id,
      name: o.name,
      code: o.code,
      channel: o.channel,
      classification: o.classification,
    })),
    visits,
    calls,
  };
}
/** @param {any} router @param {any} platform */
export function installDsr(router, platform) {
  router.get(
    "/api/v1/distributors/self-field",
    async (/** @type {any} */ c) => {
      if (c.actor?.role !== "distributor") throw forbidden();
      const rows =
        await c.db`select d.id,d.name from distributors d join distributor_users u on u.distributor_id=d.id where d.device_org_unit_id=${c.actor.orgUnitId} and u.profile_id=${c.actor.profileId} and u.grants @> ARRAY['dsr']::text[] and u.effective_from<=now() and (u.effective_to is null or u.effective_to>now()) and d.status='accredited' and d.effective_from<=now() and (d.effective_to is null or d.effective_to>now()) limit 2`;
      if (rows.length !== 1)
        throw forbidden("A unique current distributor field grant is required");
      await authorize(c, rows[0].id, "dsr");
      return rows[0];
    },
  );
  for (const name of OPERATIONS)
    platform.registerOp(name, async (/** @type {any} */ c) => {
      try {
        const d = await enforceDsrOp(c.db, c.actor, c.op);
        await reauthorizeDevice(c.db, c.actor, c.device.id);
        const cc = await dsrContext(c, d),
          p = c.payload;
        if (name === "dsr.visit.checkIn") {
          if (p.plannedVisitId != null)
            throw invalid(
              "Partner beats do not borrow employee plan signatures",
            );
          return checkIn({
            ...cc,
            payload: {
              ...p,
              unplannedReason:
                p.unplannedReason ?? "Configured partner beat call",
            },
          });
        }
        if (name === "dsr.availability.record") return recordAvailability(cc);
        if (name === "dsr.visit.activity") {
          if (
            !["note", "inventory_check", "order_intent"].includes(
              p.activity?.kind,
            )
          )
            throw invalid("Use the scoped partner forms");
          for (const id of [
            p.activity.productId,
            ...(p.activity.lines ?? []).map(
              (/** @type {any} */ l) => l.productId,
            ),
          ].filter(Boolean))
            if (!cc[DSR_ACCESS].allowed.has(id))
              throw forbidden("Product is not in the partner catalog");
          validateDsrProducts(cc[DSR_ACCESS].catalog, p.activity);
          return activity(cc);
        }
        return checkOut(cc);
      } catch (e) {
        if (e instanceof ApiError)
          throw new OpRejected(
            e.status === 403 ? "out_of_scope" : "invalid_request",
          );
        throw e;
      }
    });
}
