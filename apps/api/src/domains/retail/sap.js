import { enqueueSapPosting } from "../integration/outbox.js";
import { sapConfig } from "../integration/transport.js";
import { invalid } from "../../core/errors.js";

/** F-320: approved shelf actions use the existing durable SAP gateway, never a local valuation ledger.
 * SAP acknowledges the requested action; actual recovery/return is still recorded separately.
 * @param {any} c @param {any} input */
export async function requestRetailAction(c, input) {
  const [row] =
    await c.db`select r.*,a.captured_at,a.master_version_id from retail_action_cases r join retail_execution_audits a on a.id=r.audit_id
    where r.id=${input.caseId} for update of r`;
  if (!row || !["pullout", "markdown"].includes(row.kind))
    throw invalid("Shelf action not found");
  const [sample] =
    await c.db`select 1 from sample_data_rows where (table_name='outlets' and row_id=${row.outlet_id}::text)
    or (table_name='retail_master_versions' and row_id=${row.master_version_id}::text) limit 1`;
  if (sample && sapConfig(c.db, c.env).mode !== "mock")
    throw invalid("Sample shelf actions cannot post to real SAP");
  const customers =
    await c.db`select c.code from outlet_customer_links l join customers c on c.id=l.customer_id and c.deleted_at is null where l.outlet_id=${row.outlet_id} and l.deleted_at is null and l.effective_from<=now() and (l.effective_to is null or l.effective_to>now()) limit 2`;
  const customer = customers.length === 1 ? customers[0] : null;
  const result = await enqueueSapPosting(c.db, {
    kind: row.kind === "pullout" ? "goods_movement" : "credit_memo",
    sourceType: "retail_case",
    sourceId: row.id,
    effectId: `retail-action:${row.id}`,
    document: {
      sourceType: "retail_case",
      sourceId: row.id,
      customerCode: customer?.code ?? null,
      currency: "PHP",
      amountCentavos: null,
      occurredAt: +new Date(row.captured_at),
      lines: [],
      facts: {
        action: row.kind,
        outletId: row.outlet_id,
        observation: row.facts,
        instructionOnly: true,
        sourceMode: sample ? "sample" : "operational",
      },
    },
  });
  if (result.quarantined)
    throw invalid("Shelf action posting content conflicts");
  const [event] =
    await c.db`select status from integration_events where id=${result.id}`;
  return {
    status: event.status === "completed" ? "acknowledged" : "queued",
    postingId: result.id,
  };
}

/** F-320: only the verified SAP inbox advances the waiting office case.
 * Duplicate delivery cannot append duplicate status events or reopen closed cases.
 * @param {any} db @param {any} row @param {any} result */
export async function acknowledgeRetailAction(db, row, result) {
  if (row.source_type !== "retail_case") return;
  const [c] =
    await db`select * from retail_action_cases where id=${row.source_id} for update`;
  if (!c || !["pullout", "markdown"].includes(c.kind))
    throw invalid("Shelf posting source missing");
  if (c.status !== "awaiting_sap") return;
  await db`update retail_action_cases set status='approved',updated_at=now() where id=${c.id}`;
  await db`insert into retail_case_events(case_id,kind,note,reference,actor_subject)
    values(${c.id},'sap.acknowledged','SAP acknowledged the shelf-action instruction; record recovery separately.',${result.documentNumber},'system:sap')`;
}
