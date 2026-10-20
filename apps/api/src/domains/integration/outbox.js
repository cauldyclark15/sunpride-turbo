import { tx } from "@sunpride/db/client";
import { acknowledgeSpecPosting } from "./spec-adapters.js";
import {
  validate,
  postingKinds,
  payloadHash,
} from "../../../../../packages/integration-contracts/sap/v1/index.js";
import { sapRequest, SapFailure } from "./transport.js";

export const LEASE_MS = 30000;
export const MAX_ATTEMPTS = 5;
/** @param {number} attempt */
export const backoffMs = (attempt) =>
  Math.min(1000 * 2 ** Math.max(0, attempt - 1), 300000);
/** @param {any} db @param {string} id @param {string} action @param {any} [facts] @param {string|null} [actor] */
export async function resolution(db, id, action, facts = {}, actor = null) {
  await db`insert into integration_resolution_events(event_id,action,actor_profile_id,facts) values(${id},${action},${actor},${facts})`;
}
/** F-003: preserve the original event and quarantine changed input, including after completion.
 * Caller must retain the returned quarantine outcome, not throw and roll back its evidence.
 * @param {any} db @param {any} input
 */
export async function receiveEvent(db, input) {
  // Freeze the exact JSON wire representation before hashing: SQL dates serialize to
  // ISO strings and undefined object properties are omitted by JSON, not hashed as {}.
  const e = { ...input, payload: JSON.parse(JSON.stringify(input.payload)) };
  const hash = payloadHash(e.payload);
  await db`select pg_advisory_xact_lock(hashtextextended(${`sap:${e.eventId}`},0))`;
  const [old] =
    await db`select * from integration_events where event_id=${e.eventId} for update`;
  if (old) {
    if (
      old.payload_hash === hash &&
      payloadHash(old.depends_on ?? []) === payloadHash(e.dependsOn ?? [])
    )
      return { id: old.id, duplicate: true, quarantined: false };
    const incomingHash =
      old.payload_hash === hash
        ? payloadHash({ payload: e.payload, dependsOn: e.dependsOn ?? [] })
        : hash;
    await db`insert into integration_conflicts(event_id,original_hash,incoming_hash,payload,reason) values(${e.eventId},${old.payload_hash},${incomingHash},${e.payload},'Changed payload or dependency under an existing key') on conflict do nothing`;
    await resolution(db, old.id, "quarantined", { incomingHash });
    return { id: old.id, duplicate: false, quarantined: true };
  }
  const [row] =
    await db`insert into integration_events(event_id,direction,event_type,status,attempts,payload,received_at,organization_id,schema_version,payload_hash,correlation_id,source_type,source_id,org_unit_id,next_attempt_at,depends_on)
    values(${e.eventId},${e.direction},${e.kind},'pending',0,${e.payload},now(),'sunpride',1,${hash},${e.correlationId ?? e.eventId},${e.sourceType ?? null},${e.sourceId ?? null},${e.orgUnitId ?? null},now(),${e.dependsOn ?? []}) returning id`;
  await resolution(db, row.id, "received", { direction: e.direction });
  return { id: row.id, duplicate: false, quarantined: false };
}
/** F-119: invoked on the caller's business transaction, never a post-commit side effect.
 * @param {any} db @param {{kind:string,sourceType:string,sourceId:string,document:any,effectId?:string,correlationId?:string,orgUnitId?:string|null,dependsOn?:string[]}} input
 */
