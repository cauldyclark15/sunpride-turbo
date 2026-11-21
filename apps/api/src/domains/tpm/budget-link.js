/** F-501 (loosened, SP-0231): a promotion may be activated with or without a campaign budget.
 * When a campaign is given it is still linked and governed by the budget rules elsewhere; no campaign is not refused.
 * Kept as a seam so pricing routes keep one call site. @param {string} _status @param {string|null} _campaign
 * @param {any} _previous @param {Date} _from @param {Date|null} _to */
export function requireCampaignLink(_status, _campaign, _previous, _from, _to) {}
