import { tx } from "@sunpride/db/client";
import { accessVisit } from "../visits/shared.js";
import { enqueue } from "../../core/jobs.js";
import { ApiError } from "../../core/errors.js";
import { OpRejected } from "../../core/sync.js";
import {
  requireCapability,
  requireNationalScope,
  roleHas,
} from "../../core/capabilities.js";
import {
  accessOutlet,
  bounded,
  date,
  invalid,
  once,
  officePerson,
  scoped,
  scopedVisits,
  uuid,
  seams,
} from "./common.js";
import {
  currentMasters,
  equipmentAt,
  posmAt,
  masterById,
  MASTER_KINDS,
  policyAt,
  saveMaster,
  service,
} from "./masters.js";
import { capture, caseAction, custody } from "./capture.js";
import { accountWeek, publishScore } from "./scoring.js";
import { installWeekly } from "./weekly.js";
import {
  confirmReceipt,
  openRecall,
  recallDetail,
  recallEvent,
  traceBatch,
} from "./recall.js";
/** F-310: a cached addition to the existing outlet/configuration snapshot, not another bootstrap engine.
 * @param {any} c @param {any} outlet */
export async function outletRetail(c, outlet) {
  const { outlet: canonical } = await accessOutlet(c, outlet.id, "visit.read");
  outlet = canonical;
  const at = c.now;
  const equipment = await equipmentAt(c.db, outlet.id, at);
  const masters = [];
  for (const kind of ["posm", "expiry_policy", "incident_category"])
    masters.push(...(await currentMasters(c.db, kind, at)));
  const agreementIds = [
    ...new Set(equipment.map((/** @type {any} */ e) => e.data.policyVersionId)),
  ];
  if (agreementIds.length)
    masters.push(
      ...(await c.db`select * from retail_master_versions where kind='cold_policy' and id in ${c.db(agreementIds)}`),
    );
  const deployments = await posmAt(
    c.db,
    { kind: "deploy", outletId: outlet.id },
    at,
  );
  return {
    planogram: await policyAt(c.db, "planogram", outlet, at),
    equipment,
    masters,
    deployments,
    issuedPosm: await posmAt(
      c.db,
      { kind: "issue", profileId: c.actor.profileId },
      at,
    ),
    campaigns: await seams.campaigns(c, outlet, at),
    photoWatermarkAuthority: "INTEGRITY",
    version: 1,
  };
}
/** F-310 F-316: coherent invalidation includes future master cutovers and TPM versions.
 * @param {any} db @param {number} now */
