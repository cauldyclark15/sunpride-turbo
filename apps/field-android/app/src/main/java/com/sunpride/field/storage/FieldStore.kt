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

/** Server-owned bootstrap, including account-scoped Annex C setup (not an order/stock ledger). */
data class ScopedSnapshot(val employeeJson: String, val routeJson: String?,
    val visits: List<SnapshotItem>, val outlets: List<SnapshotItem>,
    val localCustomers: List<SnapshotItem>, val tasks: List<SnapshotItem>,
    val callSheets: List<CallSheet> = emptyList(),
    /** AND-013 activity-form rules per visit intent; empty from servers that predate them. */
    val activityRules: List<ActivityRule> = emptyList(),
    /** AND-016 visit photo types; empty from servers that predate them (defaults apply). */
    val photoTypes: List<PhotoType> = emptyList(),
    val productCatalog: List<CatalogProduct> = emptyList(),
    val inventoryAvailability: List<InventoryAvailability> = emptyList())
data class SnapshotItem(val id: String, val json: String, val serviceDate: String? = null, val listPosition: Int? = null)

interface FieldStore {
    /** Stage all pages under a unique generation. No reader sees these rows before promotion. */
    suspend fun stage(snapshot: ScopedSnapshot): String
    /** Promote only after the last bootstrap page and non-null final cursor. */
    suspend fun swap(generation: String, cursor: String, leaseExpiresAt: Long, cacheExpiresAt: Long,
                     releaseHeld: Boolean = false)
    suspend fun todaysVisits(day: String): List<SnapshotItem>
    suspend fun outlets(): List<SnapshotItem>
    suspend fun callSheet(outletId: String): CallSheet? = null
    suspend fun catalog(): List<CatalogProduct> = emptyList()
    suspend fun availability(productId: String): List<InventoryAvailability> = emptyList()
    suspend fun activityRules(): List<ActivityRule> = emptyList()
    /** AND-016: downloaded photo types (may be empty; see [EvidencePhotos.offered]). */
    suspend fun photoTypes(): List<PhotoType> = emptyList()
    /** Durable photo metadata for an open call; the encrypted file is written first by the caller. */
    suspend fun addPhoto(row: EvidencePhotoRow, now: Long) { error("No photo store") }
    suspend fun visitPhotos(clientVisitId: String): List<EvidencePhotoRow> = emptyList()
    /** Photos still to upload, oldest first. Independent of the visit outbox. */
    suspend fun pendingPhotos(): List<EvidencePhotoRow> = emptyList()
    suspend fun markPhotoUploaded(localId: String, evidenceId: String, at: Long) {}
    /** Records one failed try; returns the new attempt count. */
    suspend fun countPhotoAttempt(localId: String): Int = 0
    suspend fun reviewPhoto(localId: String, code: String) {}
    suspend fun customers(): List<SnapshotItem> = emptyList()
    /** Every planned visit in the downloaded horizon, not just one day (customer detail). */
    suspend fun plannedVisits(): List<SnapshotItem> = emptyList()
    suspend fun tasks(): List<SnapshotItem> = emptyList()
    /** The active snapshot's route JSON (`{id, code}`), or null. */
    suspend fun route(): String? = null
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
    /**
     * QSR-010 confirmed revocation/suspension: hold as above AND drop the server-provided cache
     * (plan, outlets, customers, call sheets and prices, employee header, deltas, team summaries,
     * offline lease). Unsent intents, acks and photos stay encrypted for supervised recovery.
     */
    suspend fun purgeCacheForReview() = holdForReview()
    suspend fun history(): List<Pair<IntentRow, OutboxRow>> = emptyList()
    suspend fun intent(requestId: String): IntentRow? = null
    suspend fun delta(entity: String, id: String): DeltaRow? = null
    suspend fun applyDelta(changes: List<DeltaRow>, nextCursor: String) { setCursor(nextCursor) }
    /** Role from the active bootstrap's employee header: a UI hint only, the server authorizes. */
    suspend fun employeeRole(): String? = null
    /**
     * AND-020 small server summaries saved for offline display, kept in this partition's deltas table
     * under a reserved `local.` entity (server deltas are only `visit`/`activity`), so no migration.
     */
    suspend fun localCache(entity: String, key: String): DeltaRow? = null
    /** Save one summary and drop this entity's rows whose key does not start with [keepPrefix]. */
    suspend fun putLocalCache(entity: String, key: String, json: String, at: Long, keepPrefix: String) {}
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
    val MIGRATION_3_4 = object : Migration(3, 4) {
        override fun migrate(db: SupportSQLiteDatabase) {
            // Existing rows keep their former entityId order; new bootstraps retain wire list order.
            db.execSQL("ALTER TABLE `snapshots` ADD COLUMN `snapshotOrder` INTEGER NOT NULL DEFAULT 0")
            db.execSQL("UPDATE snapshots SET snapshotOrder = (SELECT COUNT(*) FROM snapshots AS prior WHERE prior.account=snapshots.account AND prior.deviceId=snapshots.deviceId AND prior.scope=snapshots.scope AND prior.generation=snapshots.generation AND prior.kind=snapshots.kind AND prior.entityId<snapshots.entityId)")
        }
    }
    /** Annex C account sheets (SP-0007) layered on main's v4 field-day schema. */
    val MIGRATION_4_5 = object : Migration(4, 5) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("CREATE TABLE IF NOT EXISTS `call_sheets` (`account` TEXT NOT NULL, `deviceId` TEXT NOT NULL, `scope` TEXT NOT NULL, `generation` TEXT NOT NULL, `outletId` TEXT NOT NULL, `revision` INTEGER NOT NULL, `headerJson` TEXT NOT NULL, PRIMARY KEY(`account`, `deviceId`, `scope`, `generation`, `outletId`))")
            db.execSQL("CREATE TABLE IF NOT EXISTS `call_sheet_lines` (`account` TEXT NOT NULL, `deviceId` TEXT NOT NULL, `scope` TEXT NOT NULL, `generation` TEXT NOT NULL, `outletId` TEXT NOT NULL, `productId` TEXT NOT NULL, `position` INTEGER NOT NULL, `code` TEXT NOT NULL, `name` TEXT NOT NULL, `uom` TEXT NOT NULL, `barcode` TEXT, `pricing` TEXT, PRIMARY KEY(`account`, `deviceId`, `scope`, `generation`, `outletId`, `productId`))")
        }
    }
    /** AND-016 visit photo metadata (the encrypted JPEG stays outside the database). */
    val MIGRATION_5_6 = object : Migration(5, 6) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("CREATE TABLE IF NOT EXISTS `evidence_photos` (`account` TEXT NOT NULL, `deviceId` TEXT NOT NULL, `scope` TEXT NOT NULL, `localId` TEXT NOT NULL, `clientVisitId` TEXT NOT NULL, `checkInRequestId` TEXT NOT NULL, `outletId` TEXT NOT NULL, `photoType` TEXT NOT NULL, `mime` TEXT NOT NULL, `sizeBytes` INTEGER NOT NULL, `sha256` TEXT NOT NULL, `capturedAt` INTEGER NOT NULL, `createdAt` INTEGER NOT NULL, `state` TEXT NOT NULL, `attempts` INTEGER NOT NULL, `evidenceId` TEXT, `reviewCode` TEXT, `uploadedAt` INTEGER, PRIMARY KEY(`account`, `deviceId`, `scope`, `localId`))")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_evidence_photos_account_deviceId_scope_clientVisitId` ON `evidence_photos` (`account`, `deviceId`, `scope`, `clientVisitId`)")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_evidence_photos_account_deviceId_scope_state_createdAt` ON `evidence_photos` (`account`, `deviceId`, `scope`, `state`, `createdAt`)")
        }
    }
    /** SP-0051 scoped product catalog and inventory availability, layered on main's v6. */
    val MIGRATION_6_7 = object : Migration(6, 7) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("CREATE TABLE IF NOT EXISTS `catalog_products` (`account` TEXT NOT NULL, `deviceId` TEXT NOT NULL, `scope` TEXT NOT NULL, `generation` TEXT NOT NULL, `id` TEXT NOT NULL, `code` TEXT NOT NULL, `revision` INTEGER NOT NULL, `json` TEXT NOT NULL, PRIMARY KEY(`account`, `deviceId`, `scope`, `generation`, `id`))")
            db.execSQL("CREATE TABLE IF NOT EXISTS `inventory_availability` (`account` TEXT NOT NULL, `deviceId` TEXT NOT NULL, `scope` TEXT NOT NULL, `generation` TEXT NOT NULL, `id` TEXT NOT NULL, `productId` TEXT NOT NULL, `locationCode` TEXT NOT NULL, `revision` INTEGER NOT NULL, `json` TEXT NOT NULL, PRIMARY KEY(`account`, `deviceId`, `scope`, `generation`, `id`))")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_inventory_availability_account_deviceId_scope_generation_productId` ON `inventory_availability` (`account`, `deviceId`, `scope`, `generation`, `productId`)")
        }
    }
    fun open(context: Context): StoreDatabase {
        System.loadLibrary("sqlcipher")
        val passphrase = PassphraseVault(context).passphrase()
        return Room.databaseBuilder(context.applicationContext, StoreDatabase::class.java, PassphraseVault.DB_NAME)
            .openHelperFactory(SupportOpenHelperFactory(passphrase))
            .addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4, MIGRATION_4_5, MIGRATION_5_6, MIGRATION_6_7)
            .build()
    }

    /** A logout/revocation may happen before a scope is available; hold every local partition. */
    suspend fun holdExisting(context: Context) {
        if (!context.databaseList().contains(PassphraseVault.DB_NAME)) return
        val db = open(context)
        try { db.withTransaction { db.rows().holdAllPartitions() } }
        finally { db.close() }
    }

    /**
     * QSR-010 sign-out and confirmed revocation: hold every partition and remove every cached server
     * projection, keeping only unsent/acknowledged evidence (ADR-020). Freed pages are zeroed and the
     * WAL truncated so the removed rows do not linger in the encrypted file.
     */
    suspend fun purgeExisting(context: Context) {
        if (!context.databaseList().contains(PassphraseVault.DB_NAME)) return
        val db = open(context)
        try { purge(db, null) } finally { db.close() }
    }

    internal suspend fun purge(db: StoreDatabase, scope: StoreScope?) {
        val dao = db.rows()
        val (a, d, s) = Triple(scope?.account, scope?.deviceId, scope?.fingerprint)
        db.withTransaction {
            db.openHelper.writableDatabase.query("PRAGMA secure_delete=ON").use { it.moveToFirst() }
            dao.purgeSnapshots(a, d, s)
            dao.purgeCallSheets(a, d, s)
            dao.purgeCallSheetLines(a, d, s)
            dao.purgeProducts(a, d, s)
            dao.purgeAvailability(a, d, s)
            dao.purgeDeltas(a, d, s)
            dao.purgePartitionMetadata(a, d, s)
        }
        runCatching { db.openHelper.writableDatabase.query("PRAGMA wal_checkpoint(TRUNCATE)").use { it.moveToFirst() } }
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
            "customer" to snapshot.localCustomers, "task" to snapshot.tasks,
            // Rules ride the generic snapshot table (keyed by intent): no schema migration.
            "activity_rule" to snapshot.activityRules.map { SnapshotItem(it.intent, ActivityRules.encode(it).toString()) },
            // AND-016 photo types ride the same table, in wire order (keyed by code).
            "photo_type" to snapshot.photoTypes.map { SnapshotItem(it.code, EvidencePhotos.encode(it).toString()) })
        db.withTransaction {
            for ((kind, items) in groups) for ((position, item) in items.withIndex()) {
                require(item.id.isNotBlank() && item.json.isNotBlank())
                dao.insertSnapshot(SnapshotRow(a, d, s, generation, kind, item.id, item.json, item.serviceDate, position))
            }
            for (sheet in snapshot.callSheets) {
                // Validate before storing: empty setup lines are allowed, duplicate products are not.
                CallSheetCodec.decode(CallSheetCodec.encode(sheet))
                dao.insertCallSheet(CallSheetRow(a, d, s, generation, sheet.outletId, sheet.revision,
                    CallSheetCodec.encodeHeader(sheet.header).toString()))
                sheet.lines.forEachIndexed { index, p ->
                    dao.insertCallSheetLine(CallSheetLineRow(a, d, s, generation, sheet.outletId,
                        p.productId, index, p.code, p.name, p.uom, p.barcode, p.pricing))
                }
            }
            for (p in snapshot.productCatalog) {
                val json = ReferenceDataCodec.encode(p)
                ReferenceDataCodec.product(json)
                dao.insertProduct(CatalogProductRow(a, d, s, generation, p.id, p.code, p.revision, json.toString()))
            }
            for (i in snapshot.inventoryAvailability) {
                val json = ReferenceDataCodec.encode(i)
                ReferenceDataCodec.availability(json)
                dao.insertAvailability(InventoryAvailabilityRow(a, d, s, generation, i.id, i.productId,
                    i.locationCode, i.revision, json.toString()))
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
            dao.discardOldCallSheets(a, d, s, generation)
            dao.discardOldCallSheetLines(a, d, s, generation)
            dao.discardOldProducts(a, d, s, generation)
            dao.discardOldAvailability(a, d, s, generation)
            // No intent, ack, or outbox table is touched by promotion or cursor reset.
        }
    }

    private suspend fun read(kind: String, day: String? = null): List<SnapshotItem> {
        val generation = metadata().activeGeneration ?: return emptyList()
        return dao.snapshot(a, d, s, generation, kind, day).map { SnapshotItem(it.entityId, it.json, it.serviceDate, it.snapshotOrder) }
    }
    override suspend fun todaysVisits(day: String): List<SnapshotItem> =
        VisitCallRules.ordered(read("visit", day))
    override suspend fun outlets(): List<SnapshotItem> = read("outlet")
    override suspend fun callSheet(outletId: String): CallSheet? = db.withTransaction {
        val generation = metadata().activeGeneration ?: return@withTransaction null
        val row = dao.callSheet(a, d, s, generation, outletId) ?: return@withTransaction null
        CallSheet(row.outletId, row.revision, CallSheetCodec.header(JSONObject(row.headerJson)),
            dao.callSheetLines(a, d, s, generation, outletId).map {
                CallSheetProduct(it.productId, it.code, it.name, it.uom, it.barcode, it.pricing)
            })
    }
    override suspend fun catalog(): List<CatalogProduct> = db.withTransaction {
        val generation = metadata().activeGeneration ?: return@withTransaction emptyList()
        dao.catalog(a, d, s, generation).map { ReferenceDataCodec.product(JSONObject(it.json)) }
    }
    override suspend fun availability(productId: String): List<InventoryAvailability> = db.withTransaction {
        val generation = metadata().activeGeneration ?: return@withTransaction emptyList()
        dao.availability(a, d, s, generation, productId).map { ReferenceDataCodec.availability(JSONObject(it.json)) }
    }
    override suspend fun activityRules(): List<ActivityRule> =
        read("activity_rule").map { ActivityRules.decode(JSONObject(it.json)) }
    override suspend fun photoTypes(): List<PhotoType> =
        read("photo_type").map { EvidencePhotos.decode(JSONObject(it.json)) }
    override suspend fun addPhoto(row: EvidencePhotoRow, now: Long) {
        require(row.account == a && row.deviceId == d && row.scope == s)
        db.withTransaction {
            check(isLeaseValid(now)) { "Offline lease expired or held" }
            EvidencePhotos.validate(row, photoTypes(), history().map { it.first to it.second.state },
                dao.visitPhotos(a, d, s, row.clientVisitId).size)
            dao.insertPhoto(row)
        }
    }
    override suspend fun visitPhotos(clientVisitId: String): List<EvidencePhotoRow> = dao.visitPhotos(a, d, s, clientVisitId)
    override suspend fun pendingPhotos(): List<EvidencePhotoRow> = dao.pendingPhotos(a, d, s)
    override suspend fun markPhotoUploaded(localId: String, evidenceId: String, at: Long) {
        require(evidenceId.isNotBlank())
        db.withTransaction {
            val row = dao.photo(a, d, s, localId) ?: error("Unknown photo")
            // A replayed success for an already-uploaded photo must name the same server row.
            if (row.state == "uploaded") check(row.evidenceId == evidenceId) { "Conflicting evidence" }
            else check(dao.markPhotoUploaded(a, d, s, localId, evidenceId, at) == 1)
        }
    }
    override suspend fun countPhotoAttempt(localId: String): Int = db.withTransaction {
        check(dao.countPhotoAttempt(a, d, s, localId) == 1)
        dao.photo(a, d, s, localId)!!.attempts
    }
    override suspend fun reviewPhoto(localId: String, code: String) {
        require(code.isNotBlank())
        db.withTransaction { check(dao.reviewPhoto(a, d, s, localId, code) == 1) }
    }
    override suspend fun customers(): List<SnapshotItem> = read("customer")
    override suspend fun plannedVisits(): List<SnapshotItem> = read("visit")
    override suspend fun tasks(): List<SnapshotItem> = read("task")
    override suspend fun route(): String? = metadata().takeIf { it.activeGeneration != null }?.routeJson
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
            val payload = JSONObject(intent.serializedOperation).optJSONObject("payload")
            if (intent.kind == "visit.checkIn") {
                val day = payload?.getString("serviceDate") ?: error("Missing service date")
                VisitCallRules.requireStart(payload.optString("plannedVisitId").takeUnless { it.isBlank() || it == "null" },
                    payload.getString("outletId"), day, todaysVisits(day), history().map { it.first to it.second.state })
            } else if (intent.kind == "visit.checkOut") {
                VisitCallRules.requireEnd(intent.clientVisitId, payload ?: error("Missing outcome"),
                    history().map { it.first to it.second.state })
            }
            VisitCompletion.requireOpenForActivity(intent, history().map { it.first to it.second.state })
            CallSheetQueueRules.validate(this@RoomFieldStore, intent)
            ActivityQueueRules.validate(this@RoomFieldStore, intent)
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
            check(row.state in setOf("pending", "sending", "done"))
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
            dao.outstandingForDevice(a, d), offline, history().map { it.first })
            .copy(photosWaiting = dao.waitingPhotos(a, d, s))
    override suspend fun history(): List<Pair<IntentRow, OutboxRow>> = dao.allOutbox(a, d, s)
        .map { row -> (dao.intent(a, d, s, row.requestId) ?: error("Orphaned outbox")) to row }
    override suspend fun intent(requestId: String): IntentRow? = dao.intent(a, d, s, requestId)
    override suspend fun delta(entity: String, id: String): DeltaRow? = db.withTransaction {
        if (entity !in setOf("product", "inventory")) return@withTransaction dao.delta(a, d, s, entity, id)
        val generation = metadata().activeGeneration ?: return@withTransaction null
        if (entity == "product") dao.product(a, d, s, generation, id)?.let {
            DeltaRow(a, d, s, entity, id, it.revision, it.json, false)
        } else dao.inventory(a, d, s, generation, id)?.let {
            DeltaRow(a, d, s, entity, id, it.revision, it.json, false)
        }
    }
    override suspend fun applyDelta(changes: List<DeltaRow>, nextCursor: String) {
        require(nextCursor.isNotBlank())
        db.withTransaction {
            val old = metadata()
            check(!old.held && old.activeGeneration != null)
            // Keep server changes in a separate revision projection: a pending local visit intent
            // never gets overwritten by an upsert or tombstone. UI can overlay it explicitly.
            for (change in changes) {
                require(change.account == a && change.deviceId == d && change.scope == s &&
                    change.entity in setOf("visit", "activity", "product", "inventory") && change.revision > 0)
                val generation = old.activeGeneration
                when (change.entity) {
                    "product" -> {
                        val p = ReferenceDataCodec.productChange(change)
                        val prior = dao.product(a, d, s, generation, p.id)
                        if (prior == null || p.revision >= prior.revision) {
                            dao.putProduct(CatalogProductRow(a, d, s, generation, p.id, p.code, p.revision,
                                ReferenceDataCodec.encode(p).toString()))
                            dao.refreshCallSheetProduct(a, d, s, p.id, p.code, p.name, p.uom,
                                p.barcodes.firstOrNull()?.barcode)
                        }
                    }
                    "inventory" -> {
                        val i = ReferenceDataCodec.inventoryChange(change)
                        val prior = dao.inventory(a, d, s, generation, i.id)
                        if (prior == null || i.revision >= prior.revision)
                            dao.putAvailability(InventoryAvailabilityRow(a, d, s, generation, i.id,
                                i.productId, i.locationCode, i.revision, ReferenceDataCodec.encode(i).toString()))
                    }
                    else -> {
                        val prior = dao.delta(a, d, s, change.entity, change.entityId)
                        if (prior == null || change.revision > prior.revision) dao.putDelta(change)
                    }
                }
            }
            dao.putPartition(old.copy(cursor = nextCursor))
        }
    }
    override suspend fun employeeRole(): String? = metadata().takeIf { it.activeGeneration != null }?.employeeJson
        ?.let { runCatching { JSONObject(it).optString("role") }.getOrNull() }?.takeIf { it.isNotBlank() }
    override suspend fun localCache(entity: String, key: String): DeltaRow? {
        require(entity.startsWith("local."))
        return dao.delta(a, d, s, entity, key)
    }
    override suspend fun putLocalCache(entity: String, key: String, json: String, at: Long, keepPrefix: String) {
        require(entity.startsWith("local.") && key.startsWith(keepPrefix) && json.isNotBlank() && at > 0)
        db.withTransaction {
            val old = metadata()
            // A held or never-bootstrapped partition keeps no new summaries.
            if (old.held || old.activeGeneration == null) return@withTransaction
            dao.deleteLocalDeltas(a, d, s, entity, keepPrefix)
            dao.putDelta(DeltaRow(a, d, s, entity, key, at, json, false))
        }
    }
    override suspend fun holdForReview() {
        db.withTransaction {
            dao.putPartition(metadata().copy(held = true, cursor = null, syncHealth = "held_for_review"))
            // Pending rows remain durable. Reauthorization must explicitly reconcile before retry.
        }
    }
    override suspend fun purgeCacheForReview() {
        dao.putPartition(metadata()) // ensure the partition row exists so the hold is recorded
        EncryptedFieldDatabase.purge(db, identity)
    }
}
