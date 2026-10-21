import { office } from "./common.js";
import {
  enqueueTpmPosting,
  authorizeClaimant,
  readEligibilityFacts,
  readPartnerEvidence,
} from "../integration/spec-adapters.js";
import { authorizeCampaignQuote } from "./authority.js";
import { readPromotionPerformance } from "./performance.js";
import { readIncentiveMetrics } from "./metric-sources.js";

/** SEAM(SAP): operational instructions await enqueueSapPosting; no synthetic SAP acknowledgement.
 * SEAM(FISCAL): requestOverride must authorize exact transaction facts; no local discount matrix.
 * SEAM(DISTRIBUTOR/MT/PROGRAMME): party grants and authoritative evidence, never caller assertions.
 * SEAM(TOWER): versioned governed KPI snapshots for incentives and ROI. */
export const seams = {
  /** @param {any} _c @param {any} _q @returns {Promise<any>} */
  readEligibilityFacts,
  /** @param {any} _db @param {any} _instruction @returns {Promise<{postingId:string}|null>} */
  enqueueSapPosting: enqueueTpmPosting,
  /** @param {any} _c @param {any} _facts @returns {Promise<{status:string,reference?:string}>} */
  requestOverride: authorizeCampaignQuote,
  /** @param {any} c @param {string} _type @param {string} _id */
  authorizeClaimant,
  /** @param {any} _c @param {string} _kind @param {string} _id @returns {Promise<any>} */
  readEvidence: readPartnerEvidence,
  /** @param {any} _c @param {any} _q @returns {Promise<any>} */
  readIncentiveMetrics,
  /** SEAM(TOWER/SAP): complete benefit spend (invoice/rebate/valued goods), source and completeness
   * accompany baseline, margin and definition-version facts; earnings are not total spend.
   * @param {any} _c @param {any} _q @returns {Promise<any>} */
  readPromotionPerformance,
};
/** Owner adapters are installed once at integration; tests replace only these named seams.
 * @param {Partial<typeof seams>} adapters */
export function setTpmSeams(adapters) {
  Object.assign(seams, adapters);
}
