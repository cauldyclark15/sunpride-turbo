package com.sunpride.field.support

import com.sunpride.field.storage.*
import java.util.UUID

/** Mirrors Room's generation visibility, partition/lease checks, enqueue ordering and ack transaction. */
class FakeFieldStore(val identity: StoreScope) : FieldStore {
    private val staged = mutableMapOf<String, ScopedSnapshot>()
    private var active: ScopedSnapshot? = null
    private var lease = 0L
    private var token: String? = null
    private var held = false
    private var health = "never_synced"
    private val rows = mutableListOf<Pair<IntentRow, OutboxRow>>()
    private val acks = mutableMapOf<String, AckRow>()
    override suspend fun stage(snapshot: ScopedSnapshot): String {
        require(snapshot.employeeJson.isNotBlank())
        require(snapshot.callSheets.map { it.outletId }.distinct().size == snapshot.callSheets.size)
        snapshot.callSheets.forEach { CallSheetCodec.decode(CallSheetCodec.encode(it)) }
        return UUID.randomUUID().toString().also { staged[it] = snapshot }
    }
    override suspend fun swap(generation: String, cursor: String, leaseExpiresAt: Long, cacheExpiresAt: Long, releaseHeld: Boolean) {
        require(generation.isNotBlank() && cursor.isNotBlank() && leaseExpiresAt > 0 && cacheExpiresAt > 0)
        active = staged[generation] ?: error("Unstaged snapshot")
        lease = leaseExpiresAt
        held = held && !releaseHeld
        token = if (held) null else cursor
        health = if (held) "held_for_review" else "synced"
        staged.keys.retainAll(setOf(generation))
    }
    override suspend fun todaysVisits(day: String) = active?.visits?.filter { it.serviceDate == day } ?: emptyList()
    override suspend fun outlets() = active?.outlets ?: emptyList()
    override suspend fun callSheet(outletId: String) = active?.callSheets?.singleOrNull { it.outletId == outletId }
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