export async function retailManifest(db, now) {
  const rows = bounded(
    await db`select id,version,effective_to from retail_master_versions where effective_from<=${new Date(now)} and (effective_to is null or effective_to>${new Date(now)}) order by id limit 5001`,
    5000,
  );
  const custody =
    await db`select count(*)::text as n,max(occurred_at) as at from posm_custody_events`;
  const [exists] =
    await db`select to_regclass('public.campaign_versions') as relation`;
  const campaigns = exists.relation
    ? bounded(
        await db`select id,updated_at from campaign_versions where effective_from<=${new Date(now)} and effective_to>${new Date(now)} order by id limit 501`,
      )
    : [];
  return { rows, custody, campaigns };
}
/** @param {any} router @param {any} installCtx */
export function install(router, installCtx) {
  installWeekly(installCtx);
  installCtx.registerTopic("retail", (/** @type {any} */ a) =>
    roleHas(a.role, "visit.read"),
  );
  installCtx.registerOp("retail.capture", async (/** @type {any} */ c) => {
    try {
      return await capture(c);
    } catch (e) {
      if (e instanceof ApiError)
        throw new OpRejected(
          e.status === 403
            ? "out_of_scope"
            : e.status === 409
              ? "idempotency_conflict"
              : "invalid_request",
        );
      throw e;
    }
  });
  /** @param {string} capability @param {any} handler @param {boolean} [idempotent] */
  const command =
    (capability, handler, idempotent = true) =>
    async (/** @type {any} */ c) => {
      await requireCapability(c, capability);
      if (!c.body || typeof c.body !== "object" || Array.isArray(c.body))
        throw invalid();
      const topics = new Set();
      const response = await tx(c.db, async (db) => {
        const cc = {
          ...c,
          db,
          app: "web",
          payload: c.body,
          op: { clientOpId: c.body.requestKey },
          change: (
            /** @type {string} */ entity,
            /** @type {string} */ entityId,
            /** @type {string} */ scopeKey,
          ) => installCtx.recordChange(db, { entity, entityId, scopeKey }),
          publish: (/** @type {string} */ topic) => topics.add(topic),
          enqueue: (/** @type {any} */ j) => enqueue(db, j),
        };
        await authorizeCommand(cc);
        return idempotent
          ? once(cc, c.url.pathname, c.body, () => handler(cc))
          : handler(cc);
      });
      for (const topic of topics) await c.publish(topic);
      return response;
    };
  for (const [
    path,
    capability,
    handler,
  ] of /** @type {Array<[string,string,any]>} */ ([
    ["masters/publish", "masterdata.manage", saveMaster],
    ["equipment/service", "outlet.manage", service],
    ["posm/custody", "outlet.manage", custody],
    ["cases/action", "outlet.manage", caseAction],
    ["scores/publish", "masterdata.manage", publishScore],
    ["batch/confirm", "outlet.manage", confirmReceipt],
    ["recalls/open", "outlet.manage", openRecall],
    ["recalls/event", "outlet.manage", recallEvent],
  ]))
    router.post(`/api/v1/retail/${path}`, command(capability, handler));
  router.post(
    "/api/v1/retail/capture",
    command("visit.record", capture, false),
  );
  router.get("/api/v1/retail/outlet", async (/** @type {any} */ c) => {
    const { outlet } = await accessOutlet(
      c,
      uuid(c.url.searchParams.get("outletId")),
      "visit.read",
    );
    return outletRetail(c, outlet);
  });
  router.get("/api/v1/retail/workspace", workspace);
  router.get("/api/v1/retail/scores", async (/** @type {any} */ c) => {
    await requireCapability(c, "visit.read");
    const id = uuid(c.url.searchParams.get("customerId")),
      week = date(c.url.searchParams.get("weekStart"));
    const current = await accountWeek(c, id, week),
      prior = await accountWeek(
        c,
        id,
        new Date(Date.parse(week) - 7 * 86400000).toISOString().slice(0, 10),
      );
    const publications = bounded(
      await c.db`select * from perfect_store_publications where customer_id=${id} and week_start=${week} order by revision desc limit 101`,
      100,
    );
    // Never expose an old account-wide snapshot after any branch changes current ownership.
    const visible = [];
    for (const p of publications) {
      const branches = await scoped(
        c,
        p.snapshot.branches,
        (/** @type {any} */ r) => r.outletId,
      );
      let authorized = branches.length === p.snapshot.branches.length;
      for (const branch of branches) {
        if (!branch.visitId) {
          if (
            p.actor_subject !== "system:sample" ||
            p.snapshot.synthetic !== true
          )
            authorized = false;
          continue;
        }
        const [visit] =
          await c.db`select * from visit_executions where id=${uuid(branch.visitId)} and deleted_at is null`;
        if (!visit) {
          authorized = false;
          continue;
        }
        try {
          await accessVisit(c, visit);
        } catch (e) {
          if (e instanceof ApiError && e.status === 403) authorized = false;
          else throw e;
        }
      }
      if (authorized) visible.push(p);
    }
    return { current, prior, publications: visible };
  });
  router.get("/api/v1/retail/batch/trace", async (/** @type {any} */ c) => {
    await requireCapability(c, "inventory.read");
    return traceBatch(c, uuid(c.url.searchParams.get("lotId")));
  });
  router.get("/api/v1/retail/recalls/detail", async (/** @type {any} */ c) => {
    await requireCapability(c, "inventory.read");
    return recallDetail(c, uuid(c.url.searchParams.get("recallId")));
  });
}
/** @param {any} c */
async function workspace(c) {
  await requireCapability(c, "visit.read");
  const outletFilter = c.url.searchParams.get("outletId");
  if (outletFilter) await accessOutlet(c, uuid(outletFilter), "visit.read");
  /** @type {string[]} */ const incompleteSections = [];
  const page = (/** @type {any[]} */ rows, /** @type {string} */ name) => {
    if (rows.length > 500) incompleteSections.push(name);
    return rows.slice(0, 500);
  };
  const masters = [];
  for (const kind of MASTER_KINDS) {
    const rows = page(
      await c.db`select * from retail_master_versions where kind=${kind} and (${kind !== "equipment" || !outletFilter} or data->>'outletId'=${outletFilter}) order by code,version desc limit 501`,
      kind,
    );
    masters.push(
      ...(kind === "equipment"
        ? await scoped(c, rows, (r) => r.data.outletId)
        : rows),
    );
  }
  const cases = await scopedVisits(
    c,
    page(
      await c.db`select c.*,a.visit_id,o.name as outlet_name from retail_action_cases c join retail_execution_audits a on a.id=c.audit_id join outlets o on o.id=c.outlet_id where (${!outletFilter} or c.outlet_id=${outletFilter}) order by (c.status in ('resolved','rejected')),c.due_at,c.id limit 501`,
      "cases",
    ),
  );
  const audits = await scopedVisits(
    c,
    page(
      await c.db`select a.*,o.name as outlet_name from retail_execution_audits a join outlets o on o.id=a.outlet_id where (${!outletFilter} or a.outlet_id=${outletFilter}) order by a.captured_at desc,a.id limit 501`,
      "audits",
    ),
  );
  const outlets = await scoped(
    c,
    bounded(
      await c.db`select id,name,code,classification from outlets where organization_id='sunpride' and status='active' and deleted_at is null order by name limit 501`,
    ),
    (r) => r.id,
  );
  const outletIds = outlets.map((/** @type {any} */ r) => r.id);
  const accounts = outletIds.length
    ? bounded(
        await c.db`select distinct c.id,c.name,c.code from customers c join outlet_customer_links l on l.customer_id=c.id where l.outlet_id in ${c.db(outletIds)} and l.deleted_at is null and c.deleted_at is null and l.effective_from<=${new Date(c.now)} and (l.effective_to is null or l.effective_to>${new Date(c.now)}) order by c.name limit 501`,
      )
    : [];
  const lots = bounded(
    await c.db`select l.id,l.lot_number,p.name as product_name from inventory_lots l join products p on p.id=l.product_id where l.organization_id='sunpride' order by l.received_at desc,l.id limit 501`,
  );
  const products = bounded(
    await c.db`select id,code,name from products where active and deleted_at is null and (organization_id is null or organization_id='sunpride') order by name limit 501`,
  );
  const serviceRows = page(
    await c.db`select s.*,m.label,m.data from equipment_service_events s join retail_master_versions m on m.id=s.equipment_version_id where (${!outletFilter} or m.data->>'outletId'=${outletFilter}) order by s.occurred_at desc limit 501`,
    "services",
  );
  const services = await scoped(c, serviceRows, (r) => r.data.outletId);
  const deployments = await scoped(
    c,
    bounded(
      await c.db`select distinct on(unit_code) e.*,m.label from posm_custody_events e join retail_master_versions m on m.id=e.material_version_id where e.outlet_id is not null order by unit_code,occurred_at desc,id desc limit 501`,
    ),
    (r) => r.outlet_id,
  );
  const custodians = [];
  const posmUnits = [];
  if (roleHas(c.actor.role, "outlet.manage")) {
    const people = bounded(
      await c.db`select p.id,p.name,coalesce(a.org_unit_id,p.org_unit_id) as org_unit_id from profiles p left join employee_assignments a on a.profile_id=p.id and a.deleted_at is null and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now()) where p.status='active' and p.deleted_at is null order by p.name limit 501`,
    );
    for (const person of people) {
      try {
        await officePerson(c, person.id);
        custodians.push({ id: person.id, name: person.name });
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 403)) throw e;
      }
    }
    const units = bounded(
      await c.db`select distinct on(e.unit_code) e.*,m.label,m.data as material,p.name as custodian_name,p.org_unit_id as custodian_unit_id from posm_custody_events e join retail_master_versions m on m.id=e.material_version_id join profiles p on p.id=e.custodian_profile_id order by e.unit_code,e.occurred_at desc,e.id desc limit 501`,
    );
    for (const unit of units) {
      try {
        if (unit.outlet_id)
          await accessOutlet(c, unit.outlet_id, "outlet.manage");
        await officePerson(c, unit.custodian_profile_id, true);
        const [last] =
          await c.db`select captured_at from retail_execution_audits where kind='posm' and facts->>'unitCode'=${unit.unit_code} order by captured_at desc,id desc limit 1`;
        posmUnits.push({
          ...unit,
          nextAuditAt:
            unit.kind === "deploy"
              ? +new Date(last?.captured_at ?? unit.occurred_at) +
                unit.material.auditEveryDays * 86400000
              : null,
        });
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 403)) throw e;
      }
    }
  }
  return {
    masters,
    custodians,
    posmUnits,
    cases,
    audits,
    outlets,
    accounts,
    lots,
    products,
    services,
    deployments,
    incompleteSections,
    asOf: c.now,
    nextAction:
      cases.find(
        (/** @type {any} */ r) => !["resolved", "rejected"].includes(r.status),
      )?.kind ?? "Review missing component evidence before weekly publication",
  };
}
/** Authorization is repeated BEFORE idempotency replay; a cached response is not a scope grant.
 * @param {any} c */
