// @ts-check
/**
 * Daily rollups, agent metrics, targets, admin pack. Row shapes for migration 0114_analytics.sql.
 * Tables: daily_territory_metrics, daily_customer_metrics, daily_sku_metrics, rollup_contributions, rollup_contribution_skus, rollup_refreshes, agent_daily_metrics, agent_metric_refreshes, suggested_order_promotions, admin_pack_records, sales_targets.
 * Field names are camelCase versions of the snake_case columns. Instants are
 * Date (date columns too: UTC midnight of the Manila day), uuid/text are string, and
 * bigint/numeric come back as string from Bun.sql.
 */

export const ROLLUP_CONTRIBUTION_SOURCE_KIND = /** @type {const} */ ([
  "order",
  "visit",
  "planned",
]);
export const ROLLUP_REFRESHE_SOURCE_KIND = /** @type {const} */ ([
  "order",
  "visit",
  "planned",
]);
export const ADMIN_PACK_RECORD_SOURCE = /** @type {const} */ ([
  "sample",
  "office",
]);
export const ADMIN_PACK_RECORD_KIND = /** @type {const} */ ([
  "program_allocation",
  "priority_document",
  "adp_claim",
  "ar_balance",
]);
export const SALES_TARGET_SUBJECT_KIND = /** @type {const} */ ([
  "employee",
  "team",
  "territory",
]);
export const SALES_TARGET_PERIOD = /** @type {const} */ (["daily", "monthly"]);
export const SALES_TARGET_METRIC = /** @type {const} */ ([
  "sales_value",
  "calls",
  "productive_calls",
]);

