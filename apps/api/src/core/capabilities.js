import { ApiError, forbidden, unauthenticated } from "./errors.js";
import { hooks, unitInScope } from "./hooks.js";

/**
 * Capability gate (ADR-009), enforced by the Bun API with the frozen baseline grants.
 * Endpoints ask for a CAPABILITY, never a job title or bare role string.
 */

/** @typedef {'super_admin'|'admin'|'operations'|'manager'|'approver'|'sales'|'analyst'|'viewer'} AppRole */

/** @type {readonly AppRole[]} */
export const ROLES = Object.freeze([
  "super_admin",
  "admin",
  "operations",
  "manager",
  "approver",
  "sales",
  "analyst",
  "viewer",
]);
/** Roles an administrator may grant. `super_admin` is bootstrap-only. */
export const ASSIGNABLE_ROLES = Object.freeze(
  ROLES.filter((r) => r !== "super_admin"),
);
export const EMPLOYMENT_TYPES = Object.freeze([
  "sfi_employee",
  "adp_personnel",
  "third_party",
]);

/** @type {readonly AppRole[]} */
const ALL = ROLES;

/** @type {Readonly<Record<string, readonly AppRole[]>>} */
export const CAPABILITIES = Object.freeze({
  "integrity.read": ["super_admin", "admin", "manager", "analyst"],
  "integrity.review": ["super_admin", "admin", "manager"],
  "admin.manage": ["super_admin", "admin"],
  "org.read": ALL,
  "people.read": ["super_admin", "admin", "manager", "analyst", "viewer"],
  "territory.read": ALL,
  "route.read": ALL,
  "outlet.read": ALL,
  "territory.manage": ["super_admin", "admin"],
  "route.manage": ["super_admin", "admin", "operations"],
  "outlet.manage": ["super_admin", "admin", "operations"],
  "outlet.verify": ["super_admin", "admin", "manager"],
  "outlet.enrol.propose": ["super_admin", "manager", "sales"],
  "outlet.enrol.approve": ["super_admin", "manager"],
  "outlet.assign": ["super_admin", "admin", "operations"],
  "masterdata.manage": ["super_admin", "admin", "operations"],
  "inventory.read": ALL,
  "inventory.write": ["super_admin", "admin", "operations"],
  "inventory.approve": ["super_admin", "approver"],
  "inventory.adjustment.request": [
    "super_admin",
    "admin",
    "operations",
    "manager",
  ],
  "inventory.count.submit": ["super_admin", "admin", "operations", "manager"],
  "inventory.adjustment.approve": [
    "super_admin",
    "admin",
    "manager",
    "approver",
  ],
  "inventory.count.approve": ["super_admin", "admin", "manager", "approver"],
  "mcp.read": ALL,
  "mcp.plan": ["super_admin", "admin", "manager", "sales"],
  "mcp.approve": ["super_admin", "manager"],
  "visit.record": ["super_admin", "manager", "sales"],
  // F-209/F-222: attendance is not permission to start location tracking.
  "workforce.read": ALL,
  "workforce.record": ["super_admin", "manager", "sales"],
  "workforce.configure": ["super_admin", "admin", "operations"],
  "workforce.import": ["super_admin", "admin", "operations"],
  "workforce.correct": [
    "super_admin",
    "admin",
    "operations",
    "manager",
    "sales",
  ],
  "workforce.approve": ["super_admin", "manager"],
  // F-210: owner/manager win-back actions on cycle-based dormancy cases.
  "dormancy.act": ["super_admin", "admin", "manager"],
  // F-615: a cascade is published only by a different person than its preparer.
  "target.approve": ["super_admin", "manager", "approver"],
  // F-613: plan collections (promises, cheques, collector routes) on SAP AR open items.
  "collections.plan": ["super_admin", "admin", "manager"],
  "collections.capture": ["super_admin", "manager", "sales"],
  "visit.locationException.approve": ["super_admin", "manager"],
  "visit.read": ALL,
  "order.create": ["super_admin", "manager", "sales"],
  "location.read": [
    "super_admin",
    "admin",
    "operations",
    "manager",
    "sales",
    "analyst",
  ],
  "order.approve": ["super_admin", "manager", "approver"],
  "order.encode": ["super_admin", "admin", "operations"],
  "deliverable.submit": ["super_admin", "manager", "sales"],
  "deliverable.review": ["super_admin", "manager"],
  "perdiem.submit": ["super_admin", "manager", "sales"],
  "perdiem.approve": ["super_admin", "manager", "approver"],
  "report.read": ALL,
  "target.manage": ["super_admin", "admin", "manager"],
  "integration.read": ["super_admin", "admin", "operations"],
  "integration.manage": ["super_admin", "admin"],
  "issues.read": ALL,
  "issues.write": ALL,
  "issues.triage": [
    "super_admin",
    "admin",
    "operations",
    "manager",
    "approver",
  ],
  "issues.manage": ["super_admin", "admin"],
  "van.read": ALL,
  "van.manage": ["super_admin", "admin", "operations"],
  "van.operate": ["super_admin", "manager", "sales"],
  "van.load.approve": ["super_admin", "manager", "approver"],
  "van.damage.approve": ["super_admin", "manager", "approver"],
  "van.void.approve": ["super_admin", "manager", "approver"],
  "van.cash.approve": ["super_admin", "manager", "approver"],
  "van.stock.approve": ["super_admin", "manager", "approver"],
});

