import { enqueueSapPosting } from "./outbox.js";
import { invalid } from "../../core/errors.js";
import { payloadHash } from "../../../../../packages/integration-contracts/sap/v1/index.js";

/** F-117/F-119: only the settlement sign-off path invokes this adapter, in its business transaction.
 * One immutable version is one SAP effect; it never relabels queueing as acknowledgement.
 * @param {any} db @param {string} settlementId */
export async function enqueueApprovedVanSettlement(db, settlementId) {
  const [s] =
    await db`select s.*,t.org_unit_id from van_settlements s join van_trips t on t.id=s.trip_id where s.id=${settlementId} and t.status='closed' and exists(select 1 from van_settlement_decisions d where d.settlement_id=s.id and d.decision='approved' and d.actor_profile_id<>s.submitted_by and d.actor_profile_id<>t.salesperson_profile_id)`;
  if (!s)
    throw invalid(
      "Only an independently approved closed settlement can be posted",
    );
  if (payloadHash(s.facts) !== s.content_hash)
    throw invalid("Settlement source digest changed");
  const [old] =
    await db`select depends_on from integration_events where event_id=${`settlement:van_settlement:${s.id}`}`;
  const parents = old
    ? []
    : await db`select e.event_id from integration_events e where e.event_type<>'settlement' and (
   e.payload->'document'->'facts'->>'tripId'=${s.trip_id}::text or
   e.source_type='movement' and e.movement_id in(select m.id from inventory_movements m where m.source_document_id=${s.trip_id} or m.source_document_id in(select id::text from van_trip_observations where trip_id=${s.trip_id}) or m.source_document_id in(select id::text from van_sales where trip_id=${s.trip_id}) or m.source_document_id in(select id::text from van_returns where trip_id=${s.trip_id}) or m.id in(select d.movement_id from van_reconciliation_changes c join van_reconciliation_decisions d on d.change_id=c.id and d.decision='approved' where c.trip_id=${s.trip_id}))) order by e.event_id`;
  const result = await enqueueSapPosting(db, {
    kind: "settlement",
    sourceType: "van_settlement",
    sourceId: s.id,
    orgUnitId: s.org_unit_id,
    dependsOn:
      old?.depends_on ?? parents.map((/** @type {any} */ r) => r.event_id),
    document: {
      sourceType: "van_settlement",
      sourceId: s.id,
      customerCode: null,
      currency: "PHP",
      amountCentavos: null,
      occurredAt: new Date(s.captured_at).getTime(),
      lines: [],
      facts: {
        tripId: s.trip_id,
        version: s.version,
        contentHash: s.content_hash,
        settlement: s.facts,
      },
    },
  });
  return result;
}
