import { tx } from "@sunpride/db/client";
import { requireCapability, roleHas } from "../../core/capabilities.js";
import { recordChange } from "../../core/sync.js";
import { currentActor, currentDeviceActor } from "../van/access.js";
import { scopeFilterForActor } from "../org/scope.js";
import { uuid, refuse, text, date } from "../van/model.js";
import {
  saveRegistration,
  createSeries,
  allocateDocumentNumber,
  issueDocument,
  documentEvent,
} from "./series.js";
import { confirmTender, saveTenderRule } from "./tenders.js";
import { retireAllocation } from "./reconciliation.js";
import {
  requestOverride,
  decideOverride,
  saveRule,
  enforceAuthority,
  authorityContext,
  readOverride,
} from "./authority.js";
import { installCommercial } from "./commercial.js";
export { allocateDocumentNumber } from "./series.js";
export { requestOverride } from "./authority.js";

/** F-018/F-019/F-020/F-124/F-511. @param {any} router @param {any} ctx */
export function install(router, ctx) {
  installCommercial(router);
  ctx.registerTopic(
    "fiscal",
    (/** @type {any} */ actor, /** @type {string} */ topic) =>
      topic === "fiscal" && roleHas(actor?.role, "van.read"),
  );
  ctx.registerOp("fiscal.print", async (/** @type {any} */ c) => {
    const { actor } = await currentDeviceActor(c.db, c.actor, c.device.id);
    const sourceType = c.payload.paymentId ? "van_collection" : "van_sale";
    const sourceId = uuid(c.payload.paymentId || c.payload.saleId);
    const [d] =
      await c.db`select id from fiscal_documents where source_type=${sourceType} and source_id=${sourceId}`;
    if (!d) refuse("Sync the fiscal document before its print journal");
    const result = await documentEvent(c.db, actor, {
      ...c.payload,
      documentId: d.id,
      requestKey: c.op.clientOpId,
    });
    c.publish("fiscal");
    return { entityId: result.id };
  });
  const commands = {
    "registrations/save": saveRegistration,
    "tenders/save": saveTenderRule,
    "series/create": createSeries,
    "allocations/retire": retireAllocation,
    "tenders/confirm": confirmTender,
    "allocations/reserve": (
      /** @type {any} */ db,
      /** @type {any} */ actor,
      /** @type {any} */ p,
    ) => allocateDocumentNumber(db, { ...p, actor }),
    "overrides/request": requestOverride,
    "overrides/decide": (
      /** @type {any} */ db,
      /** @type {any} */ actor,
      /** @type {any} */ p,
    ) => decideOverride(db, actor, p, ctx.env),
    "authority/save": saveRule,
    "documents/event": documentEvent,
    "documents/spoil": async (
      /** @type {any} */ db,
      /** @type {any} */ actor,
      /** @type {any} */ p,
    ) => {
      const checked = await currentDeviceActor(db, actor, uuid(p.deviceId));
      const facts = {
        allocationId: uuid(p.allocationId),
        serial: p.serial,
        reason: text(p.reason, 300, true),
      };
      await enforceAuthority(
        db,
        checked.actor,
        {
          ...p,
          kind: "void",
          amountCentavos: "0",
          facts,
          operationId: uuid(p.requestKey),
        },
        ctx.env,
      );
      const d = await issueDocument(db, {
        ...p,
        actor: checked.actor,
        sourceType: "spoiled",
        sourceId: p.requestKey,
        at: Date.now(),
        snapshot: { reason: facts.reason },
      });
      await db`insert into fiscal_document_events(document_id,kind,request_key,reason,actor_profile_id) values(${d.id},'spoiled',${crypto.randomUUID()},${facts.reason},${actor.profileId})`;
      return { id: d.id };
    },
  };
  for (const [name, fn] of Object.entries(commands))
    router.post(`/api/v1/fiscal/${name}`, async (/** @type {any} */ c) => {
      const result = await tx(c.db, async (db) => {
        const actor = await currentActor(db, c.actor);
        await db`select set_config('sunpride.actor',${actor.userId},true)`;
        const result = await fn(db, actor, c.body);
        await recordChange(db, {
          entity: "fiscal",
          entityId: actor.profileId,
          scopeKey: `profile:${actor.profileId}`,
          op: "upsert",
        });
        return result;
      });
      ctx.publish("fiscal");
      ctx.publish("analytics");
      return result;
    });
  router.get("/api/v1/fiscal/authority/context", async (/** @type {any} */ c) =>
    tx(c.db, async (db) => {
      const actor = await currentActor(db, c.actor);
      return authorityContext(db, actor, actor.orgUnitId, ctx.env);
    }),
  );
  router.get("/api/v1/fiscal/overrides/status", async (/** @type {any} */ c) =>
    tx(c.db, (db) =>
      readOverride(db, c.actor, c.url.searchParams.get("id"), ctx.env),
    ),
  );
  router.post("/api/v1/fiscal/overrides/status", async (/** @type {any} */ c) =>
    tx(c.db, (db) => readOverride(db, c.actor, c.body.id, ctx.env)),
  );
  router.get("/api/v1/fiscal/register", async (/** @type {any} */ c) =>
    tx(c.db, async (db) => {
      const actor = await currentActor(db, c.actor);
      await requireCapability({ db, actor }, "van.read");
      const scope = await scopeFilterForActor(db, actor);
      const scopeIds = scope.unitIds?.length
        ? scope.unitIds
        : ["00000000-0000-0000-0000-000000000000"];
      const branch = c.url.searchParams.get("branchId");
      if (branch)
        await requireCapability({ db, actor }, "van.read", uuid(branch));
      const ids = branch ? [branch] : scopeIds,
        all = !branch && scope.unitIds === null;
      const day = c.url.searchParams.get("day")
        ? date(c.url.searchParams.get("day"))
        : null;
      const registrations =
        await db`select r.*,u.name as unit_name,d.inventory_tag as device_name,d.app as device_app from fiscal_registrations r join org_units u on u.id=r.org_unit_id left join registered_devices d on d.id=r.device_id where (${all} or r.org_unit_id in ${db(ids)}) order by r.created_at desc limit 501`;
      const series =
        await db`select s.*,r.document_type,r.branch_name,r.sample,r.status as registration_status from fiscal_series s join fiscal_registrations r on r.id=s.registration_id where (${all} or r.org_unit_id in ${db(ids)}) order by s.prefix limit 501`;
      const allocations =
        await db`select a.*,s.prefix,r.document_type,p.name as seller,(select row_to_json(c) from fiscal_allocation_closures c where c.allocation_id=a.id) as closure,(select count(*)::int from fiscal_documents d where d.allocation_id=a.id) as accounted from fiscal_allocations a join fiscal_series s on s.id=a.series_id join fiscal_registrations r on r.id=s.registration_id join profiles p on p.id=a.profile_id where (${all} or r.org_unit_id in ${db(ids)}) and (${actor.role !== "sales"} or a.profile_id=${actor.profileId}) order by a.created_at desc limit 501`;
      const overrides =
        await db`select r.*,p.name as requester,(select e.kind from fiscal_override_events e where e.request_id=r.id and e.kind in ('approved','rejected')) as decision,(select p2.name from fiscal_override_events e join profiles p2 on p2.id=e.actor_profile_id where e.request_id=r.id and e.kind in ('approved','rejected')) as approver from fiscal_override_requests r join profiles p on p.id=r.requester_id where (${all} or r.org_unit_id in ${db(ids)}) and (${actor.role !== "sales"} or r.requester_id=${actor.profileId}) order by r.created_at desc limit 501`;
      const rules =
        await db`select r.*,u.name as branch_name from fiscal_authority_rules r join org_units u on u.id=r.org_unit_id where (${all} or r.org_unit_id in ${db(ids)}) order by r.effective_from desc limit 501`;
      const documents =
        await db`select d.*,r.branch_name,r.document_type,r.sample,
        (select jsonb_build_object('status',e.status,'reference',e.external_document_number,'source',e.sap_result->>'source') from integration_events e where e.source_id=d.source_id::text and
          ((d.source_type='van_sale' and e.source_type='van_sale' and e.event_type='invoice') or
           (d.source_type='van_collection' and e.source_type='van_payment' and e.event_type='payment') or
           (d.source_type in ('van_return','van_void') and e.source_type=d.source_type and e.event_type='credit_memo')) order by e.received_at,e.id limit 1) as sap_posting,
        (select jsonb_agg(jsonb_build_object('kind',e.kind,'reason',e.reason,'at',e.created_at,'facts',e.facts) order by e.created_at,e.id) from fiscal_document_events e where e.document_id=d.id) as journal from fiscal_documents d join fiscal_series s on s.id=d.series_id join fiscal_registrations r on r.id=s.registration_id join fiscal_allocations a on a.id=d.allocation_id where (${all} or r.org_unit_id in ${db(ids)}) and (${actor.role !== "sales"} or a.profile_id=${actor.profileId}) and (${day}::date is null or (d.issued_at at time zone 'Asia/Manila')::date=${day}) order by d.created_at desc limit 501`;
      const devices =
        await db`select id,inventory_tag as name from registered_devices where status='active' and (${all} or org_unit_id in ${db(ids)}) order by inventory_tag limit 501`;
      const units =
        await db`select id,name from org_units where status='active' and deleted_at is null and (${scope.unitIds === null} or id in ${db(scopeIds)}) order by name limit 501`;
      const vehicles =
        await db`select id,vehicle_code as name from vehicles where deleted_at is null and (${all} or org_unit_id in ${db(ids)}) order by vehicle_code limit 501`;
      const tenders =
        await db`select v.id,v.method,v.kind,v.amount_centavos,v.facts,t.trip_number,p.name as seller,c.decision from van_payments v join van_trips t on t.id=v.trip_id join profiles p on p.id=t.salesperson_profile_id left join fiscal_tender_confirmations c on c.payment_id=v.id where (${all} or t.org_unit_id in ${db(ids)}) and (${actor.role !== "sales"} or t.salesperson_profile_id=${actor.profileId}) and (${day}::date is null or t.service_date=${day}) order by v.created_at desc limit 501`;
      // Full-source totals are independent of the 500-row item/reconciliation display cap.
      const tenderTotals = await db`select v.method,
        sum(case when v.kind in ('refund','void_refund') then -v.amount_centavos else v.amount_centavos end)::text as captured_centavos,
        count(*) filter(where c.decision is null and v.method not in ('cash','credit'))::int as awaiting_count,
        count(*) filter(where c.decision='rejected')::int as refused_count
        from van_payments v join van_trips t on t.id=v.trip_id left join fiscal_tender_confirmations c on c.payment_id=v.id
        where (${all} or t.org_unit_id in ${db(ids)}) and (${actor.role !== "sales"} or t.salesperson_profile_id=${actor.profileId})
        and (${day}::date is null or t.service_date=${day}) group by v.method order by v.method`;
      const tenderRules =
        await db`select r.*,u.name as branch_name from fiscal_tender_rules r join org_units u on u.id=r.org_unit_id where (${all} or r.org_unit_id in ${db(ids)}) order by r.effective_from desc limit 501`;
      return {
        tenderTotals,
        tenderRules: tenderRules.slice(0, 500),
        devices: devices.slice(0, 500),
        units: units.slice(0, 500),
        vehicles: vehicles.slice(0, 500),
        tenders: tenders.slice(0, 500),
        registrations: registrations.slice(0, 500),
        series: series.slice(0, 500),
        allocations: allocations.slice(0, 500),
        overrides: overrides.slice(0, 500),
        rules: rules.slice(0, 500),
        documents: documents.slice(0, 500),
        truncated: [
          devices,
          tenderRules,
          units,
          vehicles,
          tenders,
          registrations,
          series,
          allocations,
          overrides,
          rules,
          documents,
        ].some((x) => x.length > 500),
        canAudit:
          roleHas(actor.role, "admin.manage") &&
          roleHas(actor.role, "van.stock.approve") &&
          roleHas(actor.role, "van.cash.approve"),
        canManage: roleHas(actor.role, "admin.manage"),
        canDecide: roleHas(actor.role, "order.approve"),
      };
    }),
  );
  router.get("/api/v1/fiscal/audit", async (/** @type {any} */ c) =>
    tx(c.db, async (db) => {
      const actor = await currentActor(db, c.actor);
      // Cross-domain audit includes blind van settlement facts: ordinary administrators cannot read them.
      await requireCapability({ db, actor }, "admin.manage");
      await requireCapability({ db, actor }, "van.stock.approve");
      await requireCapability({ db, actor }, "van.cash.approve");
      const scope = await scopeFilterForActor(db, actor);
      if (scope.unitIds !== null) {
        const root =
          await db`select id from org_units where code='NATIONAL' and status='active' and deleted_at is null`;
        if (!root.some((/** @type {any} */ r) => r.id === actor.orgUnitId))
          refuse("National audit access required");
      }
      const before = c.url.searchParams.get("before");
      const from = c.url.searchParams.get("from");
      const table = c.url.searchParams.get("table") || null;
      const action = c.url.searchParams.get("action") || null;
      if (
        (from && !Number.isFinite(Date.parse(from))) ||
        (table && !/^[a-z][a-z0-9_]{0,79}$/.test(table)) ||
        (action && !["INSERT", "UPDATE", "DELETE"].includes(action))
      )
        refuse("Choose valid audit filters");
      if (before && from && Date.parse(from) >= Date.parse(before))
        refuse("Audit end must follow its start");
      if (before && !Number.isFinite(Date.parse(before)))
        refuse("Choose a valid audit cursor");
      /** @type {string|null} */ let cursorAt = null;
      /** @type {string|null} */ let cursorId = null;
      const raw = c.url.searchParams.get("cursor");
      if (raw) {
        try {
          if (
            raw.length > 200 ||
            Buffer.from(raw, "base64url").toString("base64url") !== raw
          )
            throw Error();
          const parsed = JSON.parse(
            Buffer.from(raw, "base64url").toString("utf8"),
          );
          if (
            typeof parsed.at !== "string" ||
            !/^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(
              parsed.at,
            ) ||
            !Number.isFinite(Date.parse(parsed.at)) ||
            new Date(parsed.at).toISOString() !==
              parsed.at.slice(0, 23) + "Z" ||
            uuid(parsed.id) !== parsed.id
          )
            throw Error();
          cursorAt = parsed.at;
          cursorId = parsed.id;
        } catch {
          refuse("Choose a valid audit cursor");
        }
      }
      const items =
        await db`select *, (select p.name from profiles p where p.user_id::text=fiscal_audit_events.actor_subject or p.auth_subject=fiscal_audit_events.actor_subject limit 1) as actor_name,to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_time from fiscal_audit_events
        where (${before}::timestamptz is null or created_at<${before}::timestamptz)
        and (${from}::timestamptz is null or created_at>=${from}::timestamptz)
        and (${table}::text is null or table_name=${table}) and (${action}::text is null or action=${action})
        and (${cursorAt}::timestamptz is null or (created_at,id)<(${cursorAt}::timestamptz,${cursorId}::uuid)) order by created_at desc,id desc limit 101`;
      const page = items.slice(0, 100),
        hasMore = items.length > 100,
        last = page.at(-1);
      return {
        items: page.map((/** @type {any} */ row) => {
          const { cursor_time, ...item } = row;
          return item;
        }),
        hasMore,
        nextCursor: hasMore
          ? Buffer.from(
              JSON.stringify({ at: last.cursor_time, id: last.id }),
            ).toString("base64url")
          : null,
      };
    }),
  );
}
