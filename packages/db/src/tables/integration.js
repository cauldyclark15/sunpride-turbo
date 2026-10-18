// @ts-check
/**
 * SAP integration events and snapshots. Row shapes for migration 0108_integration.sql.
 * Tables: sap_inventory_snapshots, integration_events, connector_heartbeats.
 * Field names are camelCase versions of the snake_case columns. Instants are
 * Date (date columns too: UTC midnight of the Manila day), uuid/text are string, and
 * bigint/numeric come back as string from Bun.sql.
 */

export const SAP_INVENTORY_SNAPSHOT_RESOLUTION_STATUS = /** @type {const} */ (["pending", "matched", "different", "unmapped"]);
export const INTEGRATION_EVENT_DIRECTION = /** @type {const} */ (["inbound", "outbound"]);
export const INTEGRATION_EVENT_STATUS = /** @type {const} */ (["pending", "processing", "completed", "failed", "dead_letter"]);
export const CONNECTOR_HEARTBEAT_STATUS = /** @type {const} */ (["online", "degraded", "offline"]);

/**
 * `sap_inventory_snapshots` (Convex `sapInventorySnapshots`)
 * @typedef {Object} SapInventorySnapshotRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} productCode
 * @property {string} warehouseCode
 * @property {string | null} productId
 * @property {string | null} locationId
 * @property {string} onHandBase
 * @property {string} reservedBase
 * @property {string} availableBase
 * @property {Date} asOf
 * @property {string} sourceEventId
 * @property {string | null} sourceSequence
 * @property {string | null} payloadHash
 * @property {"pending" | "matched" | "different" | "unmapped"} resolutionStatus
 * @property {Date} receivedAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `integration_events` (Convex `integrationEvents`)
 * @typedef {Object} IntegrationEventRow
 * @property {string} id
 * @property {string} eventId
 * @property {"inbound" | "outbound"} direction
 * @property {string} eventType
 * @property {"pending" | "processing" | "completed" | "failed" | "dead_letter"} status
 * @property {number} attempts
 * @property {unknown} payload
 * @property {Date} receivedAt
 * @property {Date | null} processedAt
 * @property {string | null} lastError
 * @property {string | null} organizationId
 * @property {number | null} schemaVersion
 * @property {string | null} payloadHash
 * @property {string | null} correlationId
 * @property {string | null} causationId
 * @property {string | null} sourceDocumentId
 * @property {string | null} movementId
 * @property {Date | null} nextAttemptAt
 * @property {Date | null} acknowledgedAt
 * @property {string | null} externalDocumentNumber
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `connector_heartbeats` (Convex `connectorHeartbeats`)
 * @typedef {Object} ConnectorHeartbeatRow
 * @property {string} id
 * @property {string} connectorId
 * @property {"online" | "degraded" | "offline"} status
 * @property {string} adapter
 * @property {Date} lastSeenAt
 * @property {string | null} details
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

export {};
