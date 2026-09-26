package com.sunpride.field.storage

import android.content.Context
import androidx.room.Room
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.room.withTransaction
import net.zetetic.database.sqlcipher.SupportOpenHelperFactory
import java.util.UUID
import org.json.JSONObject

/** An authenticated partition, not an employee ID or an untrusted UI-selected unit. */
data class StoreScope(val account: String, val deviceId: String, val fingerprint: String) {
    init { require(account.isNotBlank() && deviceId.isNotBlank() && fingerprint.isNotBlank()) }
}

/** Supported server-owned bootstrap fields only; no product, price, order or stock rows. */
data class ScopedSnapshot(val employeeJson: String, val routeJson: String?,
    val visits: List<SnapshotItem>, val outlets: List<SnapshotItem>,
    val localCustomers: List<SnapshotItem>, val tasks: List<SnapshotItem>)
data class SnapshotItem(val id: String, val json: String, val serviceDate: String? = null)

interface FieldStore {
    /** Stage all pages under a unique generation. No reader sees these rows before promotion. */
    suspend fun stage(snapshot: ScopedSnapshot): String
    /** Promote only after the last bootstrap page and non-null final cursor. */
    suspend fun swap(generation: String, cursor: String, leaseExpiresAt: Long, cacheExpiresAt: Long,
                     releaseHeld: Boolean = false)
    suspend fun todaysVisits(day: String): List<SnapshotItem>
    suspend fun outlets(): List<SnapshotItem>
    suspend fun isLeaseValid(now: Long): Boolean
    /** Immutable serialized v1 operation and UUID. A crash cannot persist just one of intent/outbox. */
    suspend fun enqueue(intent: IntentRow, now: Long)
    suspend fun pending(): List<Pair<IntentRow, OutboxRow>>
    suspend fun recordAck(requestId: String, entityId: String, eventIdsJson: String, serverTime: Long)
    suspend fun recordRejection(requestId: String, code: String)
    suspend fun ack(requestId: String): AckRow?
    suspend fun cursor(): String?
    suspend fun setCursor(cursor: String?)
    suspend fun syncHealth(): String
    suspend fun setSyncHealth(value: String)
    suspend fun markSyncSuccess(now: Long) { setSyncHealth("synced") }
    suspend fun markSending(ids: List<String>) {}
    suspend fun resetSending() {}
    suspend fun status(offline: Boolean = false): com.sunpride.field.ui.syncstatus.SyncStatus =
        com.sunpride.field.ui.syncstatus.SyncStatus(offline = offline)
    /** Sign-out, revoke or scope change: freeze pending work for supervised review; never delete it. */
    suspend fun holdForReview()
    suspend fun history(): List<Pair<IntentRow, OutboxRow>> = emptyList()
    suspend fun intent(requestId: String): IntentRow? = null
    suspend fun delta(entity: String, id: String): DeltaRow? = null
    suspend fun applyDelta(changes: List<DeltaRow>, nextCursor: String) { setCursor(nextCursor) }
    fun close() {}
}

object EncryptedFieldDatabase {
    val MIGRATION_1_2 = object : Migration(1, 2) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("CREATE TABLE IF NOT EXISTS `deltas` (`account` TEXT NOT NULL, `deviceId` TEXT NOT NULL, `scope` TEXT NOT NULL, `entity` TEXT NOT NULL, `entityId` TEXT NOT NULL, `revision` INTEGER NOT NULL, `json` TEXT, `tombstone` INTEGER NOT NULL, PRIMARY KEY(`account`, `deviceId`, `scope`, `entity`, `entityId`))")
        }
    }
    val MIGRATION_2_3 = object : Migration(2, 3) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("ALTER TABLE `partitions` ADD COLUMN `lastSuccessfulSync` INTEGER")
        }
    }
    fun open(context: Context): StoreDatabase {
        System.loadLibrary("sqlcipher")
        val passphrase = PassphraseVault(context).passphrase()
        return Room.databaseBuilder(context.applicationContext, StoreDatabase::class.java, PassphraseVault.DB_NAME)
            .openHelperFactory(SupportOpenHelperFactory(passphrase))
            .addMigrations(MIGRATION_1_2, MIGRATION_2_3)
            .build()
    }

    /** A logout/revocation may happen before a scope is available; hold every local partition. */
    suspend fun holdExisting(context: Context) {
        if (!context.databaseList().contains(PassphraseVault.DB_NAME)) return
        val db = open(context)
        try { db.withTransaction { db.rows().holdAllPartitions() } }
        finally { db.close() }
    }
}

