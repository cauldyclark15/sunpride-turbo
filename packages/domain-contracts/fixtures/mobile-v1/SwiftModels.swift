// CONTRACT TEXT FIXTURE — explicitly mapped from mobile-v1.schema.json; not native application code.
// All paths below are schema paths. Optional omission differs from explicit null.
// JSONValue and OptionalField stand for a real platform JSON AST / presence-aware decoder.
import Foundation
typealias JSONValue = Any
struct OptionalField<T> { let isPresent: Bool; let value: T? }
// OpenEnum preserves unknown server enum values; unknown values must disable transitions.
struct OpenEnum: Codable { let rawValue: String }
// schema-object: bootstrapRequest
struct BootstrapRequest {
  // schema-field: bootstrapRequest.type
  let type: String
  // schema-field: bootstrapRequest.contractVersion
  let contractVersion: Int64
  // schema-field: bootstrapRequest.deviceId
  let deviceId: String
  // schema-field: bootstrapRequest.dayFrom
  let dayFrom: OptionalField<String>
  // schema-field: bootstrapRequest.pageCursor
  let pageCursor: OptionalField<String>
  // schema-field: bootstrapRequest.limit
  let limit: OptionalField<Int64>
}
// schema-object: bootstrapResponse
struct BootstrapResponse {
  // schema-field: bootstrapResponse.type
  let type: String
  // schema-field: bootstrapResponse.contractVersion
  let contractVersion: Int64
  // schema-field: bootstrapResponse.serverTime
  let serverTime: Int64
  // schema-field: bootstrapResponse.permissions
  let permissions: [String]
  // schema-field: bootstrapResponse.employee
  let employee: BootstrapResponseEmployee
  // schema-field: bootstrapResponse.scope
  let scope: BootstrapResponseScope
  // schema-field: bootstrapResponse.appConfig
  let appConfig: BootstrapResponseAppConfig
  // schema-field: bootstrapResponse.plannedVisits
  let plannedVisits: [BootstrapResponsePlannedVisitsItem]
  // schema-field: bootstrapResponse.outlets
  let outlets: [BootstrapResponseOutletsItem]
  // schema-field: bootstrapResponse.localCustomers
  let localCustomers: [BootstrapResponseLocalCustomersItem]
  // schema-field: bootstrapResponse.route
  let route: BootstrapResponseRouteVariant0?
  // schema-field: bootstrapResponse.tasks
  let tasks: [BootstrapResponseTasksItem]
  // schema-field: bootstrapResponse.productCatalog
  let productCatalog: [BootstrapResponseProductCatalogItem]
  // schema-field: bootstrapResponse.page
  let page: Int64
  // schema-field: bootstrapResponse.nextPageCursor
  let nextPageCursor: String?
  // schema-field: bootstrapResponse.syncCursor
  let syncCursor: String?
}
// schema-object: bootstrapResponse.employee
struct BootstrapResponseEmployee {
  // schema-field: bootstrapResponse.employee.id
  let id: String
  // schema-field: bootstrapResponse.employee.role
  let role: String
  // schema-field: bootstrapResponse.employee.orgUnitId
  let orgUnitId: String
}
// schema-object: bootstrapResponse.scope
struct BootstrapResponseScope {
  // schema-field: bootstrapResponse.scope.fingerprint
  let fingerprint: String
  // schema-field: bootstrapResponse.scope.orgUnitIds
  let orgUnitIds: [String]
}
// schema-object: bootstrapResponse.appConfig
struct BootstrapResponseAppConfig {
  // schema-field: bootstrapResponse.appConfig.offlineLeaseExpiresAt
  let offlineLeaseExpiresAt: Int64
  // schema-field: bootstrapResponse.appConfig.cacheExpiresAt
  let cacheExpiresAt: Int64
  // schema-field: bootstrapResponse.appConfig.orderCaptureEnabled
  let orderCaptureEnabled: Bool
  // schema-field: bootstrapResponse.appConfig.priceAvailability
  let priceAvailability: String
  // schema-field: bootstrapResponse.appConfig.promotionsAvailability
  let promotionsAvailability: String
}
// schema-object: bootstrapResponse.plannedVisits[]
struct BootstrapResponsePlannedVisitsItem {
  // schema-field: bootstrapResponse.plannedVisits[].id
  let id: String
  // schema-field: bootstrapResponse.plannedVisits[].outletId
  let outletId: String
  // schema-field: bootstrapResponse.plannedVisits[].serviceDate
  let serviceDate: String
  // schema-field: bootstrapResponse.plannedVisits[].planId
  let planId: String
  // schema-field: bootstrapResponse.plannedVisits[].planVersion
  let planVersion: Int64
  // schema-field: bootstrapResponse.plannedVisits[].intents
  let intents: [String]
}
// schema-object: bootstrapResponse.outlets[]
struct BootstrapResponseOutletsItem {
  // schema-field: bootstrapResponse.outlets[].id
  let id: String
  // schema-field: bootstrapResponse.outlets[].name
  let name: String
  // schema-field: bootstrapResponse.outlets[].routeId
  let routeId: String?
}
// schema-object: bootstrapResponse.localCustomers[]
struct BootstrapResponseLocalCustomersItem {
  // schema-field: bootstrapResponse.localCustomers[].id
  let id: String
  // schema-field: bootstrapResponse.localCustomers[].code
  let code: String
}
// schema-object: bootstrapResponse.route#0
struct BootstrapResponseRouteVariant0 {
  // schema-field: bootstrapResponse.route#0.id
  let id: String
  // schema-field: bootstrapResponse.route#0.code
  let code: String
}
// schema-object: bootstrapResponse.tasks[]
struct BootstrapResponseTasksItem {
  // schema-field: bootstrapResponse.tasks[].id
  let id: String
  // schema-field: bootstrapResponse.tasks[].kind
  let kind: String
  // schema-field: bootstrapResponse.tasks[].required
  let required: Bool
}
// schema-object: bootstrapResponse.productCatalog[]
struct BootstrapResponseProductCatalogItem {
  // schema-field: bootstrapResponse.productCatalog[].id
  let id: String
  // schema-field: bootstrapResponse.productCatalog[].code
  let code: String
  // schema-field: bootstrapResponse.productCatalog[].name
  let name: String
  // schema-field: bootstrapResponse.productCatalog[].uom
  let uom: String
}
// schema-object: pullRequest
struct PullRequest {
  // schema-field: pullRequest.type
  let type: String
  // schema-field: pullRequest.contractVersion
  let contractVersion: Int64
  // schema-field: pullRequest.deviceId
  let deviceId: String
  // schema-field: pullRequest.cursor
  let cursor: String
  // schema-field: pullRequest.limit
  let limit: Int64
}
// schema-object: pullResponse
struct PullResponse {
  // schema-field: pullResponse.type
  let type: String
  // schema-field: pullResponse.contractVersion
  let contractVersion: Int64
  // schema-field: pullResponse.serverTime
  let serverTime: Int64
  // schema-field: pullResponse.changes
  let changes: [PullResponseChangesItem]
  // schema-field: pullResponse.nextCursor
  let nextCursor: String
  // schema-field: pullResponse.hasMore
  let hasMore: Bool
}
// schema-object: pullResponse.changes[]
struct PullResponseChangesItem {
  // schema-field: pullResponse.changes[].seq
  let seq: Int64
  // schema-field: pullResponse.changes[].entity
  let entity: String
  // schema-field: pullResponse.changes[].id
  let id: String
  // schema-field: pullResponse.changes[].revision
  let revision: Int64
  // schema-field: pullResponse.changes[].op
  let op: PullResponseChangesItemOpEnum
  // schema-field: pullResponse.changes[].value
  let value: OptionalField<JSONValue>
}
// schema-object: pushRequest
struct PushRequest {
  // schema-field: pushRequest.type
  let type: String
  // schema-field: pushRequest.contractVersion
  let contractVersion: Int64
  // schema-field: pushRequest.deviceId
  let deviceId: String
  // schema-field: pushRequest.operations
  let operations: [JSONValue]
}
// schema-object: pushRequest.operations[]#0
struct PushRequestOperationsItemVariant0 {
  // schema-field: pushRequest.operations[]#0.kind
  let kind: String
  // schema-field: pushRequest.operations[]#0.clientRequestId
  let clientRequestId: String
  // schema-field: pushRequest.operations[]#0.dependsOn
  let dependsOn: OptionalField<[String]>
  // schema-field: pushRequest.operations[]#0.payload
  let payload: PushRequestOperationsItemVariant0Payload
}
// schema-object: pushRequest.operations[]#0.payload
struct PushRequestOperationsItemVariant0Payload {
  // schema-field: pushRequest.operations[]#0.payload.clientVisitId
  let clientVisitId: String
  // schema-field: pushRequest.operations[]#0.payload.plannedVisitId
  let plannedVisitId: String?
  // schema-field: pushRequest.operations[]#0.payload.outletId
  let outletId: String
  // schema-field: pushRequest.operations[]#0.payload.serviceDate
  let serviceDate: String
  // schema-field: pushRequest.operations[]#0.payload.deviceTime
  let deviceTime: Int64
  // schema-field: pushRequest.operations[]#0.payload.location
  let location: PushRequestOperationsItemVariant0PayloadLocationVariant0?
  // schema-field: pushRequest.operations[]#0.payload.unplannedReason
  let unplannedReason: OptionalField<String>
  // schema-field: pushRequest.operations[]#0.payload.intents
  let intents: [PushRequestOperationsItemVariant0PayloadIntentsItemEnum]
}
// schema-object: pushRequest.operations[]#0.payload.location#0
struct PushRequestOperationsItemVariant0PayloadLocationVariant0 {
  // schema-field: pushRequest.operations[]#0.payload.location#0.latitude
  let latitude: Double
  // schema-field: pushRequest.operations[]#0.payload.location#0.longitude
  let longitude: Double
  // schema-field: pushRequest.operations[]#0.payload.location#0.accuracyMeters
  let accuracyMeters: Double
  // schema-field: pushRequest.operations[]#0.payload.location#0.provider
  let provider: PushRequestOperationsItemVariant0PayloadLocationVariant0ProviderEnum
  // schema-field: pushRequest.operations[]#0.payload.location#0.mockSignal
  let mockSignal: OptionalField<Bool>
  // schema-field: pushRequest.operations[]#0.payload.location#0.fixTime
  let fixTime: Int64
}
// schema-object: pushRequest.operations[]#1
struct PushRequestOperationsItemVariant1 {
  // schema-field: pushRequest.operations[]#1.kind
  let kind: String
  // schema-field: pushRequest.operations[]#1.clientRequestId
  let clientRequestId: String
  // schema-field: pushRequest.operations[]#1.dependsOn
  let dependsOn: OptionalField<[String]>
  // schema-field: pushRequest.operations[]#1.payload
  let payload: PushRequestOperationsItemVariant1Payload
}
// schema-object: pushRequest.operations[]#1.payload
struct PushRequestOperationsItemVariant1Payload {
  // schema-field: pushRequest.operations[]#1.payload.visitId
  let visitId: String
  // schema-field: pushRequest.operations[]#1.payload.activity
  let activity: JSONValue
  // schema-field: pushRequest.operations[]#1.payload.deviceTime
  let deviceTime: Int64
}
// schema-object: pushRequest.operations[]#1.payload.activity#0
struct PushRequestOperationsItemVariant1PayloadActivityVariant0 {
  // schema-field: pushRequest.operations[]#1.payload.activity#0.kind
  let kind: String
  // schema-field: pushRequest.operations[]#1.payload.activity#0.productId
  let productId: String
  // schema-field: pushRequest.operations[]#1.payload.activity#0.icoFinding
  let icoFinding: PushRequestOperationsItemVariant1PayloadActivityVariant0IcoFindingEnum
  // schema-field: pushRequest.operations[]#1.payload.activity#0.observedQuantity
  let observedQuantity: OptionalField<Double?>
}
// schema-object: pushRequest.operations[]#1.payload.activity#1
struct PushRequestOperationsItemVariant1PayloadActivityVariant1 {
  // schema-field: pushRequest.operations[]#1.payload.activity#1.kind
  let kind: String
  // schema-field: pushRequest.operations[]#1.payload.activity#1.displayCondition
  let displayCondition: PushRequestOperationsItemVariant1PayloadActivityVariant1DisplayConditionEnum
  // schema-field: pushRequest.operations[]#1.payload.activity#1.actionTaken
  let actionTaken: OptionalField<String>
}
// schema-object: pushRequest.operations[]#1.payload.activity#2
struct PushRequestOperationsItemVariant1PayloadActivityVariant2 {
  // schema-field: pushRequest.operations[]#1.payload.activity#2.kind
  let kind: String
  // schema-field: pushRequest.operations[]#1.payload.activity#2.productId
  let productId: String
  // schema-field: pushRequest.operations[]#1.payload.activity#2.observedPriceMinor
  let observedPriceMinor: Int64
  // schema-field: pushRequest.operations[]#1.payload.activity#2.currency
  let currency: String
  // schema-field: pushRequest.operations[]#1.payload.activity#2.compliant
  let compliant: OptionalField<Bool?>
}
// schema-object: pushRequest.operations[]#1.payload.activity#3
struct PushRequestOperationsItemVariant1PayloadActivityVariant3 {
  // schema-field: pushRequest.operations[]#1.payload.activity#3.kind
  let kind: String
  // schema-field: pushRequest.operations[]#1.payload.activity#3.programRef
  let programRef: String
  // schema-field: pushRequest.operations[]#1.payload.activity#3.finding
  let finding: PushRequestOperationsItemVariant1PayloadActivityVariant3FindingEnum
}
// schema-object: pushRequest.operations[]#1.payload.activity#4
struct PushRequestOperationsItemVariant1PayloadActivityVariant4 {
  // schema-field: pushRequest.operations[]#1.payload.activity#4.kind
  let kind: String
  // schema-field: pushRequest.operations[]#1.payload.activity#4.clientOrderId
  let clientOrderId: String
  // schema-field: pushRequest.operations[]#1.payload.activity#4.note
  let note: OptionalField<String>
}
// schema-object: pushRequest.operations[]#1.payload.activity#5
struct PushRequestOperationsItemVariant1PayloadActivityVariant5 {
  // schema-field: pushRequest.operations[]#1.payload.activity#5.kind
  let kind: String
  // schema-field: pushRequest.operations[]#1.payload.activity#5.text
  let text: String
}
// schema-object: pushRequest.operations[]#2
struct PushRequestOperationsItemVariant2 {
  // schema-field: pushRequest.operations[]#2.kind
  let kind: String
  // schema-field: pushRequest.operations[]#2.clientRequestId
  let clientRequestId: String
  // schema-field: pushRequest.operations[]#2.dependsOn
  let dependsOn: OptionalField<[String]>
  // schema-field: pushRequest.operations[]#2.payload
  let payload: PushRequestOperationsItemVariant2Payload
}
// schema-object: pushRequest.operations[]#2.payload
struct PushRequestOperationsItemVariant2Payload {
  // schema-field: pushRequest.operations[]#2.payload.visitId
  let visitId: String
  // schema-field: pushRequest.operations[]#2.payload.outcome
  let outcome: PushRequestOperationsItemVariant2PayloadOutcomeEnum
  // schema-field: pushRequest.operations[]#2.payload.reasonCode
  let reasonCode: String?
  // schema-field: pushRequest.operations[]#2.payload.deviceTime
  let deviceTime: Int64
  // schema-field: pushRequest.operations[]#2.payload.location
  let location: PushRequestOperationsItemVariant2PayloadLocationVariant0?
}
// schema-object: pushRequest.operations[]#2.payload.location#0
struct PushRequestOperationsItemVariant2PayloadLocationVariant0 {
  // schema-field: pushRequest.operations[]#2.payload.location#0.latitude
  let latitude: Double
  // schema-field: pushRequest.operations[]#2.payload.location#0.longitude
  let longitude: Double
  // schema-field: pushRequest.operations[]#2.payload.location#0.accuracyMeters
  let accuracyMeters: Double
  // schema-field: pushRequest.operations[]#2.payload.location#0.provider
  let provider: PushRequestOperationsItemVariant2PayloadLocationVariant0ProviderEnum
  // schema-field: pushRequest.operations[]#2.payload.location#0.mockSignal
  let mockSignal: OptionalField<Bool>
  // schema-field: pushRequest.operations[]#2.payload.location#0.fixTime
  let fixTime: Int64
}
// schema-object: pushRequest.operations[]#3
struct PushRequestOperationsItemVariant3 {
  // schema-field: pushRequest.operations[]#3.kind
  let kind: String
  // schema-field: pushRequest.operations[]#3.clientRequestId
  let clientRequestId: String
  // schema-field: pushRequest.operations[]#3.dependsOn
  let dependsOn: OptionalField<[String]>
  // schema-field: pushRequest.operations[]#3.payload
  let payload: PushRequestOperationsItemVariant3Payload
}
// schema-object: pushRequest.operations[]#3.payload
struct PushRequestOperationsItemVariant3Payload {
  // schema-field: pushRequest.operations[]#3.payload.referenceId
  let referenceId: String
  // schema-field: pushRequest.operations[]#3.payload.deviceTime
  let deviceTime: Int64
}
// schema-object: pushRequest.operations[]#4
struct PushRequestOperationsItemVariant4 {
  // schema-field: pushRequest.operations[]#4.kind
  let kind: String
  // schema-field: pushRequest.operations[]#4.clientRequestId
  let clientRequestId: String
  // schema-field: pushRequest.operations[]#4.dependsOn
  let dependsOn: OptionalField<[String]>
  // schema-field: pushRequest.operations[]#4.payload
  let payload: PushRequestOperationsItemVariant4Payload
}
// schema-object: pushRequest.operations[]#4.payload
struct PushRequestOperationsItemVariant4Payload {
  // schema-field: pushRequest.operations[]#4.payload.referenceId
  let referenceId: String
  // schema-field: pushRequest.operations[]#4.payload.deviceTime
  let deviceTime: Int64
}
// schema-object: pushResponse
struct PushResponse {
  // schema-field: pushResponse.type
  let type: String
  // schema-field: pushResponse.contractVersion
  let contractVersion: Int64
  // schema-field: pushResponse.serverTime
  let serverTime: Int64
  // schema-field: pushResponse.results
  let results: [PushResponseResultsItem]
}
// schema-object: pushResponse.results[]
struct PushResponseResultsItem {
  // schema-field: pushResponse.results[].kind
  let kind: PushResponseResultsItemKindEnum
  // schema-field: pushResponse.results[].clientRequestId
  let clientRequestId: String
  // schema-field: pushResponse.results[].status
  let status: PushResponseResultsItemStatusEnum
  // schema-field: pushResponse.results[].code
  let code: OptionalField<PushResponseResultsItemCodeEnum>
  // schema-field: pushResponse.results[].ack
  let ack: OptionalField<PushResponseResultsItemAck>
}
// schema-object: pushResponse.results[].ack
struct PushResponseResultsItemAck {
  // schema-field: pushResponse.results[].ack.entityId
  let entityId: String
  // schema-field: pushResponse.results[].ack.eventIds
  let eventIds: [String]
  // schema-field: pushResponse.results[].ack.serverTime
  let serverTime: Int64
}
// schema-object: errorResponse
struct ErrorResponse {
  // schema-field: errorResponse.type
  let type: String
  // schema-field: errorResponse.contractVersion
  let contractVersion: Int64
  // schema-field: errorResponse.serverTime
  let serverTime: Int64
  // schema-field: errorResponse.error
  let error: ErrorResponseError
}
// schema-object: errorResponse.error
struct ErrorResponseError {
  // schema-field: errorResponse.error.code
  let code: ErrorResponseErrorCodeEnum
  // schema-field: errorResponse.error.message
  let message: String
  // schema-field: errorResponse.error.retryable
  let retryable: Bool
  // schema-field: errorResponse.error.details
  let details: OptionalField<ErrorResponseErrorDetailsVariant0?>
}
// schema-object: errorResponse.error.details#0
struct ErrorResponseErrorDetailsVariant0 {
  // schema-field: errorResponse.error.details#0.field
  let field: String
}
// schema-enum: bootstrapRequest.type
// schema-enum-value: bootstrapRequest.type = bootstrap.request
// schema-enum: bootstrapResponse.type
// schema-enum-value: bootstrapResponse.type = bootstrap.response
// schema-enum: bootstrapResponse.appConfig.priceAvailability
// schema-enum-value: bootstrapResponse.appConfig.priceAvailability = unavailable
// schema-enum: bootstrapResponse.appConfig.promotionsAvailability
// schema-enum-value: bootstrapResponse.appConfig.promotionsAvailability = unavailable
// schema-enum: pullRequest.type
// schema-enum-value: pullRequest.type = pull.request
// schema-enum: pullResponse.type
// schema-enum-value: pullResponse.type = pull.response
// schema-enum: pullResponse.changes[].op
// schema-enum-value: pullResponse.changes[].op = upsert
// schema-enum-value: pullResponse.changes[].op = tombstone
struct PullResponseChangesItemOpEnum: Codable { let rawValue: String
  static let upsert = PullResponseChangesItemOpEnum(rawValue: "upsert")
  static let tombstone = PullResponseChangesItemOpEnum(rawValue: "tombstone")
}
// schema-enum: pushRequest.type
// schema-enum-value: pushRequest.type = push.request
// schema-enum: pushRequest.operations[]#0.kind
// schema-enum-value: pushRequest.operations[]#0.kind = visit.checkIn
// schema-enum: pushRequest.operations[]#0.payload.location#0.provider
// schema-enum-value: pushRequest.operations[]#0.payload.location#0.provider = gps
// schema-enum-value: pushRequest.operations[]#0.payload.location#0.provider = network
// schema-enum-value: pushRequest.operations[]#0.payload.location#0.provider = fused
// schema-enum-value: pushRequest.operations[]#0.payload.location#0.provider = unknown
struct PushRequestOperationsItemVariant0PayloadLocationVariant0ProviderEnum: Codable { let rawValue: String
  static let gps = PushRequestOperationsItemVariant0PayloadLocationVariant0ProviderEnum(rawValue: "gps")
  static let network = PushRequestOperationsItemVariant0PayloadLocationVariant0ProviderEnum(rawValue: "network")
  static let fused = PushRequestOperationsItemVariant0PayloadLocationVariant0ProviderEnum(rawValue: "fused")
  static let unknown = PushRequestOperationsItemVariant0PayloadLocationVariant0ProviderEnum(rawValue: "unknown")
}
// schema-enum: pushRequest.operations[]#0.payload.intents[]
// schema-enum-value: pushRequest.operations[]#0.payload.intents[] = sell
// schema-enum-value: pushRequest.operations[]#0.payload.intents[] = collect
// schema-enum-value: pushRequest.operations[]#0.payload.intents[] = merchandise
// schema-enum-value: pushRequest.operations[]#0.payload.intents[] = audit
// schema-enum-value: pushRequest.operations[]#0.payload.intents[] = deliver
// schema-enum-value: pushRequest.operations[]#0.payload.intents[] = promotion
// schema-enum-value: pushRequest.operations[]#0.payload.intents[] = complaint
// schema-enum-value: pushRequest.operations[]#0.payload.intents[] = follow-up
struct PushRequestOperationsItemVariant0PayloadIntentsItemEnum: Codable { let rawValue: String
  static let sell = PushRequestOperationsItemVariant0PayloadIntentsItemEnum(rawValue: "sell")
  static let collect = PushRequestOperationsItemVariant0PayloadIntentsItemEnum(rawValue: "collect")
  static let merchandise = PushRequestOperationsItemVariant0PayloadIntentsItemEnum(rawValue: "merchandise")
  static let audit = PushRequestOperationsItemVariant0PayloadIntentsItemEnum(rawValue: "audit")
  static let deliver = PushRequestOperationsItemVariant0PayloadIntentsItemEnum(rawValue: "deliver")
  static let promotion = PushRequestOperationsItemVariant0PayloadIntentsItemEnum(rawValue: "promotion")
  static let complaint = PushRequestOperationsItemVariant0PayloadIntentsItemEnum(rawValue: "complaint")
  static let follow_up = PushRequestOperationsItemVariant0PayloadIntentsItemEnum(rawValue: "follow-up")
}
// schema-enum: pushRequest.operations[]#1.kind
// schema-enum-value: pushRequest.operations[]#1.kind = visit.activity
// schema-enum: pushRequest.operations[]#1.payload.activity#0.kind
// schema-enum-value: pushRequest.operations[]#1.payload.activity#0.kind = inventory_check
// schema-enum: pushRequest.operations[]#1.payload.activity#0.icoFinding
// schema-enum-value: pushRequest.operations[]#1.payload.activity#0.icoFinding = present
// schema-enum-value: pushRequest.operations[]#1.payload.activity#0.icoFinding = absent
// schema-enum-value: pushRequest.operations[]#1.payload.activity#0.icoFinding = unknown
struct PushRequestOperationsItemVariant1PayloadActivityVariant0IcoFindingEnum: Codable { let rawValue: String
  static let present = PushRequestOperationsItemVariant1PayloadActivityVariant0IcoFindingEnum(rawValue: "present")
  static let absent = PushRequestOperationsItemVariant1PayloadActivityVariant0IcoFindingEnum(rawValue: "absent")
  static let unknown = PushRequestOperationsItemVariant1PayloadActivityVariant0IcoFindingEnum(rawValue: "unknown")
}
// schema-enum: pushRequest.operations[]#1.payload.activity#1.kind
// schema-enum-value: pushRequest.operations[]#1.payload.activity#1.kind = merchandising
// schema-enum: pushRequest.operations[]#1.payload.activity#1.displayCondition
// schema-enum-value: pushRequest.operations[]#1.payload.activity#1.displayCondition = compliant
// schema-enum-value: pushRequest.operations[]#1.payload.activity#1.displayCondition = needs_action
// schema-enum-value: pushRequest.operations[]#1.payload.activity#1.displayCondition = not_present
struct PushRequestOperationsItemVariant1PayloadActivityVariant1DisplayConditionEnum: Codable { let rawValue: String
  static let compliant = PushRequestOperationsItemVariant1PayloadActivityVariant1DisplayConditionEnum(rawValue: "compliant")
  static let needs_action = PushRequestOperationsItemVariant1PayloadActivityVariant1DisplayConditionEnum(rawValue: "needs_action")
  static let not_present = PushRequestOperationsItemVariant1PayloadActivityVariant1DisplayConditionEnum(rawValue: "not_present")
}
// schema-enum: pushRequest.operations[]#1.payload.activity#2.kind
// schema-enum-value: pushRequest.operations[]#1.payload.activity#2.kind = price_check
// schema-enum: pushRequest.operations[]#1.payload.activity#3.kind
// schema-enum-value: pushRequest.operations[]#1.payload.activity#3.kind = promotion
// schema-enum: pushRequest.operations[]#1.payload.activity#3.finding
// schema-enum-value: pushRequest.operations[]#1.payload.activity#3.finding = executed
// schema-enum-value: pushRequest.operations[]#1.payload.activity#3.finding = not_executed
// schema-enum-value: pushRequest.operations[]#1.payload.activity#3.finding = not_applicable
struct PushRequestOperationsItemVariant1PayloadActivityVariant3FindingEnum: Codable { let rawValue: String
  static let executed = PushRequestOperationsItemVariant1PayloadActivityVariant3FindingEnum(rawValue: "executed")
  static let not_executed = PushRequestOperationsItemVariant1PayloadActivityVariant3FindingEnum(rawValue: "not_executed")
  static let not_applicable = PushRequestOperationsItemVariant1PayloadActivityVariant3FindingEnum(rawValue: "not_applicable")
}
// schema-enum: pushRequest.operations[]#1.payload.activity#4.kind
// schema-enum-value: pushRequest.operations[]#1.payload.activity#4.kind = order_intent
// schema-enum: pushRequest.operations[]#1.payload.activity#5.kind
// schema-enum-value: pushRequest.operations[]#1.payload.activity#5.kind = note
// schema-enum: pushRequest.operations[]#2.kind
// schema-enum-value: pushRequest.operations[]#2.kind = visit.checkOut
// schema-enum: pushRequest.operations[]#2.payload.outcome
// schema-enum-value: pushRequest.operations[]#2.payload.outcome = completed
// schema-enum-value: pushRequest.operations[]#2.payload.outcome = nonproductive
struct PushRequestOperationsItemVariant2PayloadOutcomeEnum: Codable { let rawValue: String
  static let completed = PushRequestOperationsItemVariant2PayloadOutcomeEnum(rawValue: "completed")
  static let nonproductive = PushRequestOperationsItemVariant2PayloadOutcomeEnum(rawValue: "nonproductive")
}
// schema-enum: pushRequest.operations[]#2.payload.location#0.provider
// schema-enum-value: pushRequest.operations[]#2.payload.location#0.provider = gps
// schema-enum-value: pushRequest.operations[]#2.payload.location#0.provider = network
// schema-enum-value: pushRequest.operations[]#2.payload.location#0.provider = fused
// schema-enum-value: pushRequest.operations[]#2.payload.location#0.provider = unknown
struct PushRequestOperationsItemVariant2PayloadLocationVariant0ProviderEnum: Codable { let rawValue: String
  static let gps = PushRequestOperationsItemVariant2PayloadLocationVariant0ProviderEnum(rawValue: "gps")
  static let network = PushRequestOperationsItemVariant2PayloadLocationVariant0ProviderEnum(rawValue: "network")
  static let fused = PushRequestOperationsItemVariant2PayloadLocationVariant0ProviderEnum(rawValue: "fused")
  static let unknown = PushRequestOperationsItemVariant2PayloadLocationVariant0ProviderEnum(rawValue: "unknown")
}
// schema-enum: pushRequest.operations[]#3.kind
// schema-enum-value: pushRequest.operations[]#3.kind = task.complete
// schema-enum: pushRequest.operations[]#4.kind
// schema-enum-value: pushRequest.operations[]#4.kind = collection.record
// schema-enum: pushResponse.type
// schema-enum-value: pushResponse.type = push.response
// schema-enum: pushResponse.results[].kind
// schema-enum-value: pushResponse.results[].kind = visit.checkIn
// schema-enum-value: pushResponse.results[].kind = visit.activity
// schema-enum-value: pushResponse.results[].kind = visit.checkOut
// schema-enum-value: pushResponse.results[].kind = task.complete
// schema-enum-value: pushResponse.results[].kind = collection.record
struct PushResponseResultsItemKindEnum: Codable { let rawValue: String
  static let visit_checkIn = PushResponseResultsItemKindEnum(rawValue: "visit.checkIn")
  static let visit_activity = PushResponseResultsItemKindEnum(rawValue: "visit.activity")
  static let visit_checkOut = PushResponseResultsItemKindEnum(rawValue: "visit.checkOut")
  static let task_complete = PushResponseResultsItemKindEnum(rawValue: "task.complete")
  static let collection_record = PushResponseResultsItemKindEnum(rawValue: "collection.record")
}
// schema-enum: pushResponse.results[].status
// schema-enum-value: pushResponse.results[].status = accepted
// schema-enum-value: pushResponse.results[].status = rejected
// schema-enum-value: pushResponse.results[].status = conflict
struct PushResponseResultsItemStatusEnum: Codable { let rawValue: String
  static let accepted = PushResponseResultsItemStatusEnum(rawValue: "accepted")
  static let rejected = PushResponseResultsItemStatusEnum(rawValue: "rejected")
  static let conflict = PushResponseResultsItemStatusEnum(rawValue: "conflict")
}
// schema-enum: pushResponse.results[].code
// schema-enum-value: pushResponse.results[].code = conflict
// schema-enum-value: pushResponse.results[].code = unsupported_operation
// schema-enum-value: pushResponse.results[].code = dependency_missing
// schema-enum-value: pushResponse.results[].code = out_of_scope
// schema-enum-value: pushResponse.results[].code = evidence_pending_review
// schema-enum-value: pushResponse.results[].code = invalid_request
struct PushResponseResultsItemCodeEnum: Codable { let rawValue: String
  static let conflict = PushResponseResultsItemCodeEnum(rawValue: "conflict")
  static let unsupported_operation = PushResponseResultsItemCodeEnum(rawValue: "unsupported_operation")
  static let dependency_missing = PushResponseResultsItemCodeEnum(rawValue: "dependency_missing")
  static let out_of_scope = PushResponseResultsItemCodeEnum(rawValue: "out_of_scope")
  static let evidence_pending_review = PushResponseResultsItemCodeEnum(rawValue: "evidence_pending_review")
  static let invalid_request = PushResponseResultsItemCodeEnum(rawValue: "invalid_request")
}
// schema-enum: errorResponse.type
// schema-enum-value: errorResponse.type = error.response
// schema-enum: errorResponse.error.code
// schema-enum-value: errorResponse.error.code = rebootstrap_required
// schema-enum-value: errorResponse.error.code = conflict
// schema-enum-value: errorResponse.error.code = unsupported_operation
// schema-enum-value: errorResponse.error.code = device_revoked
// schema-enum-value: errorResponse.error.code = scope_changed
// schema-enum-value: errorResponse.error.code = version_unsupported
// schema-enum-value: errorResponse.error.code = unauthorized
// schema-enum-value: errorResponse.error.code = invalid_request
// schema-enum-value: errorResponse.error.code = invalid_cursor
// schema-enum-value: errorResponse.error.code = dependency_missing
// schema-enum-value: errorResponse.error.code = out_of_scope
// schema-enum-value: errorResponse.error.code = evidence_pending_review
// schema-enum-value: errorResponse.error.code = temporarily_unavailable
struct ErrorResponseErrorCodeEnum: Codable { let rawValue: String
  static let rebootstrap_required = ErrorResponseErrorCodeEnum(rawValue: "rebootstrap_required")
  static let conflict = ErrorResponseErrorCodeEnum(rawValue: "conflict")
  static let unsupported_operation = ErrorResponseErrorCodeEnum(rawValue: "unsupported_operation")
  static let device_revoked = ErrorResponseErrorCodeEnum(rawValue: "device_revoked")
  static let scope_changed = ErrorResponseErrorCodeEnum(rawValue: "scope_changed")
  static let version_unsupported = ErrorResponseErrorCodeEnum(rawValue: "version_unsupported")
  static let unauthorized = ErrorResponseErrorCodeEnum(rawValue: "unauthorized")
  static let invalid_request = ErrorResponseErrorCodeEnum(rawValue: "invalid_request")
  static let invalid_cursor = ErrorResponseErrorCodeEnum(rawValue: "invalid_cursor")
  static let dependency_missing = ErrorResponseErrorCodeEnum(rawValue: "dependency_missing")
  static let out_of_scope = ErrorResponseErrorCodeEnum(rawValue: "out_of_scope")
  static let evidence_pending_review = ErrorResponseErrorCodeEnum(rawValue: "evidence_pending_review")
  static let temporarily_unavailable = ErrorResponseErrorCodeEnum(rawValue: "temporarily_unavailable")
}
