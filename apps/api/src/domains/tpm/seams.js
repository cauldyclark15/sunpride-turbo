import { office } from "./common.js";
import { fail } from "../orders/validation.js";

/** SEAM(SAP): operational instructions await enqueueSapPosting; no synthetic SAP acknowledgement.
 * SEAM(FISCAL): requestOverride must authorize exact transaction facts; no local discount matrix.
 * SEAM(DISTRIBUTOR/MT/PROGRAMME): party grants and authoritative evidence, never caller assertions.
 * SEAM(TOWER): versioned governed KPI snapshots for incentives and ROI. */
export const seams = {
  /** @param {any} _c @param {any} _q @returns {Promise<any>} */
  async readEligibilityFacts(_c, _q) {
    return {};
  },
  /** @param {any} _db @param {any} _instruction @returns {Promise<{postingId:string}|null>} */
  async enqueueSapPosting(_db, _instruction) {
    return null;
  },
  /** @param {any} _c @param {any} _facts @returns {Promise<{status:string,reference?:string}>} */
  async requestOverride(_c, _facts) {
    return { status: "needs_setup" };
  },
  /** @param {any} c @param {string} _type @param {string} _id */
  async authorizeClaimant(c, _type, _id) {
    await office(c, "order.encode");
  },
  /** @param {any} _c @param {string} _kind @param {string} _id @returns {Promise<any>} */
  async readEvidence(_c, _kind, _id) {
    return null;
  },
  /** @param {any} _c @param {any} _q @returns {Promise<any>} */
  async readIncentiveMetrics(_c, _q) {
    fail("Governed incentive metrics are not connected", "needs_setup");
  },
  /** SEAM(TOWER/SAP): complete benefit spend (invoice/rebate/valued goods), source and completeness
   * accompany baseline, margin and definition-version facts; earnings are not total spend.
   * @param {any} _c @param {any} _q @returns {Promise<any>} */
  async readPromotionPerformance(_c, _q) {
    fail(
      "Promotion baseline, complete SAP spend and margin feeds are not connected",
      "needs_setup",
    );
  },
};
/** Owner adapters are installed once at integration; tests replace only these named seams.
 * @param {Partial<typeof seams>} adapters */
export function setTpmSeams(adapters) {
  Object.assign(seams, adapters);
}
