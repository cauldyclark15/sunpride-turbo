import { roleHas } from "../../core/capabilities.js";
import { installIntake } from "./intake.js";
import { installTerms } from "./terms.js";
import { installDeductions } from "./deductions.js";
import { installPortal } from "./portal.js";
import { installSettings } from "./settings.js";
/** F-306 / F-307 / F-309 / F-611. @param {any} router @param {any} platform */
export function install(router, platform) {
  platform.registerTopic(
    "mt",
    (/** @type {any} */ actor, /** @type {string} */ topic) =>
      topic === "mt" && roleHas(actor.role, "report.read"),
  );
  installIntake(router);
  installTerms(router);
  installDeductions(router);
  installPortal(router);
  installSettings(router);
}