export async function enqueueSapPosting(db, input) {
  if (!postingKinds.includes(input.kind))
    throw new Error("Unsupported SAP posting kind");
  const effectId =
    input.effectId ?? `${input.kind}:${input.sourceType}:${input.sourceId}`;
  const dependencies = input.dependsOn ?? [];
  if (
    !Array.isArray(dependencies) ||
    dependencies.length > 15000 ||
    new Set(dependencies).size !== dependencies.length ||
    dependencies.some(
      (k) => typeof k !== "string" || k.length > 200 || k === effectId,
    )
  )
    throw new Error("Invalid SAP posting dependencies");
  const envelope = validate(input.kind, {
    schemaVersion: 1,
    organizationId: "sunpride",
    kind: input.kind,
    effectId,
    correlationId: input.correlationId ?? effectId,
    document: input.document,
  });
  return receiveEvent(db, {
    eventId: effectId,
    direction: "outbound",
    kind: input.kind,
    payload: envelope,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    orgUnitId: input.orgUnitId,
    correlationId: envelope.correlationId,
    dependsOn: dependencies,
  });
}
/** @param {any} db @param {number} [limit] */
export async function claimPostings(db, limit = 10) {
  return tx(db, async (t) => {
    const rows =
      await t`select e.* from integration_events e where direction='outbound' and schema_version=1 and source_type is not null and
      not exists(select 1 from jsonb_array_elements_text(e.depends_on) dep(effect) left join integration_events parent on parent.event_id=dep.effect where parent.status is distinct from 'completed') and
      ((status in ('pending','failed') and coalesce(next_attempt_at,now())<=now()) or (status='processing' and lease_expires_at<now()))
      order by received_at,id limit ${Math.min(Math.max(limit, 1), 50)} for update skip locked`;
    const claimed = [];
    for (const r of rows) {
      const token = crypto.randomUUID();
      const [row] =
        await t`update integration_events set status='processing',attempts=attempts+1,total_attempts=total_attempts+1,lease_token=${token},lease_expires_at=now()+interval '30 seconds',heartbeat_at=now() where id=${r.id} returning *`;
      await resolution(t, r.id, "claimed", { attempt: row.attempts });
      claimed.push(row);
    }
    return claimed;
  });
}
/** F-003 fenced heartbeat: stale workers cannot revive a stolen/expired lease. @param {any} db @param {string} id @param {string} token */
export async function heartbeat(db, id, token) {
  const rows =
    await db`update integration_events set heartbeat_at=now(),lease_expires_at=now()+interval '30 seconds' where id=${id} and lease_token=${token} and status='processing' and lease_expires_at>now() returning id`;
  return rows.length === 1;
}
/** @param {any} t @param {any} row @param {any} result @param {Record<string,string|undefined>|undefined} env */
async function acknowledge(t, row, result, env) {
  if (
    result.effectId !== row.event_id ||
    result.payloadHash !== row.payload_hash ||
    result.correlationId !== row.correlation_id
  )
    throw new SapFailure("conflict", false);
  const [locked] =
    await t`select * from integration_events where id=${row.id} and lease_token=${row.lease_token} and status='processing' and lease_expires_at>now() for update`;
  if (!locked) return false;
  // Finite, code-owned table mapping. Never use provider-supplied table names/SQL.
  if (row.source_type === "order")
    await t`update orders set sap_document_number=${result.documentNumber} where id=${row.source_id}::uuid`;
  if (row.source_type === "van_sale")
    await t`update van_sales set sap_document_number=${result.documentNumber} where id=${row.source_id}::uuid`;
  if (row.source_type === "van_payment")
    await t`update van_payments set sap_document_number=${result.documentNumber} where id=${row.source_id}::uuid`;
  if (row.source_type === "van_return")
    await t`update van_returns set sap_document_number=${result.documentNumber} where id=${row.source_id}::uuid`;
  if (row.source_type === "van_void")
    await t`update van_sale_voids set sap_document_number=${result.documentNumber} where id=${row.source_id}::uuid`;
  if (row.source_type === "movement")
    await t`update inventory_movements set sap_document_number=${result.documentNumber} where id=${row.source_id}::uuid`;
  if (row.source_type === "van_trip")
    await t`update van_trips set sap_settlement_document_number=${result.documentNumber} where id=${row.source_id}::uuid`;
  await acknowledgeSpecPosting(t, row, result, env);
  await t`update integration_events set status='completed',processed_at=now(),acknowledged_at=now(),external_document_number=${result.documentNumber},sap_result=${result},last_error=null,error_class=null,lease_token=null,lease_expires_at=null where id=${row.id}`;
  await resolution(t, row.id, "acknowledged", {
    documentNumber: result.documentNumber,
    payloadHash: row.payload_hash,
  });
  return true;
}
/** @param {any} db @param {any} row @param {any} error */
async function failed(db, row, error) {
  const category = error instanceof SapFailure ? error.category : "transport";
  const retryable = error instanceof SapFailure ? error.retryable : true;
  const dead = !retryable || row.attempts >= MAX_ATTEMPTS;
  await tx(db, async (t) => {
    const [current] =
      await t`select id from integration_events where id=${row.id} and lease_token=${row.lease_token} and status='processing' for update`;
    if (!current) return;
    await t`update integration_events set status=${dead ? "dead_letter" : "failed"},error_class=${category},last_error=${`SAP ${category}; ${dead ? "operator action required" : "automatic retry scheduled"}`},next_attempt_at=${new Date(Date.now() + backoffMs(row.attempts))},lease_token=null,lease_expires_at=null where id=${row.id}`;
    await resolution(t, row.id, dead ? "dead_letter" : "retry_scheduled", {
      category,
      attempt: row.attempts,
    });
  });
}
/** F-003: query SAP by immutable effect ID before every retry. A lost HTTP response or local ack is not permission to create another SAP document.
 * @param {any} db @param {{env?:Record<string,string|undefined>,limit?:number}} [opts]
 */
export async function runOutbox(db, opts = {}) {
  const claimed = await claimPostings(db, opts.limit);
  // Heartbeat every claimed row, including rows waiting behind a slow request.
  const timers = claimed.map((row) =>
    setInterval(() => {
      void heartbeat(db, row.id, row.lease_token).catch(() => {});
    }, LEASE_MS / 3),
  );
  try {
    for (const row of claimed) {
      try {
        try {
          validate(row.event_type, row.payload);
        } catch {
          throw new SapFailure("contract", false);
        }
        if (
          payloadHash(row.payload) !== row.payload_hash ||
          row.payload.effectId !== row.event_id ||
          row.payload.correlationId !== row.correlation_id
        )
          throw new SapFailure("conflict", false);
        let result = await sapRequest(
          db,
          `/v1/postings/${encodeURIComponent(row.event_id)}`,
          { schema: "postingResult", allow404: true, env: opts.env },
        );
        if (!result)
          result = await sapRequest(db, `/v1/postings/${row.event_type}`, {
            body: row.payload,
            schema: "postingResult",
            env: opts.env,
          });
        await tx(db, (t) => acknowledge(t, row, result, opts.env));
      } catch (e) {
        await failed(db, row, e);
      }
    }
  } finally {
    timers.forEach(clearInterval);
  }
  return claimed.length;
}
