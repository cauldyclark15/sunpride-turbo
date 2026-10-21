import { registerTopic } from "../../core/hooks.js";
import { installCampaigns } from "./campaigns.js";
import { installWorkspace } from "./workspace.js";
import { installClaims } from "./claims.js";
import { installFinance } from "./finance.js";
import { installReconciliation } from "./reconciliation.js";
import { installDeductions } from "./deductions.js";
import { installEvaluations } from "./evaluations.js";
import { installClaimantPortals } from "./portal.js";
import { installClaimNotifications } from "./notifications.js";
/** @param {any} router @param {any} ctx */
export function install(router, ctx) {
  registerTopic("tpm", (actor) => actor.role !== "sales");
  installCampaigns(router);
  installWorkspace(router);
  installClaims(router);
  installClaimantPortals(router);
  installClaimNotifications(router, ctx);
  installFinance(router);
  installReconciliation(ctx);
  installDeductions(router);
  installEvaluations(router);
}
