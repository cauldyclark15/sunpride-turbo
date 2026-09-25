// CONTRACT TEXT FIXTURE — explicitly mapped from mobile-v1.schema.json; not native application code.
// All paths below are schema paths. Optional omission differs from explicit null.
// JSONValue and OptionalField stand for a real platform JSON AST / presence-aware decoder.
typealias JSONValue = Any
data class OptionalField<T>(val isPresent: Boolean, val value: T?)
// OpenEnum preserves unknown server enum values; unknown values must disable transitions.
data class OpenEnum(val rawValue: String)
// schema-object: bootstrapRequest
data class BootstrapRequest(
  // schema-field: bootstrapRequest.type
  val type: String,
  // schema-field: bootstrapRequest.contractVersion
  val contractVersion: Long,
  // schema-field: bootstrapRequest.deviceId
  val deviceId: String,
  // schema-field: bootstrapRequest.dayFrom
  val dayFrom: OptionalField<String>,
  // schema-field: bootstrapRequest.pageCursor
  val pageCursor: OptionalField<String>,
  // schema-field: bootstrapRequest.limit
  val limit: OptionalField<Long>
)
// schema-object: bootstrapResponse
data class BootstrapResponse(
  // schema-field: bootstrapResponse.type
  val type: String,
  // schema-field: bootstrapResponse.contractVersion
  val contractVersion: Long,
  // schema-field: bootstrapResponse.serverTime
  val serverTime: Long,
  // schema-field: bootstrapResponse.permissions
  val permissions: List<String>,
  // schema-field: bootstrapResponse.employee
  val employee: BootstrapResponseEmployee,
  // schema-field: bootstrapResponse.scope
  val scope: BootstrapResponseScope,
  // schema-field: bootstrapResponse.appConfig
  val appConfig: BootstrapResponseAppConfig,
  // schema-field: bootstrapResponse.plannedVisits
  val plannedVisits: List<BootstrapResponsePlannedVisitsItem>,
  // schema-field: bootstrapResponse.outlets
  val outlets: List<BootstrapResponseOutletsItem>,
  // schema-field: bootstrapResponse.localCustomers
  val localCustomers: List<BootstrapResponseLocalCustomersItem>,
  // schema-field: bootstrapResponse.route
  val route: BootstrapResponseRouteVariant0?,
  // schema-field: bootstrapResponse.tasks
  val tasks: List<BootstrapResponseTasksItem>,
  // schema-field: bootstrapResponse.productCatalog
  val productCatalog: List<BootstrapResponseProductCatalogItem>,
  // schema-field: bootstrapResponse.page
  val page: Long,
  // schema-field: bootstrapResponse.nextPageCursor
  val nextPageCursor: String?,
  // schema-field: bootstrapResponse.syncCursor
  val syncCursor: String?
)
// schema-object: bootstrapResponse.employee
data class BootstrapResponseEmployee(
  // schema-field: bootstrapResponse.employee.id
  val id: String,
  // schema-field: bootstrapResponse.employee.role
  val role: String,
  // schema-field: bootstrapResponse.employee.orgUnitId
  val orgUnitId: String
)
// schema-object: bootstrapResponse.scope
data class BootstrapResponseScope(
  // schema-field: bootstrapResponse.scope.fingerprint
  val fingerprint: String,
  // schema-field: bootstrapResponse.scope.orgUnitIds
  val orgUnitIds: List<String>
)
// schema-object: bootstrapResponse.appConfig
data class BootstrapResponseAppConfig(
  // schema-field: bootstrapResponse.appConfig.offlineLeaseExpiresAt
  val offlineLeaseExpiresAt: Long,
  // schema-field: bootstrapResponse.appConfig.cacheExpiresAt
  val cacheExpiresAt: Long,
  // schema-field: bootstrapResponse.appConfig.orderCaptureEnabled
  val orderCaptureEnabled: Boolean,
  // schema-field: bootstrapResponse.appConfig.priceAvailability
  val priceAvailability: String,
  // schema-field: bootstrapResponse.appConfig.promotionsAvailability
  val promotionsAvailability: String
)
// schema-object: bootstrapResponse.plannedVisits[]
data class BootstrapResponsePlannedVisitsItem(
  // schema-field: bootstrapResponse.plannedVisits[].id
  val id: String,
  // schema-field: bootstrapResponse.plannedVisits[].outletId
  val outletId: String,
  // schema-field: bootstrapResponse.plannedVisits[].serviceDate
  val serviceDate: String,
  // schema-field: bootstrapResponse.plannedVisits[].planId
  val planId: String,
  // schema-field: bootstrapResponse.plannedVisits[].planVersion
  val planVersion: Long,
  // schema-field: bootstrapResponse.plannedVisits[].intents
  val intents: List<String>
)
// schema-object: bootstrapResponse.outlets[]
data class BootstrapResponseOutletsItem(
  // schema-field: bootstrapResponse.outlets[].id
  val id: String,
  // schema-field: bootstrapResponse.outlets[].name
  val name: String,
  // schema-field: bootstrapResponse.outlets[].routeId
  val routeId: String?
)
// schema-object: bootstrapResponse.localCustomers[]
data class BootstrapResponseLocalCustomersItem(
  // schema-field: bootstrapResponse.localCustomers[].id
  val id: String,
  // schema-field: bootstrapResponse.localCustomers[].code
  val code: String
)
// schema-object: bootstrapResponse.route#0
data class BootstrapResponseRouteVariant0(
  // schema-field: bootstrapResponse.route#0.id
  val id: String,
  // schema-field: bootstrapResponse.route#0.code
  val code: String
)
// schema-object: bootstrapResponse.tasks[]
data class BootstrapResponseTasksItem(
  // schema-field: bootstrapResponse.tasks[].id
  val id: String,
  // schema-field: bootstrapResponse.tasks[].kind
  val kind: String,
  // schema-field: bootstrapResponse.tasks[].required
  val required: Boolean
)
// schema-object: bootstrapResponse.productCatalog[]
data class BootstrapResponseProductCatalogItem(
  // schema-field: bootstrapResponse.productCatalog[].id
  val id: String,
  // schema-field: bootstrapResponse.productCatalog[].code
  val code: String,
  // schema-field: bootstrapResponse.productCatalog[].name
  val name: String,
  // schema-field: bootstrapResponse.productCatalog[].uom
  val uom: String
)
// schema-object: pullRequest
data class PullRequest(
  // schema-field: pullRequest.type
  val type: String,
  // schema-field: pullRequest.contractVersion
  val contractVersion: Long,
  // schema-field: pullRequest.deviceId
  val deviceId: String,
  // schema-field: pullRequest.cursor
  val cursor: String,
  // schema-field: pullRequest.limit
  val limit: Long
)
// schema-object: pullResponse
data class PullResponse(
  // schema-field: pullResponse.type
  val type: String,
  // schema-field: pullResponse.contractVersion
  val contractVersion: Long,
  // schema-field: pullResponse.serverTime
  val serverTime: Long,
  // schema-field: pullResponse.changes
  val changes: List<PullResponseChangesItem>,
  // schema-field: pullResponse.nextCursor
  val nextCursor: String,
  // schema-field: pullResponse.hasMore
  val hasMore: Boolean
)
// schema-object: pullResponse.changes[]
data class PullResponseChangesItem(
  // schema-field: pullResponse.changes[].seq
  val seq: Long,
  // schema-field: pullResponse.changes[].entity
  val entity: String,
  // schema-field: pullResponse.changes[].id
  val id: String,
  // schema-field: pullResponse.changes[].revision
  val revision: Long,
  // schema-field: pullResponse.changes[].op
  val op: PullResponseChangesItemOpEnum,
  // schema-field: pullResponse.changes[].value
  val value: OptionalField<JSONValue>
)
// schema-object: pushRequest
data class PushRequest(
  // schema-field: pushRequest.type
  val type: String,
  // schema-field: pushRequest.contractVersion
  val contractVersion: Long,
  // schema-field: pushRequest.deviceId
  val deviceId: String,
  // schema-field: pushRequest.operations
  val operations: List<JSONValue>
)
// schema-object: pushRequest.operations[]#0
data class PushRequestOperationsItemVariant0(
  // schema-field: pushRequest.operations[]#0.kind
  val kind: String,
  // schema-field: pushRequest.operations[]#0.clientRequestId
  val clientRequestId: String,
  // schema-field: pushRequest.operations[]#0.dependsOn
  val dependsOn: OptionalField<List<String>>,
  // schema-field: pushRequest.operations[]#0.payload
  val payload: PushRequestOperationsItemVariant0Payload
)
// schema-object: pushRequest.operations[]#0.payload
data class PushRequestOperationsItemVariant0Payload(
  // schema-field: pushRequest.operations[]#0.payload.clientVisitId
  val clientVisitId: String,
  // schema-field: pushRequest.operations[]#0.payload.plannedVisitId
  val plannedVisitId: String?,
  // schema-field: pushRequest.operations[]#0.payload.outletId
  val outletId: String,
  // schema-field: pushRequest.operations[]#0.payload.serviceDate
  val serviceDate: String,
  // schema-field: pushRequest.operations[]#0.payload.deviceTime
  val deviceTime: Long,
  // schema-field: pushRequest.operations[]#0.payload.location
  val location: PushRequestOperationsItemVariant0PayloadLocationVariant0?,
  // schema-field: pushRequest.operations[]#0.payload.unplannedReason
  val unplannedReason: OptionalField<String>,
  // schema-field: pushRequest.operations[]#0.payload.intents
  val intents: List<PushRequestOperationsItemVariant0PayloadIntentsItemEnum>
)
// schema-object: pushRequest.operations[]#0.payload.location#0
data class PushRequestOperationsItemVariant0PayloadLocationVariant0(
  // schema-field: pushRequest.operations[]#0.payload.location#0.latitude
  val latitude: Double,
  // schema-field: pushRequest.operations[]#0.payload.location#0.longitude
  val longitude: Double,
  // schema-field: pushRequest.operations[]#0.payload.location#0.accuracyMeters
  val accuracyMeters: Double,
  // schema-field: pushRequest.operations[]#0.payload.location#0.provider
  val provider: PushRequestOperationsItemVariant0PayloadLocationVariant0ProviderEnum,
  // schema-field: pushRequest.operations[]#0.payload.location#0.mockSignal
  val mockSignal: OptionalField<Boolean>,
  // schema-field: pushRequest.operations[]#0.payload.location#0.fixTime
  val fixTime: Long
)
// schema-object: pushRequest.operations[]#1
data class PushRequestOperationsItemVariant1(
  // schema-field: pushRequest.operations[]#1.kind
  val kind: String,
  // schema-field: pushRequest.operations[]#1.clientRequestId
  val clientRequestId: String,
  // schema-field: pushRequest.operations[]#1.dependsOn
  val dependsOn: OptionalField<List<String>>,
  // schema-field: pushRequest.operations[]#1.payload
  val payload: PushRequestOperationsItemVariant1Payload
)
// schema-object: pushRequest.operations[]#1.payload
data class PushRequestOperationsItemVariant1Payload(
  // schema-field: pushRequest.operations[]#1.payload.visitId
  val visitId: String,
  // schema-field: pushRequest.operations[]#1.payload.activity
  val activity: JSONValue,
  // schema-field: pushRequest.operations[]#1.payload.deviceTime
  val deviceTime: Long
)
// schema-object: pushRequest.operations[]#1.payload.activity#0
data class PushRequestOperationsItemVariant1PayloadActivityVariant0(
  // schema-field: pushRequest.operations[]#1.payload.activity#0.kind
  val kind: String,
  // schema-field: pushRequest.operations[]#1.payload.activity#0.productId
  val productId: String,
  // schema-field: pushRequest.operations[]#1.payload.activity#0.icoFinding
  val icoFinding: PushRequestOperationsItemVariant1PayloadActivityVariant0IcoFindingEnum,
  // schema-field: pushRequest.operations[]#1.payload.activity#0.observedQuantity
  val observedQuantity: OptionalField<Double?>
)
// schema-object: pushRequest.operations[]#1.payload.activity#1
data class PushRequestOperationsItemVariant1PayloadActivityVariant1(
  // schema-field: pushRequest.operations[]#1.payload.activity#1.kind
  val kind: String,
  // schema-field: pushRequest.operations[]#1.payload.activity#1.displayCondition
  val displayCondition: PushRequestOperationsItemVariant1PayloadActivityVariant1DisplayConditionEnum,
  // schema-field: pushRequest.operations[]#1.payload.activity#1.actionTaken
  val actionTaken: OptionalField<String>
)
// schema-object: pushRequest.operations[]#1.payload.activity#2
data class PushRequestOperationsItemVariant1PayloadActivityVariant2(
  // schema-field: pushRequest.operations[]#1.payload.activity#2.kind
  val kind: String,
  // schema-field: pushRequest.operations[]#1.payload.activity#2.productId
  val productId: String,
  // schema-field: pushRequest.operations[]#1.payload.activity#2.observedPriceMinor
  val observedPriceMinor: Long,
  // schema-field: pushRequest.operations[]#1.payload.activity#2.currency
  val currency: String,
  // schema-field: pushRequest.operations[]#1.payload.activity#2.compliant
  val compliant: OptionalField<Boolean?>
)
// schema-object: pushRequest.operations[]#1.payload.activity#3
data class PushRequestOperationsItemVariant1PayloadActivityVariant3(
  // schema-field: pushRequest.operations[]#1.payload.activity#3.kind
  val kind: String,
  // schema-field: pushRequest.operations[]#1.payload.activity#3.programRef
  val programRef: String,
  // schema-field: pushRequest.operations[]#1.payload.activity#3.finding
  val finding: PushRequestOperationsItemVariant1PayloadActivityVariant3FindingEnum
)
// schema-object: pushRequest.operations[]#1.payload.activity#4
data class PushRequestOperationsItemVariant1PayloadActivityVariant4(
  // schema-field: pushRequest.operations[]#1.payload.activity#4.kind
  val kind: String,
  // schema-field: pushRequest.operations[]#1.payload.activity#4.clientOrderId
  val clientOrderId: String,
  // schema-field: pushRequest.operations[]#1.payload.activity#4.note
  val note: OptionalField<String>
)
// schema-object: pushRequest.operations[]#1.payload.activity#5
data class PushRequestOperationsItemVariant1PayloadActivityVariant5(
  // schema-field: pushRequest.operations[]#1.payload.activity#5.kind
  val kind: String,
  // schema-field: pushRequest.operations[]#1.payload.activity#5.text
  val text: String
)
// schema-object: pushRequest.operations[]#2
data class PushRequestOperationsItemVariant2(
  // schema-field: pushRequest.operations[]#2.kind
  val kind: String,
  // schema-field: pushRequest.operations[]#2.clientRequestId
  val clientRequestId: String,
  // schema-field: pushRequest.operations[]#2.dependsOn
  val dependsOn: OptionalField<List<String>>,
  // schema-field: pushRequest.operations[]#2.payload
  val payload: PushRequestOperationsItemVariant2Payload
)
// schema-object: pushRequest.operations[]#2.payload
data class PushRequestOperationsItemVariant2Payload(
  // schema-field: pushRequest.operations[]#2.payload.visitId
  val visitId: String,
  // schema-field: pushRequest.operations[]#2.payload.outcome
  val outcome: PushRequestOperationsItemVariant2PayloadOutcomeEnum,
  // schema-field: pushRequest.operations[]#2.payload.reasonCode
  val reasonCode: String?,
  // schema-field: pushRequest.operations[]#2.payload.deviceTime
  val deviceTime: Long,
  // schema-field: pushRequest.operations[]#2.payload.location
  val location: PushRequestOperationsItemVariant2PayloadLocationVariant0?
)
// schema-object: pushRequest.operations[]#2.payload.location#0
data class PushRequestOperationsItemVariant2PayloadLocationVariant0(
  // schema-field: pushRequest.operations[]#2.payload.location#0.latitude
  val latitude: Double,
  // schema-field: pushRequest.operations[]#2.payload.location#0.longitude
  val longitude: Double,
  // schema-field: pushRequest.operations[]#2.payload.location#0.accuracyMeters
  val accuracyMeters: Double,
  // schema-field: pushRequest.operations[]#2.payload.location#0.provider
  val provider: PushRequestOperationsItemVariant2PayloadLocationVariant0ProviderEnum,
  // schema-field: pushRequest.operations[]#2.payload.location#0.mockSignal
  val mockSignal: OptionalField<Boolean>,
  // schema-field: pushRequest.operations[]#2.payload.location#0.fixTime
  val fixTime: Long
)
// schema-object: pushRequest.operations[]#3
data class PushRequestOperationsItemVariant3(
  // schema-field: pushRequest.operations[]#3.kind
  val kind: String,
  // schema-field: pushRequest.operations[]#3.clientRequestId
  val clientRequestId: String,
  // schema-field: pushRequest.operations[]#3.dependsOn
  val dependsOn: OptionalField<List<String>>,
  // schema-field: pushRequest.operations[]#3.payload
  val payload: PushRequestOperationsItemVariant3Payload
)
// schema-object: pushRequest.operations[]#3.payload
data class PushRequestOperationsItemVariant3Payload(
  // schema-field: pushRequest.operations[]#3.payload.referenceId
  val referenceId: String,
  // schema-field: pushRequest.operations[]#3.payload.deviceTime
  val deviceTime: Long
)
// schema-object: pushRequest.operations[]#4
data class PushRequestOperationsItemVariant4(
  // schema-field: pushRequest.operations[]#4.kind
  val kind: String,
  // schema-field: pushRequest.operations[]#4.clientRequestId
  val clientRequestId: String,
  // schema-field: pushRequest.operations[]#4.dependsOn
  val dependsOn: OptionalField<List<String>>,
  // schema-field: pushRequest.operations[]#4.payload
  val payload: PushRequestOperationsItemVariant4Payload
)
// schema-object: pushRequest.operations[]#4.payload
data class PushRequestOperationsItemVariant4Payload(
  // schema-field: pushRequest.operations[]#4.payload.referenceId
  val referenceId: String,
  // schema-field: pushRequest.operations[]#4.payload.deviceTime
  val deviceTime: Long
)
// schema-object: pushResponse
data class PushResponse(
  // schema-field: pushResponse.type
  val type: String,
  // schema-field: pushResponse.contractVersion
  val contractVersion: Long,
  // schema-field: pushResponse.serverTime
  val serverTime: Long,
  // schema-field: pushResponse.results
  val results: List<PushResponseResultsItem>
)
// schema-object: pushResponse.results[]
data class PushResponseResultsItem(
  // schema-field: pushResponse.results[].kind
  val kind: PushResponseResultsItemKindEnum,
  // schema-field: pushResponse.results[].clientRequestId
  val clientRequestId: String,
  // schema-field: pushResponse.results[].status
  val status: PushResponseResultsItemStatusEnum,
  // schema-field: pushResponse.results[].code
  val code: OptionalField<PushResponseResultsItemCodeEnum>,
  // schema-field: pushResponse.results[].ack
  val ack: OptionalField<PushResponseResultsItemAck>
)
// schema-object: pushResponse.results[].ack
data class PushResponseResultsItemAck(
  // schema-field: pushResponse.results[].ack.entityId
  val entityId: String,
  // schema-field: pushResponse.results[].ack.eventIds
  val eventIds: List<String>,
  // schema-field: pushResponse.results[].ack.serverTime
  val serverTime: Long
)
// schema-object: errorResponse
data class ErrorResponse(
  // schema-field: errorResponse.type
  val type: String,
  // schema-field: errorResponse.contractVersion
  val contractVersion: Long,
  // schema-field: errorResponse.serverTime
  val serverTime: Long,
  // schema-field: errorResponse.error
  val error: ErrorResponseError
)
// schema-object: errorResponse.error
data class ErrorResponseError(
  // schema-field: errorResponse.error.code
  val code: ErrorResponseErrorCodeEnum,
  // schema-field: errorResponse.error.message
  val message: String,
  // schema-field: errorResponse.error.retryable
  val retryable: Boolean,
  // schema-field: errorResponse.error.details
  val details: OptionalField<ErrorResponseErrorDetailsVariant0?>
)
// schema-object: errorResponse.error.details#0
data class ErrorResponseErrorDetailsVariant0(
  // schema-field: errorResponse.error.details#0.field
  val field: String
)
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
data class PullResponseChangesItemOpEnum(val rawValue: String) {
  companion object {
    val upsert = PullResponseChangesItemOpEnum("upsert")
    val tombstone = PullResponseChangesItemOpEnum("tombstone")
  }
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
data class PushRequestOperationsItemVariant0PayloadLocationVariant0ProviderEnum(val rawValue: String) {
  companion object {
    val gps = PushRequestOperationsItemVariant0PayloadLocationVariant0ProviderEnum("gps")
    val network = PushRequestOperationsItemVariant0PayloadLocationVariant0ProviderEnum("network")
    val fused = PushRequestOperationsItemVariant0PayloadLocationVariant0ProviderEnum("fused")
    val unknown = PushRequestOperationsItemVariant0PayloadLocationVariant0ProviderEnum("unknown")
  }
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
data class PushRequestOperationsItemVariant0PayloadIntentsItemEnum(val rawValue: String) {
  companion object {
    val sell = PushRequestOperationsItemVariant0PayloadIntentsItemEnum("sell")
    val collect = PushRequestOperationsItemVariant0PayloadIntentsItemEnum("collect")
    val merchandise = PushRequestOperationsItemVariant0PayloadIntentsItemEnum("merchandise")
    val audit = PushRequestOperationsItemVariant0PayloadIntentsItemEnum("audit")
    val deliver = PushRequestOperationsItemVariant0PayloadIntentsItemEnum("deliver")
    val promotion = PushRequestOperationsItemVariant0PayloadIntentsItemEnum("promotion")
    val complaint = PushRequestOperationsItemVariant0PayloadIntentsItemEnum("complaint")
    val follow_up = PushRequestOperationsItemVariant0PayloadIntentsItemEnum("follow-up")
  }
}
// schema-enum: pushRequest.operations[]#1.kind
// schema-enum-value: pushRequest.operations[]#1.kind = visit.activity
// schema-enum: pushRequest.operations[]#1.payload.activity#0.kind
// schema-enum-value: pushRequest.operations[]#1.payload.activity#0.kind = inventory_check
// schema-enum: pushRequest.operations[]#1.payload.activity#0.icoFinding
// schema-enum-value: pushRequest.operations[]#1.payload.activity#0.icoFinding = present
// schema-enum-value: pushRequest.operations[]#1.payload.activity#0.icoFinding = absent
// schema-enum-value: pushRequest.operations[]#1.payload.activity#0.icoFinding = unknown
data class PushRequestOperationsItemVariant1PayloadActivityVariant0IcoFindingEnum(val rawValue: String) {
  companion object {
    val present = PushRequestOperationsItemVariant1PayloadActivityVariant0IcoFindingEnum("present")
    val absent = PushRequestOperationsItemVariant1PayloadActivityVariant0IcoFindingEnum("absent")
    val unknown = PushRequestOperationsItemVariant1PayloadActivityVariant0IcoFindingEnum("unknown")
  }
}
// schema-enum: pushRequest.operations[]#1.payload.activity#1.kind
// schema-enum-value: pushRequest.operations[]#1.payload.activity#1.kind = merchandising
// schema-enum: pushRequest.operations[]#1.payload.activity#1.displayCondition
// schema-enum-value: pushRequest.operations[]#1.payload.activity#1.displayCondition = compliant
// schema-enum-value: pushRequest.operations[]#1.payload.activity#1.displayCondition = needs_action
// schema-enum-value: pushRequest.operations[]#1.payload.activity#1.displayCondition = not_present
data class PushRequestOperationsItemVariant1PayloadActivityVariant1DisplayConditionEnum(val rawValue: String) {
  companion object {
    val compliant = PushRequestOperationsItemVariant1PayloadActivityVariant1DisplayConditionEnum("compliant")
    val needs_action = PushRequestOperationsItemVariant1PayloadActivityVariant1DisplayConditionEnum("needs_action")
    val not_present = PushRequestOperationsItemVariant1PayloadActivityVariant1DisplayConditionEnum("not_present")
  }
}
// schema-enum: pushRequest.operations[]#1.payload.activity#2.kind
// schema-enum-value: pushRequest.operations[]#1.payload.activity#2.kind = price_check
// schema-enum: pushRequest.operations[]#1.payload.activity#3.kind
// schema-enum-value: pushRequest.operations[]#1.payload.activity#3.kind = promotion
// schema-enum: pushRequest.operations[]#1.payload.activity#3.finding
// schema-enum-value: pushRequest.operations[]#1.payload.activity#3.finding = executed
// schema-enum-value: pushRequest.operations[]#1.payload.activity#3.finding = not_executed
// schema-enum-value: pushRequest.operations[]#1.payload.activity#3.finding = not_applicable
data class PushRequestOperationsItemVariant1PayloadActivityVariant3FindingEnum(val rawValue: String) {
  companion object {
    val executed = PushRequestOperationsItemVariant1PayloadActivityVariant3FindingEnum("executed")
    val not_executed = PushRequestOperationsItemVariant1PayloadActivityVariant3FindingEnum("not_executed")
    val not_applicable = PushRequestOperationsItemVariant1PayloadActivityVariant3FindingEnum("not_applicable")
  }
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
data class PushRequestOperationsItemVariant2PayloadOutcomeEnum(val rawValue: String) {
  companion object {
    val completed = PushRequestOperationsItemVariant2PayloadOutcomeEnum("completed")
    val nonproductive = PushRequestOperationsItemVariant2PayloadOutcomeEnum("nonproductive")
  }
}
// schema-enum: pushRequest.operations[]#2.payload.location#0.provider
// schema-enum-value: pushRequest.operations[]#2.payload.location#0.provider = gps
// schema-enum-value: pushRequest.operations[]#2.payload.location#0.provider = network
// schema-enum-value: pushRequest.operations[]#2.payload.location#0.provider = fused
// schema-enum-value: pushRequest.operations[]#2.payload.location#0.provider = unknown
data class PushRequestOperationsItemVariant2PayloadLocationVariant0ProviderEnum(val rawValue: String) {
  companion object {
    val gps = PushRequestOperationsItemVariant2PayloadLocationVariant0ProviderEnum("gps")
    val network = PushRequestOperationsItemVariant2PayloadLocationVariant0ProviderEnum("network")
    val fused = PushRequestOperationsItemVariant2PayloadLocationVariant0ProviderEnum("fused")
    val unknown = PushRequestOperationsItemVariant2PayloadLocationVariant0ProviderEnum("unknown")
  }
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
data class PushResponseResultsItemKindEnum(val rawValue: String) {
  companion object {
    val visit_checkIn = PushResponseResultsItemKindEnum("visit.checkIn")
    val visit_activity = PushResponseResultsItemKindEnum("visit.activity")
    val visit_checkOut = PushResponseResultsItemKindEnum("visit.checkOut")
    val task_complete = PushResponseResultsItemKindEnum("task.complete")
    val collection_record = PushResponseResultsItemKindEnum("collection.record")
  }
}
// schema-enum: pushResponse.results[].status
// schema-enum-value: pushResponse.results[].status = accepted
// schema-enum-value: pushResponse.results[].status = rejected
// schema-enum-value: pushResponse.results[].status = conflict
data class PushResponseResultsItemStatusEnum(val rawValue: String) {
  companion object {
    val accepted = PushResponseResultsItemStatusEnum("accepted")
    val rejected = PushResponseResultsItemStatusEnum("rejected")
    val conflict = PushResponseResultsItemStatusEnum("conflict")
  }
}
// schema-enum: pushResponse.results[].code
// schema-enum-value: pushResponse.results[].code = conflict
// schema-enum-value: pushResponse.results[].code = unsupported_operation
// schema-enum-value: pushResponse.results[].code = dependency_missing
// schema-enum-value: pushResponse.results[].code = out_of_scope
// schema-enum-value: pushResponse.results[].code = evidence_pending_review
// schema-enum-value: pushResponse.results[].code = invalid_request
data class PushResponseResultsItemCodeEnum(val rawValue: String) {
  companion object {
    val conflict = PushResponseResultsItemCodeEnum("conflict")
    val unsupported_operation = PushResponseResultsItemCodeEnum("unsupported_operation")
    val dependency_missing = PushResponseResultsItemCodeEnum("dependency_missing")
    val out_of_scope = PushResponseResultsItemCodeEnum("out_of_scope")
    val evidence_pending_review = PushResponseResultsItemCodeEnum("evidence_pending_review")
    val invalid_request = PushResponseResultsItemCodeEnum("invalid_request")
  }
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
data class ErrorResponseErrorCodeEnum(val rawValue: String) {
  companion object {
    val rebootstrap_required = ErrorResponseErrorCodeEnum("rebootstrap_required")
    val conflict = ErrorResponseErrorCodeEnum("conflict")
    val unsupported_operation = ErrorResponseErrorCodeEnum("unsupported_operation")
    val device_revoked = ErrorResponseErrorCodeEnum("device_revoked")
    val scope_changed = ErrorResponseErrorCodeEnum("scope_changed")
    val version_unsupported = ErrorResponseErrorCodeEnum("version_unsupported")
    val unauthorized = ErrorResponseErrorCodeEnum("unauthorized")
    val invalid_request = ErrorResponseErrorCodeEnum("invalid_request")
    val invalid_cursor = ErrorResponseErrorCodeEnum("invalid_cursor")
    val dependency_missing = ErrorResponseErrorCodeEnum("dependency_missing")
    val out_of_scope = ErrorResponseErrorCodeEnum("out_of_scope")
    val evidence_pending_review = ErrorResponseErrorCodeEnum("evidence_pending_review")
    val temporarily_unavailable = ErrorResponseErrorCodeEnum("temporarily_unavailable")
  }
}
