import { tx } from "@sunpride/db/client";
import {
  requireCapability,
  requireNationalScope,
} from "../../core/capabilities.js";
import { actorFor } from "../../core/context.js";
import { ApiError } from "../../core/errors.js";
import { isUuid } from "../../core/util.js";
import { resolution, runOutbox } from "./outbox.js";
import { ingestMaster } from "./replicas.js";

/** F-005 national integration operations; not a scope-free payload viewer.
 * @param {any} c @param {boolean} [write]
 */
export async function consoleAccess(c, write = false) {
  await requireCapability(c, write ? "integration.manage" : "integration.read");
  await requireNationalScope(c, ["admin", "operations"]);
}
/** @param {any} c */
export async function eventList(c) {
  await consoleAccess(c);
  const status = c.url.searchParams.get("status") ?? "attention",
    cursor = c.url.searchParams.get("cursor");
  if (cursor && !isUuid(cursor))
    throw new ApiError("invalid_request", 400, "Invalid queue cursor");
  if (
    ![
      "attention",
      "all",
      "dead_letter",
      "completed",
      "failed",
      "pending",
      "processing",
    ].includes(status)
  )
    throw new ApiError("invalid_request", 400, "Invalid queue filter");
  const rows =
    await c.db`select e.*,p.name as owner_name,coalesce(o.order_number,s.receipt_number,m.movement_number,tr.trip_number) as document_label from integration_events e left join profiles p on p.id=e.owner_profile_id left join orders o on e.source_type='order' and e.source_id=o.id::text left join van_sales s on e.source_type='van_sale' and e.source_id=s.id::text left join inventory_movements m on e.source_type='movement' and e.source_id=m.id::text left join van_trips tr on e.source_type='van_trip' and e.source_id=tr.id::text
    where e.organization_id='sunpride' and (${status === "all"} or (${status === "attention"} and (e.status in ('failed','dead_letter') or e.status='processing' and e.lease_expires_at<now() or e.status='pending' and e.received_at<now()-interval '5 minutes')) or e.status=${status})
    and (${cursor === null} or e.id>${cursor}::uuid) order by e.id limit 51`;
  const [counts] =
    await c.db`select count(*) filter(where status in ('dead_letter','failed'))::integer as failed,count(*) filter(where status='processing' and lease_expires_at<now() or status='pending' and received_at<now()-interval '5 minutes')::integer as stuck,
    count(*) filter(where status='completed' and processed_at>=now()-interval '1 day')::integer as today,count(*) filter(where status='completed' and processed_at>=now()-interval '2 days' and processed_at<now()-interval '1 day')::integer as prior,
    min(received_at) filter(where status<>'completed') as oldest from integration_events where organization_id='sunpride'`;
  return {
    asOf: c.now,
    sample: (c.env.SAP_MODE ?? "mock") === "mock",
    rows: rows.slice(0, 50).map(eventView),
    next: rows.length > 50 ? rows[49].id : null,
    counts: {
      ...counts,
      oldest: counts.oldest ? new Date(counts.oldest).getTime() : null,
    },
    target: { failed: 0, stuck: 0 },
    policy:
      "SAP owns financial posting. A replay keeps the same effect reference.",
  };
}
/** @param {any} r */
export function eventView(r) {
  return {
    id: r.id,
    reference: r.correlation_id ?? r.event_id,
    kind: r.event_type.replaceAll("_", " "),
    label: r.document_label ?? r.event_type.replaceAll("_", " "),
    direction: r.direction,
    status: r.status,
    attempts: Number(r.total_attempts ?? r.attempts),
    owner: r.owner_name ?? null,
    openedAt: new Date(r.received_at).getTime(),
    nextAttemptAt: r.next_attempt_at
      ? new Date(r.next_attempt_at).getTime()
      : null,
    leaseExpiresAt: r.lease_expires_at
      ? new Date(r.lease_expires_at).getTime()
      : null,
    error: r.last_error ?? null,
    severity: r.severity,
    escalated: r.escalated_at !== null,
    documentNumber: r.external_document_number ?? null,
  };
}
/** @param {any} c @param {string} action */
export async function operateEvent(c, action) {
  await consoleAccess(c, true);
  const id = c.body.id;
  if (
    !isUuid(id) ||
    typeof c.body.reason !== "string" ||
    c.body.reason.trim().length < 3 ||
    c.body.reason.length > 500
  )
    throw new ApiError(
      "invalid_request",
      400,
      "Choose a record and enter a reason",
    );
  const result = await tx(c.db, async (db) => {
    const actor = await actorFor(db, c.actor.userId);
    const current = { ...c, db, actor };
    await consoleAccess(current, true);
    const [event] =
      await db`select * from integration_events where id=${id} and organization_id='sunpride' for update`;
    if (!event) throw new ApiError("not_found", 404, "Queue record not found");
    if (action === "retry") {
      if (event.status === "completed")
        return { id, status: "completed", duplicate: true };
      if (
        event.status === "processing" &&
        new Date(event.lease_expires_at).getTime() > Date.now()
      )
        throw new ApiError(
          "lease_active",
          409,
          "A worker still owns this record",
        );
      if (event.direction === "inbound") {
        // Replay outside this tx, from retained bytes; mark the original inbox receipt pending.
        await db`update integration_events set status='pending',attempts=0,error_class=null,last_error=null where id=${id}`;
      } else
        await db`update integration_events set status='pending',attempts=0,next_attempt_at=now(),lease_token=null,lease_expires_at=null,error_class=null,last_error=null where id=${id}`;
    }
    if (action === "assign") {
      if (c.body.ownerProfileId !== null && !isUuid(c.body.ownerProfileId))
        throw new ApiError(
          "invalid_request",
          400,
          "Choose an integration operator",
        );
      if (c.body.ownerProfileId !== null) {
        const [owner] =
          await db`select id from profiles where id=${c.body.ownerProfileId} and status='active' and deleted_at is null and role in ('super_admin','admin','operations')`;
        if (!owner)
          throw new ApiError(
            "invalid_request",
            400,
            "Owner is not an active integration operator",
          );
      }
      await db`update integration_events set owner_profile_id=${c.body.ownerProfileId} where id=${id}`;
    }
    if (action === "escalate")
      await db`update integration_events set severity='high',escalated_at=now() where id=${id}`;
    await resolution(
      db,
      id,
      action,
      {
        reason: c.body.reason.trim(),
        ...(action === "assign"
          ? { ownerProfileId: c.body.ownerProfileId }
          : {}),
      },
      actor?.profileId,
    );
    return { id, status: action === "retry" ? "pending" : event.status };
  });
  if (action === "retry") {
    const [event] = await c.db`select * from integration_events where id=${id}`;
    if (event.direction === "inbound" && event.status === "pending")
      await ingestMaster(c.db, event.payload);
  }
  await c.publish("integration");
  return result;
}
/** @param {any} router @param {any} ctx */
export function installConsole(router, ctx) {
  router.get("/api/v1/integration/events", eventList);
  router.get("/api/v1/integration/replicas", async (/** @type {any} */ c) => {
    await consoleAccess(c);
    const kind = c.url.searchParams.get("kind") ?? "material";
    if (
      ![
        "material",
        "condition",
        "customer",
        "outlet",
        "ar",
        "location",
        "stock",
      ].includes(kind)
    )
      throw new ApiError("invalid_request", 400, "Choose a master family");
    const rows =
      await c.db`select * from (select distinct on(sap_key) * from sap_replicas where kind=${kind} order by sap_key,sap_version desc) r order by sap_key limit 51`;
    return {
      kind,
      truncated: rows.length > 50,
      rows: rows.slice(0, 50).map((/** @type {any} */ r) => ({
        name:
          r.payload.data.name ??
          r.payload.data.productCode ??
          r.payload.data.locationCode ??
          r.payload.data.documentNumber ??
          r.sap_key,
        source: r.source === "sample" ? "Sample SAP" : "SAP",
        version: Number(r.sap_version),
        effectiveFrom: new Date(r.effective_from).getTime(),
        effectiveTo: r.effective_to ? new Date(r.effective_to).getTime() : null,
        receivedAt: new Date(r.received_at).getTime(),
        deleted: Boolean(r.deleted_at),
        data: r.payload.data,
      })),
    };
  });
  router.get("/api/v1/integration/mappings", async (/** @type {any} */ c) => {
    await consoleAccess(c);
    return {
      rows: (
        await c.db`select name,code,type,sap_plant,sap_storage_location,sap_received_at from inventory_locations where active and deleted_at is null and type in ('warehouse','truck') order by name`
      ).map((/** @type {any} */ r) => ({
        name: r.name,
        kind: r.type === "truck" ? "Van" : "Depot",
        plant: r.sap_plant,
        storageLocation: r.sap_storage_location,
        receivedAt: r.sap_received_at
          ? new Date(r.sap_received_at).getTime()
          : null,
        status:
          r.sap_plant && r.sap_storage_location
            ? "Mapped"
            : "Needs SAP mapping",
      })),
    };
  });
  router.get("/api/v1/integration/owners", async (/** @type {any} */ c) => {
    await consoleAccess(c);
    return {
      rows: await c.db`select id,name from profiles where status='active' and deleted_at is null and role in ('super_admin','admin','operations') order by name`,
    };
  });
  router.get("/api/v1/integration/trace", async (/** @type {any} */ c) => {
    await consoleAccess(c);
    const id = c.url.searchParams.get("id");
    if (!isUuid(id))
      throw new ApiError("invalid_request", 400, "Choose a queue record");
    const [r] = await c.db`select * from integration_events where id=${id}`;
    if (!r) throw new ApiError("not_found", 404, "Record not found");
    return {
      event: eventView(r),
      hash: r.payload_hash,
      source: { type: r.source_type, id: r.source_id },
      history: (
        await c.db`select e.action,e.created_at,e.facts,p.name as actor from integration_resolution_events e left join profiles p on p.id=e.actor_profile_id where e.event_id=${id} order by e.created_at,e.id`
      ).map((/** @type {any} */ h) => ({
        ...h,
        at: new Date(h.created_at).getTime(),
      })),
      conflicts:
        await c.db`select incoming_hash,reason,created_at from integration_conflicts where event_id=${r.event_id} order by created_at`,
    };
  });
  for (const action of ["retry", "assign", "escalate"])
    router.post(`/api/v1/integration/${action}`, (/** @type {any} */ c) =>
      operateEvent(c, action),
    );
  router.post("/api/v1/integration/drain", async (/** @type {any} */ c) => {
    await consoleAccess(c, true);
    const processed = await runOutbox(c.db, { env: ctx.env });
    await c.publish("integration");
    return { processed };
  });
}
