import { eligibility, validateScope, ENGINE_VERSION } from "./engine.js";
import { changed, command, office, bounded } from "./common.js";
import {
  choice,
  fail,
  instant,
  integer,
  text,
  uuid,
} from "../orders/validation.js";
import { outletContext } from "../orders/access.js";
import { seams } from "./seams.js";

/** F-503 canonical outlet facts; quote callers cannot assert a different class/territory.
 * SEAM(MASTERS): class/geography adapter will adopt canonical taxonomy keys after integration.
 * SEAM(DISTRIBUTOR): distributor identity is deliberately null until the membership owner supplies it.
 * @param {any} c @param {any} input */
export async function eligibilityFacts(c, input) {
  if (!input.outletId) return { channelKey: input.channelKey ?? null };
  const { outlet, assignment } = await outletContext(c, uuid(input.outletId));
  const external = await seams.readEligibilityFacts(c, {
    outletId: outlet.id,
    at: input.at ?? c.now,
  });
  return {
    outletId: outlet.id,
    channelKey: outlet.channel,
    classKey: external.classKey ?? outlet.classification ?? null,
    territoryId: assignment?.territory_id ?? null,
    geographyKey: external.geographyKey ?? null,
    distributorId: external.distributorId ?? null,
  };
}
/** @param {any} r */
export const campaignView = (r) => ({
  id: r.campaign_id,
  versionId: r.id,
  version: r.version,
  code: r.code,
  name: r.name,
  mechanic: r.mechanic,
  status: r.status,
  effectiveFrom: new Date(r.effective_from).getTime(),
  effectiveTo: new Date(r.effective_to).getTime(),
  scope: r.scope,
  checklist: r.checklist,
  budgetCentavos: Number(r.budget_centavos),
  committedCentavos: Number(r.committed ?? 0),
  expectedVolumeBase: Number(r.expected_volume_base),
  expectedRoiBps: r.expected_roi_bps,
  source: r.source,
});
/** @param {any} c @param {any} b */
export async function saveCampaign(c, b) {
  const code = text(b.code, "Campaign code", 80),
    name = text(b.name, "Campaign name", 160),
    mechanic = text(b.mechanic, "Mechanic", 160);
  const from = instant(b.effectiveFrom),
    to = instant(b.effectiveTo);
  if (to <= from) fail("End must follow start");
  const scope = validateScope(b.scope ?? {});
  const checklist = b.checklist ?? [];
  if (!Array.isArray(checklist) || checklist.length > 50)
    fail("Checklist has at most 50 items");
  checklist.forEach((/** @type {any} */ x) => text(x, "Checklist item", 200));
  const budget = integer(b.budgetCentavos ?? 0),
    volume = integer(b.expectedVolumeBase ?? 0),
    roi = integer(b.expectedRoiBps ?? 0, "Expected ROI", 1_000_000);
  const status = choice(
    b.status ?? "draft",
    ["draft", "active", "closed"],
    "Campaign status",
  );
  await c.db`select pg_advisory_xact_lock(hashtextextended(${"tpm:campaign:" + code},0))`;
  let [master] =
    await c.db`select * from campaigns where organization_id='sunpride' and code=${code} for update`;
  if (!master)
    [master] =
      await c.db`insert into campaigns(code) values(${code}) returning *`;
  const [old] =
    await c.db`select * from campaign_versions where campaign_id=${master.id} order by version desc limit 1`;
  if (old) {
    if (from.getTime() < c.now || from <= new Date(old.effective_from))
      fail("New versions must start prospectively after the previous version");
    await c.db`update campaign_versions set effective_to=least(effective_to,${from}),updated_at=now() where id=${old.id}`;
  }
  const [spent] =
    await c.db`select coalesce(sum(amount_centavos),0) as n from campaign_commitments where campaign_id=${master.id}`;
  if (budget < Number(spent.n))
    fail("Budget cannot be below existing commitments");
  const [row] =
    await c.db`insert into campaign_versions(campaign_id,version,name,mechanic,status,effective_from,effective_to,scope,checklist,budget_centavos,expected_volume_base,expected_roi_bps,source,created_by)
    values(${master.id},${(old?.version ?? 0) + 1},${name},${mechanic},${status},${from},${to},${scope},${checklist},${budget},${volume},${roi},'office',${c.actor.subject}) returning *`;
  await changed(c, "campaign.saved", row.id, { code, version: row.version });
  return campaignView({ ...row, code, committed: spent.n });
}
/** @param {any} c @param {any} b */
export async function commitBudget(c, b) {
  const id = uuid(b.campaignVersionId),
    amount = integer(b.amountCentavos),
    key = text(b.sourceKey, "Commitment source", 160);
  if (!amount) fail("Commitment must be positive");
  const [v] =
    await c.db`select v.* from campaign_versions v join campaigns m on m.id=v.campaign_id where v.id=${id} and m.organization_id='sunpride' for update of m`;
  if (
    !v ||
    v.status !== "active" ||
    new Date(v.effective_from).getTime() > c.now ||
    new Date(v.effective_to).getTime() <= c.now
  )
    fail("Choose an active campaign version");
  const [existing] =
    await c.db`select * from campaign_commitments where campaign_id=${v.campaign_id} and source_key=${key}`;
  if (existing) {
    if (
      Number(existing.amount_centavos) !== amount ||
      existing.campaign_version_id !== id
    )
      fail("Commitment source conflicts");
    return { id: existing.id };
  }
  const [sum] =
    await c.db`select coalesce(sum(amount_centavos),0) as n from campaign_commitments where campaign_id=${v.campaign_id}`;
  if (BigInt(sum.n) + BigInt(amount) > BigInt(v.budget_centavos))
    fail("Campaign budget would be exceeded");
  const [r] =
    await c.db`insert into campaign_commitments(campaign_id,campaign_version_id,source_key,amount_centavos,created_by) values(${v.campaign_id},${id},${key},${amount},${c.actor.subject}) returning id`;
  await changed(c, "budget.committed", r.id, { amountCentavos: amount });
  return { id: r.id };
}
/** @param {any} router */
export function installCampaigns(router) {
  router.get("/api/v1/tpm/campaigns", async (/** @type {any} */ c) => {
    await office(c);
    const rows = bounded(
      await c.db`select v.*,m.code,(select coalesce(sum(amount_centavos),0) from campaign_commitments where campaign_id=m.id) as committed from campaign_versions v join campaigns m on m.id=v.campaign_id where m.organization_id='sunpride' order by m.code,v.version desc limit 501`,
    );
    return { rows: rows.map(campaignView) };
  });
  router.post("/api/v1/tpm/campaigns/save", (/** @type {any} */ c) =>
    command(
      c,
      "campaign.save",
      c.body,
      (cc) => office(cc, "masterdata.manage"),
      (cc) => saveCampaign(cc, c.body),
    ),
  );
  router.post("/api/v1/tpm/budget/commit", (/** @type {any} */ c) =>
    command(
      c,
      "budget.commit",
      c.body,
      (cc) => office(cc, "masterdata.manage"),
      (cc) => commitBudget(cc, c.body),
    ),
  );
  router.post("/api/v1/tpm/eligibility", async (/** @type {any} */ c) => {
    const facts = await eligibilityFacts(c, c.body);
    // Without an outlet this is the national simulator, not a partner-scope bypass.
    if (!c.body.outletId) await office(c);
    const at = c.now;
    const rows = bounded(
      await c.db`select p.*,v.scope as campaign_scope from promotions p left join campaign_versions v on v.id=p.campaign_version_id where p.organization_id='sunpride' and p.status='active' and p.deleted_at is null and p.effective_from<=${new Date(at)} and (p.effective_to is null or p.effective_to>${new Date(at)}) and (v.id is null or (v.status='active' and v.effective_from<=${new Date(at)} and v.effective_to>${new Date(at)})) order by p.precedence,p.code limit 501`,
    );
    return {
      engineVersion: ENGINE_VERSION,
      asOf: at,
      rows: rows.map((p) => ({
        id: p.id,
        code: p.code,
        name: p.name,
        eligible:
          eligibility(p.campaign_scope ?? {}, facts).eligible &&
          eligibility(p.eligibility, facts).eligible,
        reasons: [
          ...eligibility(p.campaign_scope ?? {}, facts).reasons,
          ...eligibility(p.eligibility, facts).reasons,
        ],
      })),
    };
  });
}
