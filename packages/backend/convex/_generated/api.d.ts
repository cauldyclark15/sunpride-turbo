/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as authPolicy from "../authPolicy.js";
import type * as crons from "../crons.js";
import type * as domains_admin from "../domains/admin.js";
import type * as domains_dashboard from "../domains/dashboard.js";
import type * as domains_inventory from "../domains/inventory.js";
import type * as domains_masterData from "../domains/masterData.js";
import type * as domains_orders from "../domains/orders.js";
import type * as domains_profiles from "../domains/profiles.js";
import type * as domains_salesForce from "../domains/salesForce.js";
import type * as domains_workflows from "../domains/workflows.js";
import type * as http from "../http.js";
import type * as imports_adjustments from "../imports/adjustments.js";
import type * as imports_counts from "../imports/counts.js";
import type * as imports_openingStock from "../imports/openingStock.js";
import type * as imports_operational from "../imports/operational.js";
import type * as imports_operational_history from "../imports/operational_history.js";
import type * as imports_products from "../imports/products.js";
import type * as imports_runs from "../imports/runs.js";
import type * as imports_shared from "../imports/shared.js";
import type * as imports_test_helpers from "../imports/test_helpers.js";
import type * as integration_sap from "../integration/sap.js";
import type * as inventory_adjustments from "../inventory/adjustments.js";
import type * as inventory_constants from "../inventory/constants.js";
import type * as inventory_counts from "../inventory/counts.js";
import type * as inventory_location_scope from "../inventory/location_scope.js";
import type * as inventory_manufacturing from "../inventory/manufacturing.js";
import type * as inventory_policies from "../inventory/policies.js";
import type * as inventory_pos from "../inventory/pos.js";
import type * as inventory_posting from "../inventory/posting.js";
import type * as inventory_quality from "../inventory/quality.js";
import type * as inventory_queries from "../inventory/queries.js";
import type * as inventory_receipts from "../inventory/receipts.js";
import type * as inventory_reconciliation from "../inventory/reconciliation.js";
import type * as inventory_replenishment from "../inventory/replenishment.js";
import type * as inventory_reservations from "../inventory/reservations.js";
import type * as inventory_setup from "../inventory/setup.js";
import type * as inventory_transfers from "../inventory/transfers.js";
import type * as inventory_validators from "../inventory/validators.js";
import type * as lib_access from "../lib/access.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_capabilities from "../lib/capabilities.js";
import type * as lib_metrics from "../lib/metrics.js";
import type * as lib_roles from "../lib/roles.js";
import type * as lib_scope from "../lib/scope.js";
import type * as migrations from "../migrations.js";
import type * as org_mutations from "../org/mutations.js";
import type * as org_queries from "../org/queries.js";
import type * as org_validation from "../org/validation.js";
import type * as outlets_mutations from "../outlets/mutations.js";
import type * as outlets_queries from "../outlets/queries.js";
import type * as outlets_validation from "../outlets/validation.js";
import type * as outlets_verification from "../outlets/verification.js";
import type * as people_mutations from "../people/mutations.js";
import type * as people_queries from "../people/queries.js";
import type * as people_validation from "../people/validation.js";
import type * as seed from "../seed.js";
import type * as sfa_constants from "../sfa/constants.js";
import type * as sfa_positions from "../sfa/positions.js";
import type * as sfa_setup from "../sfa/setup.js";
import type * as teams_mutations from "../teams/mutations.js";
import type * as teams_queries from "../teams/queries.js";
import type * as teams_validation from "../teams/validation.js";
import type * as territories_mutations from "../territories/mutations.js";
import type * as territories_queries from "../territories/queries.js";
import type * as territories_validation from "../territories/validation.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  authPolicy: typeof authPolicy;
  crons: typeof crons;
  "domains/admin": typeof domains_admin;
  "domains/dashboard": typeof domains_dashboard;
  "domains/inventory": typeof domains_inventory;
  "domains/masterData": typeof domains_masterData;
  "domains/orders": typeof domains_orders;
  "domains/profiles": typeof domains_profiles;
  "domains/salesForce": typeof domains_salesForce;
  "domains/workflows": typeof domains_workflows;
  http: typeof http;
  "imports/adjustments": typeof imports_adjustments;
  "imports/counts": typeof imports_counts;
  "imports/openingStock": typeof imports_openingStock;
  "imports/operational": typeof imports_operational;
  "imports/operational_history": typeof imports_operational_history;
  "imports/products": typeof imports_products;
  "imports/runs": typeof imports_runs;
  "imports/shared": typeof imports_shared;
  "imports/test_helpers": typeof imports_test_helpers;
  "integration/sap": typeof integration_sap;
  "inventory/adjustments": typeof inventory_adjustments;
  "inventory/constants": typeof inventory_constants;
  "inventory/counts": typeof inventory_counts;
  "inventory/location_scope": typeof inventory_location_scope;
  "inventory/manufacturing": typeof inventory_manufacturing;
  "inventory/policies": typeof inventory_policies;
  "inventory/pos": typeof inventory_pos;
  "inventory/posting": typeof inventory_posting;
  "inventory/quality": typeof inventory_quality;
  "inventory/queries": typeof inventory_queries;
  "inventory/receipts": typeof inventory_receipts;
  "inventory/reconciliation": typeof inventory_reconciliation;
  "inventory/replenishment": typeof inventory_replenishment;
  "inventory/reservations": typeof inventory_reservations;
  "inventory/setup": typeof inventory_setup;
  "inventory/transfers": typeof inventory_transfers;
  "inventory/validators": typeof inventory_validators;
  "lib/access": typeof lib_access;
  "lib/auth": typeof lib_auth;
  "lib/capabilities": typeof lib_capabilities;
  "lib/metrics": typeof lib_metrics;
  "lib/roles": typeof lib_roles;
  "lib/scope": typeof lib_scope;
  migrations: typeof migrations;
  "org/mutations": typeof org_mutations;
  "org/queries": typeof org_queries;
  "org/validation": typeof org_validation;
  "outlets/mutations": typeof outlets_mutations;
  "outlets/queries": typeof outlets_queries;
  "outlets/validation": typeof outlets_validation;
  "outlets/verification": typeof outlets_verification;
  "people/mutations": typeof people_mutations;
  "people/queries": typeof people_queries;
  "people/validation": typeof people_validation;
  seed: typeof seed;
  "sfa/constants": typeof sfa_constants;
  "sfa/positions": typeof sfa_positions;
  "sfa/setup": typeof sfa_setup;
  "teams/mutations": typeof teams_mutations;
  "teams/queries": typeof teams_queries;
  "teams/validation": typeof teams_validation;
  "territories/mutations": typeof territories_mutations;
  "territories/queries": typeof territories_queries;
  "territories/validation": typeof territories_validation;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
};
