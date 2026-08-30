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
