package com.sunpride.field.support

import com.sunpride.field.storage.*
import java.util.UUID

/** Mirrors Room's generation visibility, partition/lease checks, enqueue ordering and ack transaction. */
class FakeFieldStore(val identity: StoreScope) : FieldStore {
    private val staged = mutableMapOf<String, ScopedSnapshot>()
    private var active: ScopedSnapshot? = null
    private var activeGeneration: String? = null
    private var lease = 0L
    private var token: String? = null
    private var held = false
    private var health = "never_synced"
    private val rows = mutableListOf<Pair<IntentRow, OutboxRow>>()
    private val acks = mutableMapOf<String, AckRow>()
    private val deltas = mutableMapOf<Pair<String, String>, DeltaRow>()
    override suspend fun stage(snapshot: ScopedSnapshot): String {
        require(snapshot.employeeJson.isNotBlank())
        require(snapshot.callSheets.map { it.outletId }.distinct().size == snapshot.callSheets.size)
        snapshot.callSheets.forEach { CallSheetCodec.decode(CallSheetCodec.encode(it)) }
        require(snapshot.productCatalog.distinctBy { it.id }.size == snapshot.productCatalog.size)
        require(snapshot.inventoryAvailability.distinctBy { it.id }.size == snapshot.inventoryAvailability.size)
        snapshot.productCatalog.forEach { ReferenceDataCodec.product(ReferenceDataCodec.encode(it)) }
        snapshot.inventoryAvailability.forEach { ReferenceDataCodec.availability(ReferenceDataCodec.encode(it)) }
        return UUID.randomUUID().toString().also { staged[it] = snapshot }
    }
    override suspend fun swap(generation: String, cursor: String, leaseExpiresAt: Long, cacheExpiresAt: Long, releaseHeld: Boolean) {
        require(generation.isNotBlank() && cursor.isNotBlank() && leaseExpiresAt > 0 && cacheExpiresAt > 0)
        active = staged[generation] ?: error("Unstaged snapshot")
        activeGeneration = generation
        lease = leaseExpiresAt
        held = held && !releaseHeld
        token = if (held) null else cursor
        health = if (held) "held_for_review" else "synced"
        staged.keys.retainAll(setOf(generation))
    }
    override suspend fun todaysVisits(day: String) = active?.visits?.filter { it.serviceDate == day } ?: emptyList()
    override suspend fun outlets() = active?.outlets ?: emptyList()
    override suspend fun callSheet(outletId: String) = active?.callSheets?.singleOrNull { it.outletId == outletId }
    override suspend fun catalog() = active?.productCatalog?.sortedWith(compareBy({ it.code }, { it.id })) ?: emptyList()
    override suspend fun availability(productId: String) = active?.inventoryAvailability
        ?.filter { it.productId == productId }?.sortedWith(compareBy({ it.locationCode }, { it.id })) ?: emptyList()
    override suspend fun delta(entity: String, id: String): DeltaRow? = when (entity) {
        "product" -> active?.productCatalog?.find { it.id == id }?.let {
            DeltaRow(identity.account, identity.deviceId, identity.fingerprint, entity, id,
                it.revision, ReferenceDataCodec.encode(it).toString(), false)
        }
        "inventory" -> active?.inventoryAvailability?.find { it.id == id }?.let {
            DeltaRow(identity.account, identity.deviceId, identity.fingerprint, entity, id,
                it.revision, ReferenceDataCodec.encode(it).toString(), false)
        }
        else -> deltas[entity to id]
    }
    override suspend fun applyDelta(changes: List<DeltaRow>, nextCursor: String) {
        require(nextCursor.isNotBlank())
        check(!held && active != null)
        // Work on copies; malformed later rows roll back earlier changes and cursor, just like Room.
        var snapshot = active!!
        val nextDeltas = deltas.toMutableMap()
        val nextStaged = staged.toMutableMap()
        fun refresh(s: ScopedSnapshot, p: CatalogProduct) = s.copy(callSheets = s.callSheets.map { sheet ->
            sheet.copy(lines = sheet.lines.map { line -> if (line.productId != p.id) line else
                line.copy(code = p.code, name = p.name, uom = p.uom, barcode = p.barcodes.firstOrNull()?.barcode) })
        })
        for (change in changes) {
            require(change.account == identity.account && change.deviceId == identity.deviceId &&
                change.scope == identity.fingerprint && change.revision > 0 &&
                change.entity in setOf("visit", "activity", "product", "inventory"))
            when (change.entity) {
                "product" -> {
                    val p = ReferenceDataCodec.productChange(change)
                    val prior = snapshot.productCatalog.find { it.id == p.id }
                    if (prior == null || p.revision >= prior.revision) {
                        snapshot = refresh(snapshot.copy(productCatalog = snapshot.productCatalog.filter { it.id != p.id } + p), p)
                        nextStaged.replaceAll { _, s -> refresh(s, p) }
                    }
                }
                "inventory" -> {
                    val i = ReferenceDataCodec.inventoryChange(change)
                    val prior = snapshot.inventoryAvailability.find { it.id == i.id }
                    if (prior == null || i.revision >= prior.revision)
                        snapshot = snapshot.copy(inventoryAvailability = snapshot.inventoryAvailability.filter { it.id != i.id } + i)
                }
                else -> {
                    val key = change.entity to change.entityId
                    val prior = nextDeltas[key]
                    if (prior == null || change.revision > prior.revision) nextDeltas[key] = change
                }
            }
        }
        active = snapshot
        nextStaged[activeGeneration!!] = snapshot
        staged.clear(); staged.putAll(nextStaged)
        deltas.clear(); deltas.putAll(nextDeltas)
        token = nextCursor
    }
    override suspend fun activityRules() = active?.activityRules ?: emptyList()
    override suspend fun isLeaseValid(now: Long) = !held && active != null && now < lease
    override suspend fun enqueue(intent: IntentRow, now: Long) {
        require(intent.account == identity.account && intent.deviceId == identity.deviceId && intent.scope == identity.fingerprint)
        require(intent.requestId.isNotBlank() && intent.clientVisitId.isNotBlank() &&
            intent.kind in setOf("visit.checkIn", "visit.activity", "visit.checkOut") && intent.serializedOperation.isNotBlank())
        check(isLeaseValid(now))
        VisitCompletion.requireOpenForActivity(intent, rows.map { it.first to it.second.state })
        CallSheetQueueRules.validate(this, intent)
        ActivityQueueRules.validate(this, intent)
        com.sunpride.field.orders.OrderQueueRules.validate(this, intent)
        check(rows.none { it.first.requestId == intent.requestId })
        val at = maxOf(intent.createdAt, (rows.maxOfOrNull { it.second.createdAt } ?: Long.MIN_VALUE) + 1)
        rows += intent.copy(createdAt = at) to OutboxRow(intent.account, intent.deviceId, intent.scope, intent.requestId, at)
    }
    override suspend fun pending() = rows.filter { it.second.state in setOf("pending", "sending") }
    override suspend fun history() = rows.toList()
    override suspend fun intent(requestId: String) = rows.find { it.first.requestId == requestId }?.first
    override suspend fun recordAck(requestId: String, entityId: String, eventIdsJson: String, serverTime: Long) {
        val index = rows.indexOfFirst { it.first.requestId == requestId }
        check(index >= 0 && rows[index].second.state in setOf("pending", "sending", "done"))
        val ack = AckRow(identity.account, identity.deviceId, identity.fingerprint, requestId, entityId, eventIdsJson, serverTime)
        check(acks[requestId] == null || acks[requestId] == ack)
        acks[requestId] = ack
        rows[index] = rows[index].first to rows[index].second.copy(state = "done")
    }
    override suspend fun ack(requestId: String) = acks[requestId]
    override suspend fun recordRejection(requestId: String, code: String) {
        require(code.isNotBlank())
        val index = rows.indexOfFirst { it.first.requestId == requestId }
        check(index >= 0 && rows[index].second.state in setOf("pending", "sending"))
        rows[index] = rows[index].first to rows[index].second.copy(state = "review", rejectionCode = code)
    }
    override suspend fun markSending(ids: List<String>) {
        check(ids.all { id -> rows.any { it.first.requestId == id && it.second.state == "pending" } })
        ids.forEach { id ->
            val index = rows.indexOfFirst { it.first.requestId == id }
            rows[index] = rows[index].first to rows[index].second.copy(state = "sending")
        }
    }
    override suspend fun resetSending() {
        rows.indices.forEach { i -> if (rows[i].second.state == "sending")
            rows[i] = rows[i].first to rows[i].second.copy(state = "pending") }
    }
    override suspend fun cursor() = token
    override suspend fun setCursor(cursor: String?) { check(cursor == null || !held); token = cursor }
    override suspend fun syncHealth() = health
    override suspend fun setSyncHealth(value: String) { require(value.isNotBlank()); check(!held || value == "held_for_review"); health = value }
    override suspend fun holdForReview() { held = true; token = null; health = "held_for_review" }
    override suspend fun customers() = active?.localCustomers ?: emptyList()
    private val drafts = linkedMapOf<String, com.sunpride.field.orders.OrderDraft>()
    override suspend fun orderDrafts() = drafts.values.sortedWith(compareBy({ it.createdAt }, { it.draftId }))
    override suspend fun saveOrderDraft(draft: com.sunpride.field.orders.OrderDraft) {
        if (held) throw com.sunpride.field.orders.OrderDraftFailure(com.sunpride.field.orders.OrderDraftFailure.Code.HELD)
        check(active != null)
        com.sunpride.field.orders.OrderDraftRules.validate(this, draft, drafts[draft.draftId])
        drafts[draft.draftId] = draft
    }
    override suspend fun discardOrderDraft(draftId: String) {
        if (held) throw com.sunpride.field.orders.OrderDraftFailure(com.sunpride.field.orders.OrderDraftFailure.Code.HELD)
        val existing = drafts[draftId] ?: error("Unknown draft")
        if (existing.submittedRequestId != null)
            throw com.sunpride.field.orders.OrderDraftFailure(com.sunpride.field.orders.OrderDraftFailure.Code.SUBMITTED)
        check(drafts.remove(draftId) != null)
    }
    /** Same all-or-nothing contract as Room: a failed enqueue leaves the draft editable. */
    override suspend fun submitOrderDraft(draftId: String, intent: IntentRow, now: Long) {
        if (held) throw com.sunpride.field.orders.OrderDraftFailure(com.sunpride.field.orders.OrderDraftFailure.Code.HELD)
        if (!isLeaseValid(now))
            throw com.sunpride.field.orders.OrderDraftFailure(com.sunpride.field.orders.OrderDraftFailure.Code.OFFLINE_EXPIRED)
        val existing = drafts[draftId] ?: error("Unknown draft")
        if (existing.submittedRequestId != null)
            throw com.sunpride.field.orders.OrderDraftFailure(com.sunpride.field.orders.OrderDraftFailure.Code.SUBMITTED)
        com.sunpride.field.orders.OrderQueueRules.requireIntentFor(draftId, intent)
        // Order rules first, so an ended call reads as an order refusal (CALL_ENDED), not a generic visit one.
        com.sunpride.field.orders.OrderQueueRules.validate(this, intent)
        enqueue(intent, now)
        drafts[draftId] = existing.copy(submittedRequestId = intent.requestId, submittedAt = now)
    }