async function authorizeCommand(c) {
  const path = c.url.pathname,
    b = c.body;
  if (
    path.endsWith("/masters/publish") ||
    path.endsWith("/scores/publish") ||
    path.endsWith("/recalls/open")
  )
    await requireNationalScope(c, ["super_admin", "admin", "operations"]);
  if (path.endsWith("/equipment/service")) {
    const m = await masterById(c.db, uuid(b.equipmentVersionId), "equipment");
    if (!m) throw invalid();
    await accessOutlet(c, m.data.outletId, "outlet.manage");
  }
  if (path.endsWith("/cases/action")) {
    const [r] =
      await c.db`select outlet_id from retail_action_cases where id=${uuid(b.caseId)}`;
    if (!r) throw invalid();
    await accessOutlet(c, r.outlet_id, "outlet.manage");
  }
  if (path.endsWith("/batch/confirm") || path.endsWith("/recalls/event"))
    await accessOutlet(c, uuid(b.outletId), "outlet.manage");
  if (path.endsWith("/posm/custody")) {
    if (b.outletId) await accessOutlet(c, uuid(b.outletId), "outlet.manage");
    const [last] =
      await c.db`select outlet_id,custodian_profile_id from posm_custody_events where unit_code=${b.unitCode} order by occurred_at desc,id desc limit 1`;
    if (last?.outlet_id) await accessOutlet(c, last.outlet_id, "outlet.manage");
    await officePerson(c, uuid(b.custodianProfileId));
    if (last?.custodian_profile_id)
      await officePerson(c, last.custodian_profile_id, true);
  }
}