class RoomFieldStore(private val db: StoreDatabase, private val identity: StoreScope) : FieldStore {
    private val dao = db.rows()
    override fun close() = db.close()
    private val a get() = identity.account
    private val d get() = identity.deviceId
    private val s get() = identity.fingerprint
    private suspend fun metadata() = dao.partition(a, d, s) ?: PartitionRow(a, d, s)

    override suspend fun stage(snapshot: ScopedSnapshot): String {
        require(snapshot.employeeJson.isNotBlank())
        val generation = UUID.randomUUID().toString()
        val groups = listOf("visit" to snapshot.visits, "outlet" to snapshot.outlets,
            "customer" to snapshot.localCustomers, "task" to snapshot.tasks)
        db.withTransaction {
            for ((kind, items) in groups) for (item in items) {
                require(item.id.isNotBlank() && item.json.isNotBlank())
                dao.insertSnapshot(SnapshotRow(a, d, s, generation, kind, item.id, item.json, item.serviceDate))
            }
            // Stage metadata is deliberately not active. Empty snapshots are valid; marker row carries metadata.
            dao.insertSnapshot(SnapshotRow(a, d, s, generation, "meta", "bootstrap",
                JSONObject().put("employee", snapshot.employeeJson)
                    .put("route", snapshot.routeJson ?: JSONObject.NULL).toString()))
        }
        return generation
    }

    override suspend fun swap(generation: String, cursor: String, leaseExpiresAt: Long, cacheExpiresAt: Long,
                              releaseHeld: Boolean) {
        require(generation.isNotBlank() && cursor.isNotBlank() && leaseExpiresAt > 0 && cacheExpiresAt > 0)
        db.withTransaction {
            val marker = dao.snapshot(a, d, s, generation, "meta", null).singleOrNull()
                ?: error("Unstaged snapshot")
            val old = metadata()
            val header = JSONObject(marker.json)
            dao.putPartition(old.copy(activeGeneration = generation, employeeJson = header.getString("employee"),
                routeJson = if (header.isNull("route")) null else header.getString("route"),
                cursor = if (old.held && !releaseHeld) null else cursor, leaseExpiresAt = leaseExpiresAt,
                cacheExpiresAt = cacheExpiresAt, held = old.held && !releaseHeld,
                syncHealth = if (old.held && !releaseHeld) "held_for_review" else "synced",
                lastSuccessfulSync = if (old.held && !releaseHeld) old.lastSuccessfulSync else System.currentTimeMillis()))
            dao.discardOldSnapshots(a, d, s, generation)
            // No intent, ack, or outbox table is touched by promotion or cursor reset.
        }
    }

    private suspend fun read(kind: String, day: String? = null): List<SnapshotItem> {
        val generation = metadata().activeGeneration ?: return emptyList()
        return dao.snapshot(a, d, s, generation, kind, day).map { SnapshotItem(it.entityId, it.json, it.serviceDate) }
    }
    override suspend fun todaysVisits(day: String): List<SnapshotItem> = read("visit", day)
    override suspend fun outlets(): List<SnapshotItem> = read("outlet")
    override suspend fun isLeaseValid(now: Long): Boolean = metadata().let {
        !it.held && it.leaseExpiresAt != null && now < it.leaseExpiresAt && it.activeGeneration != null
    }

    override suspend fun enqueue(intent: IntentRow, now: Long) = enqueueWithCheckpoint(intent, now) {}

    /** Test seam: throwing after the intent insertion proves Room rolls back both rows. */
    internal suspend fun enqueueWithCheckpoint(intent: IntentRow, now: Long, checkpoint: () -> Unit) {
        require(intent.account == a && intent.deviceId == d && intent.scope == s)
        require(intent.requestId.isNotBlank() && intent.clientVisitId.isNotBlank() &&
            intent.kind in setOf("visit.checkIn", "visit.activity", "visit.checkOut") &&
            intent.serializedOperation.isNotBlank())
        db.withTransaction {
            check(isLeaseValid(now)) { "Offline lease expired or held" }
            val orderedAt = maxOf(intent.createdAt, (dao.latestCreatedAt(a, d, s) ?: Long.MIN_VALUE) + 1)
            dao.insertIntent(intent.copy(createdAt = orderedAt))
            checkpoint()
            dao.insertOutbox(OutboxRow(a, d, s, intent.requestId, orderedAt))
        }
    }

