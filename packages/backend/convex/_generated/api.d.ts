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
import type * as integration_sap from "../integration/sap.js";
import type * as inventory_adjustments from "../inventory/adjustments.js";
import type * as inventory_constants from "../inventory/constants.js";
import type * as inventory_counts from "../inventory/counts.js";
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
import type * as lib_metrics from "../lib/metrics.js";
import type * as migrations from "../migrations.js";
import type * as seed from "../seed.js";

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
  "integration/sap": typeof integration_sap;
  "inventory/adjustments": typeof inventory_adjustments;
  "inventory/constants": typeof inventory_constants;
  "inventory/counts": typeof inventory_counts;
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
  "lib/metrics": typeof lib_metrics;
  migrations: typeof migrations;
  seed: typeof seed;
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
