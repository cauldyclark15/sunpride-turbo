import { v } from "convex/values";

/**
 * Access roles (ADR-009). A role is a permission set, never a job title — the client's
 * positions (KAS, DS, CDM, ...) are rows in `positions` and carry the standards.
 *
 * `manager` is the sales-supervisor tier (Sales Head, SCDM, CDM, DS/CDS) and is relabelled
 * in the UI only; the literal is kept so existing `requireRole` call sites keep working.
 */
export const roleValidator = v.union(
  v.literal("super_admin"),
  v.literal("admin"),
  v.literal("operations"),
  v.literal("manager"),
  v.literal("approver"),
  v.literal("sales"),
  v.literal("analyst"),
  v.literal("viewer"),
);

export type AppRole =
  | "super_admin"
  | "admin"
  | "operations"
  | "manager"
  | "approver"
  | "sales"
  | "analyst"
  | "viewer";

/** Roles an administrator may grant. `super_admin` is bootstrap-only (ADR-009). */
export const assignableRoleValidator = v.union(
  v.literal("admin"),
  v.literal("operations"),
  v.literal("manager"),
  v.literal("approver"),
  v.literal("sales"),
  v.literal("analyst"),
  v.literal("viewer"),
);

export type AssignableRole =
  | "admin"
  | "operations"
  | "manager"
  | "approver"
  | "sales"
  | "analyst"
  | "viewer";

/**
 * How the person relates to Sunpride. ADP personnel are a third party that Sunpride
 * supervises (memo §III) — they are modelled before they are ever given a login.
 */
export const employmentTypeValidator = v.union(
  v.literal("sfi_employee"),
  v.literal("adp_personnel"),
  v.literal("third_party"),
);

export type EmploymentType = "sfi_employee" | "adp_personnel" | "third_party";
