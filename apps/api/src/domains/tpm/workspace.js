import { sourceDay } from "./claim-source-options.js";
import { office, bounded } from "./common.js";
/** F-501/F-505 web pickers expose labels; UUIDs remain transport-only.
 * @param {any} router */
export function installWorkspace(router) {
  router.get("/api/v1/tpm/options", async (/** @type {any} */ c) => {
    await office(c);
    const products = bounded(
      await c.db`select id,code,name,uom from products where active and deleted_at is null and (organization_id='sunpride' or organization_id is null) order by code limit 501`,
    );
    const outlets = bounded(
      await c.db`select id,code,name from outlets where organization_id='sunpride' and deleted_at is null and status='active' order by code limit 501`,
    );
    const territories = bounded(
      await c.db`select id,code,name from territories where organization_id='sunpride' and deleted_at is null and status='active' order by code limit 501`,
    );
    const people = bounded(
      await c.db`select id,name from profiles where status='active' and deleted_at is null order by name limit 501`,
    );
    const parties = bounded(
      await c.db`select * from (select id,name,partner_kind as type from distributors where status not in ('suspended','rejected') and effective_from<=now() and (effective_to is null or effective_to>now()) union all select id,label as name,'modern_trade' as type from mt_account_bindings where effective_from<=now() and (effective_to is null or effective_to>now()))parties order by name limit 501`,
    );
    const evidence =
      await c.db`select e.id,e.outlet_id,o.name as outlet_name,e.captured_at as occurred_at,'photo'::text as kind from field_evidence_files e join outlets o on o.id=e.outlet_id join files f on f.id=e.storage_id where e.organization_id='sunpride' and e.deleted_at is null and f.status='stored' and e.status<>'rejected' order by e.captured_at desc limit 101`;
    return {
      products,
      territories,
      outlets,
      people,
      parties,
      evidenceTruncated: evidence.length > 100,
      evidence: evidence.slice(0, 100).map((/** @type {any} */ e) => ({
        id: e.id,
        label: `Photo · ${e.outlet_name} · ${sourceDay(e.occurred_at)}`,
        kind: e.kind,
      })),
    };
  });
  router.get("/api/v1/tpm/summary", async (/** @type {any} */ c) => {
    await office(c);
    const now = new Date(c.now);
    const [campaigns] =
      await c.db`select coalesce(sum(v.budget_centavos),0) as budget,
      coalesce(sum((select coalesce(sum(amount_centavos),0) from campaign_commitment_balances where campaign_id=v.campaign_id)),0) as committed
      from campaign_versions v where v.status='active' and v.effective_from<=${now} and v.effective_to>${now}`;
    const [claims] =
      await c.db`select count(*) filter(where status in ('submitted','needs_evidence'))::integer as awaiting,
      count(*) filter(where status='validated')::integer as approvals,
      count(*) filter(where status='rejected')::integer as rejected,count(*)::integer as total,
      coalesce(sum(amount_centavos) filter(where created_at>=${new Date(c.now - 14 * 86400_000)}),0) as current,
      coalesce(sum(amount_centavos) filter(where created_at<${new Date(c.now - 14 * 86400_000)} and created_at>=${new Date(c.now - 28 * 86400_000)}),0) as prior from claims`;
    const trend =
      await c.db`select (created_at at time zone 'Asia/Manila')::date::text as date,sum(amount_centavos) as amount from claims where created_at>=${new Date(c.now - 28 * 86400_000)} group by 1 order by 1`;
    return {
      asOf: c.now,
      budgetCentavos: Number(campaigns.budget),
      committedCentavos: Number(campaigns.committed),
      claimsAwaitingEvidence: claims.awaiting,
      claimsAwaitingApproval: claims.approvals,
      rejectionBps: claims.total
        ? Math.round((claims.rejected * 10000) / claims.total)
        : null,
      claimsCurrentCentavos: Number(claims.current),
      claimsPriorCentavos: Number(claims.prior),
      trend: trend.map((/** @type {any} */ r) => ({
        date: r.date,
        amountCentavos: Number(r.amount),
      })),
    };
  });
}
