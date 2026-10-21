import { currentActor } from "../van/access.js";
import { currentPartnerActor } from "../distributors/identity.js";
/** F-404/F-511 financial identity is an employee OR an explicitly granted partner, never a forged role. @param {any} db @param {any} actor */
export const currentFinancialActor = (db, actor) =>
  actor?.role === "distributor"
    ? currentPartnerActor(db, actor, "order")
    : currentActor(db, actor);