    // AND-016 photos: same validation and state rules as Room.
    val photos = mutableListOf<EvidencePhotoRow>()
    override suspend fun photoTypes() = active?.photoTypes ?: emptyList()
    override suspend fun addPhoto(row: EvidencePhotoRow, now: Long) {
        require(row.account == identity.account && row.deviceId == identity.deviceId && row.scope == identity.fingerprint)
        check(isLeaseValid(now))
        EvidencePhotos.validate(row, photoTypes(), rows.map { it.first to it.second.state },
            photos.count { it.clientVisitId == row.clientVisitId })
        check(photos.none { it.localId == row.localId })
        photos += row
    }
    override suspend fun visitPhotos(clientVisitId: String) = photos.filter { it.clientVisitId == clientVisitId }
    override suspend fun pendingPhotos() = photos.filter { it.state == "pending" }.sortedBy { it.createdAt }
    private fun photoIndex(localId: String) = photos.indexOfFirst { it.localId == localId }.also { check(it >= 0) }
    override suspend fun markPhotoUploaded(localId: String, evidenceId: String, at: Long) {
        val i = photoIndex(localId)
        if (photos[i].state == "uploaded") check(photos[i].evidenceId == evidenceId)
        else { check(photos[i].state == "pending"); photos[i] = photos[i].copy(state = "uploaded", evidenceId = evidenceId, uploadedAt = at) }
    }
    override suspend fun countPhotoAttempt(localId: String): Int {
        val i = photoIndex(localId); check(photos[i].state == "pending")
        photos[i] = photos[i].copy(attempts = photos[i].attempts + 1); return photos[i].attempts
    }
    override suspend fun reviewPhoto(localId: String, code: String) {
        val i = photoIndex(localId); check(photos[i].state == "pending")
        photos[i] = photos[i].copy(state = "review", reviewCode = code)
    }
}
