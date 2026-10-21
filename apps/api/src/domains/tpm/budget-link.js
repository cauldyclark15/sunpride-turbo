import { fail } from "../orders/validation.js";
/** F-501: every newly activated financial scheme belongs to a governed campaign budget.
 * Retained legacy schemes may only keep/reduce their existing window, never reactivate or extend it.
 * @param {string} status @param {string|null} campaign @param {any} previous @param {Date} from @param {Date|null} to */
export function requireCampaignLink(status, campaign, previous, from, to) {
  if (status !== "active" || campaign) return;
  const legacy =
    previous &&
    previous.status === "active" &&
    !previous.campaign_version_id &&
    +new Date(previous.effective_from) === +from &&
    (previous.effective_to == null ||
      (to != null && +to <= +new Date(previous.effective_to)));
  if (!legacy)
    fail(
      "Select an approved campaign budget before activating a new promotion",
    );
}