/** Unscoped tester-feedback writes read-only roles may hold. */
export const TESTER_FEEDBACK_CAPABILITIES = Object.freeze(["issues.write"]);
/** Cross-scope roles read the whole organization (and only read, by their capability list). */
export const CROSS_SCOPE_ROLES = Object.freeze(["super_admin", "analyst"]);

/** @param {string} capability */
export const isReadOnlyCapability = (capability) =>
  capability.endsWith(".read");
/** @param {string} value */
export const isCapability = (value) => Object.hasOwn(CAPABILITIES, value);
/** @param {string} value @returns {value is AppRole} */
export const isRole = (value) =>
  /** @type {readonly string[]} */ (ROLES).includes(value);

/** Does `role` hold `capability`? super_admin holds every capability. @param {string} role @param {string} capability */
export function roleHas(role, capability) {
  const allowed = CAPABILITIES[capability];
  if (!allowed) return false;
  return (
    role === "super_admin" ||
    /** @type {readonly string[]} */ (allowed).includes(role)
  );
}

/** Capability names a role holds. @param {string} role @returns {string[]} */
export function capabilitiesFor(role) {
  return Object.keys(CAPABILITIES).filter((c) => roleHas(role, c));
}

/**
 * Throws unless the caller's role holds the capability AND, when a target unit is given, that
 * unit sits inside the caller's subtree. super_admin/analyst skip the unit check only when
 * they hold the capability. Omitting targetUnitId checks permission ONLY.
 * @param {{ db: any, actor: import('./context.js').Actor|null }} ctx
 * @param {string} capability
 * @param {string|null} [targetUnitId]
 * @returns {Promise<import('./context.js').Actor>}
 */
export async function requireCapability(ctx, capability, targetUnitId) {
  if (!isCapability(capability))
    throw new ApiError("internal", 500, `Unknown capability: ${capability}`);
  const actor = ctx.actor;
  if (!actor) throw unauthenticated();
  if (!roleHas(actor.role, capability))
    throw forbidden("Insufficient permission");
  if (!targetUnitId || CROSS_SCOPE_ROLES.includes(actor.role)) return actor;
  if (!actor.orgUnitId)
    throw forbidden("Your access has no organizational scope", "no_scope");
  if (!(await unitInScope(ctx.db, actor, targetUnitId)))
    throw forbidden(
      "Requested scope is outside your organizational scope",
      "out_of_scope",
    );
  return actor;
}

/**
 * Legacy role + optional target gate (`lib/scope.ts` requireScopedRole): only super_admin bypasses.
 * @param {{ db: any, actor: import('./context.js').Actor|null }} ctx
 * @param {readonly string[]} allowed
 * @param {string|null} [targetUnitId]
 */
export async function requireScopedRole(ctx, allowed, targetUnitId) {
  const actor = ctx.actor;
  if (!actor) throw unauthenticated();
  if (actor.role !== "super_admin" && !allowed.includes(actor.role))
    throw forbidden("Insufficient permission");
  if (!targetUnitId || actor.role === "super_admin") return actor;
  if (!actor.orgUnitId)
    throw forbidden("Your access has no organizational scope", "no_scope");
  if (!(await unitInScope(ctx.db, actor, targetUnitId)))
    throw forbidden(
      "Requested scope is outside your organizational scope",
      "out_of_scope",
    );
  return actor;
}

/**
 * National data gate (`lib/scope.ts` requireNationalScope): non-super_admin must sit at the root.
 * @param {{ db: any, actor: import('./context.js').Actor|null }} ctx
 * @param {readonly string[]} allowed
 */
export async function requireNationalScope(ctx, allowed) {
  const actor = ctx.actor;
  if (!actor) throw unauthenticated();
  if (actor.role !== "super_admin" && !allowed.includes(actor.role))
    throw forbidden("Insufficient permission");
  if (actor.role === "super_admin") return actor;
  if (!actor.orgUnitId)
    throw forbidden("Your access has no organizational scope", "no_scope");
  const root = await hooks.rootUnitId(ctx.db);
  if (!root || actor.orgUnitId !== root)
    throw forbidden(
      "Requested scope is outside your organizational scope",
      "out_of_scope",
    );
  return actor;
}
