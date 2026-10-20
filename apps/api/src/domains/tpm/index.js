import { registerTopic } from "../../core/hooks.js";
import { installCampaigns } from "./campaigns.js";
import { installWorkspace } from "./workspace.js";
import { installClaims } from "./claims.js";
import { installFinance } from "./finance.js";
import { installDeductions } from "./deductions.js";
import { installEvaluations } from "./evaluations.js";
/** @param {any} router */
export function install(router) {
  registerTopic("tpm", (actor) => actor.role !== "sales");
  installCampaigns(router);
  installWorkspace(router);
  installClaims(router);
  installFinance(router);
  installDeductions(router);
  installEvaluations(router);
}
