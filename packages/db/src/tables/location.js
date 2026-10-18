// @ts-check
/**
 * Location pings and live positions. Row shapes for migration 0116_location.sql.
 * Tables: location_pings, live_locations.
 * Field names are camelCase versions of the snake_case columns. Instants are
 * Date (date columns too: UTC midnight of the Manila day), uuid/text are string, and
 * bigint/numeric come back as string from Bun.sql.
 */

export const LOCATION_PING_KIND = /** @type {const} */ (["field", "van"]);
export const LOCATION_PING_PROVIDER = /** @type {const} */ (["gps", "network", "fused", "unknown"]);
export const LOCATION_PING_TRIGGER = /** @type {const} */ (["start", "moving", "still", "stop"]);
export const LIVE_LOCATION_KIND = /** @type {const} */ (["field", "van"]);
export const LIVE_LOCATION_PROVIDER = /** @type {const} */ (["gps", "network", "fused", "unknown"]);
export const LIVE_LOCATION_TRIGGER = /** @type {const} */ (["start", "moving", "still", "stop"]);

/**
 * `location_pings` (Convex `locationPings`)
 * @typedef {Object} LocationPingRow
 * @property {string} id
 * @property {string} organizationId
 * @property {"field" | "van"} kind
 * @property {string} profileId
 * @property {string | null} deviceId
 * @property {string} clientPingId
 * @property {string} orgUnitId
 * @property {string | null} vehicleId
 * @property {string | null} tripId
 * @property {string | null} visitId
 * @property {Date} serviceDate
 * @property {number} latitude
 * @property {number} longitude
 * @property {number} accuracyMeters
 * @property {number | null} speedMetersPerSecond
 * @property {number | null} headingDegrees
 * @property {number | null} batteryPercent
 * @property {boolean} mockLocation
 * @property {"gps" | "network" | "fused" | "unknown"} provider
 * @property {"start" | "moving" | "still" | "stop"} trigger
 * @property {Date} recordedAt
 * @property {Date} receivedAt
 * @property {boolean | null} sample
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `live_locations` (Convex `liveLocations`)
 * @typedef {Object} LiveLocationRow
 * @property {string} id
 * @property {string} organizationId
 * @property {"field" | "van"} kind
 * @property {string} subjectKey
 * @property {string} profileId
 * @property {string | null} deviceId
 * @property {string} orgUnitId
 * @property {string | null} vehicleId
 * @property {string | null} tripId
 * @property {string | null} visitId
 * @property {Date} serviceDate
 * @property {number} latitude
 * @property {number} longitude
 * @property {number} accuracyMeters
 * @property {number | null} speedMetersPerSecond
 * @property {number | null} headingDegrees
 * @property {number | null} batteryPercent
 * @property {boolean} mockLocation
 * @property {"gps" | "network" | "fused" | "unknown"} provider
 * @property {"start" | "moving" | "still" | "stop"} trigger
 * @property {Date} recordedAt
 * @property {Date} receivedAt
 * @property {boolean} trackingEnded
 * @property {boolean | null} sample
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

export {};
