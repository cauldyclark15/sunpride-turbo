// @ts-check
/**
 * Territories and routes. Row shapes for migration 0101_territories.sql.
 * Tables: territories, territory_ownerships, territory_salespeople, routes, route_territories, route_salespeople.
 * Field names are camelCase versions of the snake_case columns. Instants are
 * Date (date columns too: UTC midnight of the Manila day), uuid/text are string, and
 * bigint/numeric come back as string from Bun.sql.
 */

export const TERRITORY_STATUS = /** @type {const} */ (["active", "inactive"]);
export const TERRITORY_SALESPEOPLE_KIND = /** @type {const} */ (["primary", "secondary"]);
export const ROUTE_STATUS = /** @type {const} */ (["active", "inactive"]);

/**
 * `territories` (Convex `territories`)
 * @typedef {Object} TerritoryRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} code
 * @property {string} name
 * @property {string | null} channel
 * @property {string | null} boundaryGeoJson
 * @property {"active" | "inactive"} status
 * @property {Date} effectiveFrom
 * @property {Date | null} effectiveTo
 * @property {string} createdBy
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `territory_ownerships` (Convex `territoryOwnerships`)
 * @typedef {Object} TerritoryOwnershipRow
 * @property {string} id
 * @property {string} territoryId
 * @property {string} orgUnitId
 * @property {Date} effectiveFrom
 * @property {Date | null} effectiveTo
 * @property {string} actorSubject
 * @property {string} reason
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `territory_salespeople` (Convex `territorySalespeople`)
 * @typedef {Object} TerritorySalespeopleRow
 * @property {string} id
 * @property {string} territoryId
 * @property {string} profileId
 * @property {"primary" | "secondary" | null} kind
 * @property {Date} effectiveFrom
 * @property {Date | null} effectiveTo
 * @property {string} actorSubject
 * @property {string} reason
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `routes` (Convex `routes`)
 * @typedef {Object} RouteRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} code
 * @property {string} name
 * @property {"active" | "inactive"} status
 * @property {Date} effectiveFrom
 * @property {Date | null} effectiveTo
 * @property {number[]} weekdayTemplate
 * @property {number | null} cycleDays
 * @property {string} createdBy
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `route_territories` (Convex `routeTerritories`)
 * @typedef {Object} RouteTerritoryRow
 * @property {string} id
 * @property {string} routeId
 * @property {string} territoryId
 * @property {Date} effectiveFrom
 * @property {Date | null} effectiveTo
 * @property {string} actorSubject
 * @property {string} reason
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `route_salespeople` (Convex `routeSalespeople`)
 * @typedef {Object} RouteSalespeopleRow
 * @property {string} id
 * @property {string} routeId
 * @property {string} profileId
 * @property {boolean} isPrimary
 * @property {Date} effectiveFrom
 * @property {Date | null} effectiveTo
 * @property {string} actorSubject
 * @property {string} reason
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

export {};
