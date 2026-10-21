import { eligibility } from "../tpm/engine.js";
/** F-218/F-219: planning uses the SAME active campaign and scheme eligibility as checkout.
 * Uplift is an explicit governed planning assumption, never inferred from a discount percentage.
 * @param {any[]} promotions @param {any} facts @param {string} productId @param {boolean} sampleOutlet */
export function campaignPlanning(promotions, facts, productId, sampleOutlet) {
  return promotions
    .filter((p) => {
      const units =
        p.rule.components ??
        (p.rule.buy ? [p.rule.buy] : p.rule.item ? [p.rule.item] : []);
      return (
        p.campaign_version_id &&
        (!p.planning_sample || sampleOutlet) &&
        (!units.length ||
          units.some((/** @type {any} */ u) => u.productId === productId)) &&
        eligibility(p.eligibility, facts).eligible &&
        eligibility(p.campaign_scope, facts).eligible
      );
    })
    .map((p) => ({
      id: p.id,
      campaignVersionId: p.campaign_version_id,
      name: p.name,
      objective:
        p.rule.planningObjective ??
        `Consider ${p.name}; confirm its qualifying purchase at checkout`,
      upliftPct: p.rule.demandUpliftPct ?? 0,
      sample: p.planning_sample === true,
    }));
}
