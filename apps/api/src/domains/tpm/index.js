import { registerTopic } from "../../core/hooks.js";
import { installCampaigns } from "./campaigns.js";
/** @param {any} router */
export function install(router) {
  registerTopic("tpm", (actor) => actor.role !== "sales");
  installCampaigns(router);
}