    override suspend fun pending(): List<Pair<IntentRow, OutboxRow>> = dao.pending(a, d, s)
        .map { row -> (dao.intent(a, d, s, row.requestId) ?: error("Orphaned outbox")) to row }

    override suspend fun recordAck(requestId: String, entityId: String, eventIdsJson: String, serverTime: Long) {
        db.withTransaction {
            val row = dao.outbox(a, d, s, requestId) ?: error("Unknown request")
            check(row.state == "pending" || row.state == "done")
            val prior = dao.ack(a, d, s, requestId)
            val ack = AckRow(a, d, s, requestId, entityId, eventIdsJson, serverTime)
            if (prior == null) dao.insertAck(ack) else check(prior == ack) { "Conflicting ack" }
            check(row.state == "done" || dao.markDone(a, d, s, requestId) == 1)
        }
    }
    override suspend fun recordRejection(requestId: String, code: String) {
        require(code.isNotBlank())
        db.withTransaction { check(dao.reject(a, d, s, requestId, code) == 1) }
    }
    override suspend fun ack(requestId: String): AckRow? = dao.ack(a, d, s, requestId)
    override suspend fun cursor(): String? = metadata().cursor
    override suspend fun setCursor(cursor: String?) {
        db.withTransaction {
            val old = metadata()
            check(cursor == null || !old.held) { "Partition held for review" }
            dao.putPartition(old.copy(cursor = cursor))
        }
    }
    override suspend fun syncHealth(): String = metadata().syncHealth
    override suspend fun setSyncHealth(value: String) {
        require(value.isNotBlank())
        db.withTransaction {
            val old = metadata()
            check(!old.held || value == "held_for_review") { "Partition held for review" }
            dao.putPartition(old.copy(syncHealth = value))
        }
    }
    override suspend fun markSyncSuccess(now: Long) {
        db.withTransaction {
            val old = metadata()
            check(!old.held)
            dao.putPartition(old.copy(syncHealth = "synced", lastSuccessfulSync = now))
        }
    }
    override suspend fun markSending(ids: List<String>) {
        db.withTransaction { ids.forEach { check(dao.markSending(a, d, s, it) == 1) } }
    }
    override suspend fun resetSending() {
        db.withTransaction { dao.resetSending(a, d, s) }
    }
    override suspend fun status(offline: Boolean): com.sunpride.field.ui.syncstatus.SyncStatus =
        com.sunpride.field.ui.syncstatus.SyncStatus.fromRoom(dao.partition(a, d, s),
            dao.outstandingForDevice(a, d), offline)
    override suspend fun history(): List<Pair<IntentRow, OutboxRow>> = dao.allOutbox(a, d, s)
        .map { row -> (dao.intent(a, d, s, row.requestId) ?: error("Orphaned outbox")) to row }
    override suspend fun intent(requestId: String): IntentRow? = dao.intent(a, d, s, requestId)
    override suspend fun delta(entity: String, id: String): DeltaRow? = dao.delta(a, d, s, entity, id)
    override suspend fun applyDelta(changes: List<DeltaRow>, nextCursor: String) {
        require(nextCursor.isNotBlank())
        db.withTransaction {
            val old = metadata()
            check(!old.held && old.activeGeneration != null)
            // Keep server changes in a separate revision projection: a pending local visit intent
            // never gets overwritten by an upsert or tombstone. UI can overlay it explicitly.
            for (change in changes) {
                require(change.account == a && change.deviceId == d && change.scope == s &&
                    change.entity in setOf("visit", "activity") && change.revision > 0)
                val prior = dao.delta(a, d, s, change.entity, change.entityId)
                if (prior == null || change.revision > prior.revision) dao.putDelta(change)
            }
            dao.putPartition(old.copy(cursor = nextCursor))
        }
    }
    override suspend fun holdForReview() {
        db.withTransaction {
            dao.putPartition(metadata().copy(held = true, cursor = null, syncHealth = "held_for_review"))
            // Pending rows remain durable. Reauthorization must explicitly reconcile before retry.
        }
    }
}