/**
 * `daily_territory_metrics`
 * @typedef {Object} DailyTerritoryMetricRow
 * @property {string} id
 * @property {string} organizationId
 * @property {Date} serviceDate
 * @property {string} orgUnitId
 * @property {string} territoryId
 * @property {number} plannedCalls
 * @property {number} plannedCallsDone
 * @property {number} visits
 * @property {number} completedVisits
 * @property {number} unplannedVisits
 * @property {number} calls
 * @property {number} productiveCalls
 * @property {number} collections
 * @property {string} collectionsMinor
 * @property {number} orders
 * @property {string} salesMinor
 * @property {number} returnOrders
 * @property {string} returnsMinor
 * @property {number} buyingCustomers
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `daily_customer_metrics`
 * @typedef {Object} DailyCustomerMetricRow
 * @property {string} id
 * @property {string} organizationId
 * @property {Date} serviceDate
 * @property {string} orgUnitId
 * @property {string} customerCode
 * @property {string | null} customerId
 * @property {string | null} territoryId
 * @property {number} plannedCalls
 * @property {number} plannedCallsDone
 * @property {number} visits
 * @property {number} completedVisits
 * @property {number} unplannedVisits
 * @property {number} calls
 * @property {number} productiveCalls
 * @property {number} collections
 * @property {string} collectionsMinor
 * @property {number} orders
 * @property {string} salesMinor
 * @property {number} returnOrders
 * @property {string} returnsMinor
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `daily_sku_metrics`
 * @typedef {Object} DailySkuMetricRow
 * @property {string} id
 * @property {string} organizationId
 * @property {Date} serviceDate
 * @property {string} orgUnitId
 * @property {string} productCode
 * @property {number} orders
 * @property {string} quantity
 * @property {string} salesMinor
 * @property {number} returnOrders
 * @property {string} returnQuantity
 * @property {string} returnsMinor
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `rollup_contributions`
 * @typedef {Object} RollupContributionRow
 * @property {string} id
 * @property {"order" | "visit" | "planned"} sourceKind
 * @property {string} sourceId
 * @property {Date} serviceDate
 * @property {string} orgUnitId
 * @property {string | null} territoryId
 * @property {string | null} customerCode
 * @property {string | null} customerId
 * @property {number} metricsPlannedCalls
 * @property {number} metricsPlannedCallsDone
 * @property {number} metricsVisits
 * @property {number} metricsCompletedVisits
 * @property {number} metricsUnplannedVisits
 * @property {number} metricsCalls
 * @property {number} metricsProductiveCalls
 * @property {number} metricsCollections
 * @property {string} metricsCollectionsMinor
 * @property {number} metricsOrders
 * @property {string} metricsSalesMinor
 * @property {number} metricsReturnOrders
 * @property {string} metricsReturnsMinor
 * @property {boolean} complete
 * @property {string} version
 * @property {Date} computedAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `rollup_contribution_skus` (child of `rollup_contributions`)
 * @typedef {Object} RollupContributionSkuRow
 * @property {string} id
 * @property {string} rollupContributionId
 * @property {number} ordinal
 * @property {string} productCode
 * @property {number} orders
 * @property {string} quantity
 * @property {string} salesMinor
 * @property {number} returnOrders
 * @property {string} returnQuantity
 * @property {string} returnsMinor
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `rollup_refreshes`
 * @typedef {Object} RollupRefresheRow
 * @property {string} id
 * @property {"order" | "visit" | "planned"} sourceKind
 * @property {string} sourceId
 * @property {Date} requestedAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `agent_daily_metrics`
 * @typedef {Object} AgentDailyMetricRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} profileId
 * @property {Date} serviceDate
 * @property {string} localMonth
 * @property {string | null} orgUnitId
 * @property {string | null} positionId
 * @property {number} plannedCalls
 * @property {number} calls
 * @property {number} productiveCalls
 * @property {number} nonproductiveCalls
 * @property {number | null} productivePct
 * @property {number} plannedNotVisited
 * @property {number} visits
 * @property {number} unplannedVisits
 * @property {number} openVisits
 * @property {number} skippedVisits
 * @property {number} lateSyncVisits
 * @property {number} visitsMissingActivities
 * @property {string} callDurationMs
 * @property {number} timedVisits
 * @property {Date | null} firstStartAt
 * @property {Date | null} lastEndAt
 * @property {number} orders
 * @property {number} returnOrders
 * @property {number} buyingAccounts
 * @property {string} salesValue
 * @property {number} collections
 * @property {number} collectionsPendingReview
 * @property {string} collectionsValue
 * @property {number | null} dailyCallsTarget
 * @property {number | null} productiveCallTargetPct
 * @property {boolean} complete
 * @property {string} ruleVersion
 * @property {string} metricsVersion
 * @property {Date} computedAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `agent_metric_refreshes`
 * @typedef {Object} AgentMetricRefresheRow
 * @property {string} id
 * @property {string} profileId
 * @property {Date} serviceDate
 * @property {Date} requestedAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `suggested_order_promotions`
 * @typedef {Object} SuggestedOrderPromotionRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} productId
 * @property {string} programRef
 * @property {number} upliftPct
 * @property {Date} effectiveFrom
 * @property {Date | null} effectiveTo
 * @property {string} sourceRef
 * @property {string} actorSubject
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `admin_pack_records`
 * @typedef {Object} AdminPackRecordRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} orgUnitId
 * @property {string} period
 * @property {"sample" | "office"} source
 * @property {string} code
 * @property {"program_allocation" | "priority_document" | "adp_claim" | "ar_balance"} kind
 * @property {Record<string, unknown>} details
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `sales_targets`
 * @typedef {Object} SalesTargetRow
 * @property {string} id
 * @property {string} organizationId
 * @property {"employee" | "team" | "territory"} subjectKind
 * @property {string | null} profileId
 * @property {string | null} teamId
 * @property {string | null} territoryId
 * @property {"daily" | "monthly"} period
 * @property {"sales_value" | "calls" | "productive_calls"} metric
 * @property {string} value
 * @property {Date} effectiveFrom
 * @property {Date | null} effectiveTo
 * @property {string} sourceRef
 * @property {string | null} notes
 * @property {string} createdBy
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

export {};
