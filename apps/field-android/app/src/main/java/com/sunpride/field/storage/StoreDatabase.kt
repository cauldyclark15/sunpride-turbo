package com.sunpride.field.storage

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.RoomDatabase

/** Every persisted row has an explicit auth-subject/device/scope partition. No destructive migration. */
@Entity(tableName = "snapshots", primaryKeys = ["account", "deviceId", "scope", "generation", "kind", "entityId"],
    indices = [Index(value = ["account", "deviceId", "scope", "generation"])])
data class SnapshotRow(val account: String, val deviceId: String, val scope: String,
    val generation: String, val kind: String, val entityId: String, val json: String,
    val serviceDate: String? = null, @ColumnInfo(defaultValue = "0") val snapshotOrder: Int = 0)

@Entity(tableName = "partitions", primaryKeys = ["account", "deviceId", "scope"])
data class PartitionRow(val account: String, val deviceId: String, val scope: String,
    val activeGeneration: String? = null, val employeeJson: String? = null,
    val routeJson: String? = null, val cursor: String? = null,
    val leaseExpiresAt: Long? = null, val cacheExpiresAt: Long? = null,
    val syncHealth: String = "never_synced", val held: Boolean = false,
    val lastSuccessfulSync: Long? = null)

@Entity(tableName = "intents", primaryKeys = ["account", "deviceId", "scope", "requestId"])
data class IntentRow(val account: String, val deviceId: String, val scope: String,
    val requestId: String, val clientVisitId: String, val kind: String,
    val serializedOperation: String, val createdAt: Long)

@Entity(tableName = "outbox", primaryKeys = ["account", "deviceId", "scope", "requestId"],
    indices = [Index(value = ["account", "deviceId", "scope", "createdAt", "requestId"])])
data class OutboxRow(val account: String, val deviceId: String, val scope: String,
    val requestId: String, val createdAt: Long, val state: String = "pending",
    val rejectionCode: String? = null)

@Entity(tableName = "acks", primaryKeys = ["account", "deviceId", "scope", "requestId"])
data class AckRow(val account: String, val deviceId: String, val scope: String,
    val requestId: String, val entityId: String, val eventIdsJson: String,
    val serverTime: Long)

@Entity(tableName = "deltas", primaryKeys = ["account", "deviceId", "scope", "entity", "entityId"])
data class DeltaRow(val account: String, val deviceId: String, val scope: String,
    val entity: String, val entityId: String, val revision: Long, val json: String?, val tombstone: Boolean)

@Entity(tableName = "call_sheets", primaryKeys = ["account", "deviceId", "scope", "generation", "outletId"])
data class CallSheetRow(val account: String, val deviceId: String, val scope: String,
    val generation: String, val outletId: String, val revision: Long, val headerJson: String)

@Entity(tableName = "call_sheet_lines", primaryKeys = ["account", "deviceId", "scope", "generation", "outletId", "productId"])
data class CallSheetLineRow(val account: String, val deviceId: String, val scope: String,
    val generation: String, val outletId: String, val productId: String, val position: Int,
    val code: String, val name: String, val uom: String, val barcode: String?, val pricing: String?)

/** Local-only order draft (SP-0061). Not an outbox row: nothing here is sent until review/submit exists. */
@Entity(tableName = "order_drafts", primaryKeys = ["account", "deviceId", "scope", "draftId"])
data class OrderDraftRow(val account: String, val deviceId: String, val scope: String, val draftId: String,
    val clientVisitId: String, val outletId: String, val serviceDate: String, val json: String,
    val createdAt: Long, val updatedAt: Long)

@Entity(tableName = "catalog_products", primaryKeys = ["account", "deviceId", "scope", "generation", "id"])
data class CatalogProductRow(val account: String, val deviceId: String, val scope: String,
    val generation: String, val id: String, val code: String, val revision: Long, val json: String)

@Entity(tableName = "inventory_availability", primaryKeys = ["account", "deviceId", "scope", "generation", "id"],
    indices = [Index(value = ["account", "deviceId", "scope", "generation", "productId"])])
data class InventoryAvailabilityRow(val account: String, val deviceId: String, val scope: String,
    val generation: String, val id: String, val productId: String, val locationCode: String,
    val revision: Long, val json: String)

/**
 * AND-016 visit photo: metadata only. The JPEG lives encrypted in no-backup app storage under
 * [localId]; [checkInRequestId] resolves the server visit from the check-in's durable ack.
 */
@Entity(tableName = "evidence_photos", primaryKeys = ["account", "deviceId", "scope", "localId"],
    indices = [Index(value = ["account", "deviceId", "scope", "clientVisitId"]),
        Index(value = ["account", "deviceId", "scope", "state", "createdAt"])])
data class EvidencePhotoRow(val account: String, val deviceId: String, val scope: String,
    val localId: String, val clientVisitId: String, val checkInRequestId: String, val outletId: String,
    val photoType: String, val mime: String, val sizeBytes: Long, val sha256: String,
    val capturedAt: Long, val createdAt: Long, val state: String = "pending", val attempts: Int = 0,
    val evidenceId: String? = null, val reviewCode: String? = null, val uploadedAt: Long? = null)

@Dao
interface StoreDao {
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertPhoto(row: EvidencePhotoRow)
    @Query("SELECT * FROM evidence_photos WHERE account=:account AND deviceId=:device AND scope=:scope AND clientVisitId=:clientVisitId ORDER BY createdAt, localId")
    suspend fun visitPhotos(account: String, device: String, scope: String, clientVisitId: String): List<EvidencePhotoRow>
    @Query("SELECT * FROM evidence_photos WHERE account=:account AND deviceId=:device AND scope=:scope AND state='pending' ORDER BY createdAt, localId")
    suspend fun pendingPhotos(account: String, device: String, scope: String): List<EvidencePhotoRow>
    @Query("SELECT * FROM evidence_photos WHERE account=:account AND deviceId=:device AND scope=:scope AND localId=:localId")
    suspend fun photo(account: String, device: String, scope: String, localId: String): EvidencePhotoRow?
    @Query("UPDATE evidence_photos SET state='uploaded', evidenceId=:evidenceId, uploadedAt=:at WHERE account=:account AND deviceId=:device AND scope=:scope AND localId=:localId AND state='pending'")
    suspend fun markPhotoUploaded(account: String, device: String, scope: String, localId: String, evidenceId: String, at: Long): Int
    @Query("UPDATE evidence_photos SET attempts=attempts+1 WHERE account=:account AND deviceId=:device AND scope=:scope AND localId=:localId AND state='pending'")
    suspend fun countPhotoAttempt(account: String, device: String, scope: String, localId: String): Int
    @Query("UPDATE evidence_photos SET state='review', reviewCode=:code WHERE account=:account AND deviceId=:device AND scope=:scope AND localId=:localId AND state='pending'")
    suspend fun reviewPhoto(account: String, device: String, scope: String, localId: String, code: String): Int
    @Query("SELECT COUNT(*) FROM evidence_photos WHERE account=:account AND deviceId=:device AND scope=:scope AND state='pending'")
    suspend fun waitingPhotos(account: String, device: String, scope: String): Int
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun putOrderDraft(row: OrderDraftRow)
    @Query("SELECT * FROM order_drafts WHERE account=:account AND deviceId=:device AND scope=:scope ORDER BY createdAt, draftId")
    suspend fun orderDrafts(account: String, device: String, scope: String): List<OrderDraftRow>
    @Query("SELECT * FROM order_drafts WHERE account=:account AND deviceId=:device AND scope=:scope AND draftId=:draftId")
    suspend fun orderDraft(account: String, device: String, scope: String, draftId: String): OrderDraftRow?
    @Query("DELETE FROM order_drafts WHERE account=:account AND deviceId=:device AND scope=:scope AND draftId=:draftId")
    suspend fun deleteOrderDraft(account: String, device: String, scope: String, draftId: String): Int
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertProduct(row: CatalogProductRow)
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun putProduct(row: CatalogProductRow)
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertAvailability(row: InventoryAvailabilityRow)
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun putAvailability(row: InventoryAvailabilityRow)
    @Query("SELECT * FROM catalog_products WHERE account=:account AND deviceId=:device AND scope=:scope AND generation=:generation ORDER BY code,id")
    suspend fun catalog(account: String, device: String, scope: String, generation: String): List<CatalogProductRow>
    @Query("SELECT * FROM catalog_products WHERE account=:account AND deviceId=:device AND scope=:scope AND generation=:generation AND id=:id")
    suspend fun product(account: String, device: String, scope: String, generation: String, id: String): CatalogProductRow?
    @Query("SELECT * FROM inventory_availability WHERE account=:account AND deviceId=:device AND scope=:scope AND generation=:generation AND productId=:productId ORDER BY locationCode,id")
    suspend fun availability(account: String, device: String, scope: String, generation: String, productId: String): List<InventoryAvailabilityRow>
    @Query("SELECT * FROM inventory_availability WHERE account=:account AND deviceId=:device AND scope=:scope AND generation=:generation AND id=:id")
    suspend fun inventory(account: String, device: String, scope: String, generation: String, id: String): InventoryAvailabilityRow?
    @Query("DELETE FROM catalog_products WHERE account=:account AND deviceId=:device AND scope=:scope AND generation!=:generation")
    suspend fun discardOldProducts(account: String, device: String, scope: String, generation: String)
    @Query("DELETE FROM inventory_availability WHERE account=:account AND deviceId=:device AND scope=:scope AND generation!=:generation")
    suspend fun discardOldAvailability(account: String, device: String, scope: String, generation: String)
    @Query("UPDATE call_sheet_lines SET code=:code,name=:name,uom=:uom,barcode=:barcode WHERE account=:account AND deviceId=:device AND scope=:scope AND productId=:productId")
    suspend fun refreshCallSheetProduct(account: String, device: String, scope: String, productId: String,
        code: String, name: String, uom: String, barcode: String?)
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertCallSheet(row: CallSheetRow)
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertCallSheetLine(row: CallSheetLineRow)
    @Query("SELECT * FROM call_sheets WHERE account=:account AND deviceId=:device AND scope=:scope AND generation=:generation AND outletId=:outlet")
    suspend fun callSheet(account: String, device: String, scope: String, generation: String, outlet: String): CallSheetRow?
    @Query("SELECT * FROM call_sheet_lines WHERE account=:account AND deviceId=:device AND scope=:scope AND generation=:generation AND outletId=:outlet ORDER BY position")
    suspend fun callSheetLines(account: String, device: String, scope: String, generation: String, outlet: String): List<CallSheetLineRow>
    @Query("DELETE FROM call_sheets WHERE account=:account AND deviceId=:device AND scope=:scope AND generation!=:generation")
    suspend fun discardOldCallSheets(account: String, device: String, scope: String, generation: String)
    @Query("DELETE FROM call_sheet_lines WHERE account=:account AND deviceId=:device AND scope=:scope AND generation!=:generation")
    suspend fun discardOldCallSheetLines(account: String, device: String, scope: String, generation: String)
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun putDelta(row: DeltaRow)
    @Query("DELETE FROM deltas WHERE account=:account AND deviceId=:device AND scope=:scope AND entity=:entity AND substr(entityId, 1, length(:keepPrefix)) != :keepPrefix")
    suspend fun deleteLocalDeltas(account: String, device: String, scope: String, entity: String, keepPrefix: String)
    @Query("DELETE FROM deltas WHERE account=:account AND deviceId=:device AND scope=:scope AND entity=:entity AND entityId=:id")
    suspend fun deleteDelta(account: String, device: String, scope: String, entity: String, id: String)
    @Query("SELECT * FROM deltas WHERE account=:account AND deviceId=:device AND scope=:scope AND entity=:entity AND entityId=:id")
    suspend fun delta(account: String, device: String, scope: String, entity: String, id: String): DeltaRow?
    @Query("SELECT MAX(createdAt) FROM outbox WHERE account=:account AND deviceId=:device AND scope=:scope")
    suspend fun latestCreatedAt(account: String, device: String, scope: String): Long?
    @Query("SELECT * FROM outbox WHERE account=:account AND deviceId=:device AND scope=:scope ORDER BY createdAt, requestId")
    suspend fun allOutbox(account: String, device: String, scope: String): List<OutboxRow>
    @Query("SELECT * FROM intents WHERE account=:account AND deviceId=:device AND scope=:scope AND clientVisitId=:clientVisitId")
    suspend fun visitIntents(account: String, device: String, scope: String, clientVisitId: String): List<IntentRow>
    @Query("SELECT * FROM intents WHERE account=:account AND deviceId=:device AND scope=:scope AND requestId=:requestId")
    suspend fun intentById(account: String, device: String, scope: String, requestId: String): IntentRow?
    @Query("SELECT * FROM acks WHERE account=:account AND deviceId=:device AND scope=:scope AND entityId=:entityId")
    suspend fun visitAcks(account: String, device: String, scope: String, entityId: String): List<AckRow>
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertSnapshot(row: SnapshotRow)
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertIntent(row: IntentRow)
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertOutbox(row: OutboxRow)
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertAck(row: AckRow)
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun putPartition(row: PartitionRow)
    @Query("SELECT COUNT(*) FROM outbox JOIN partitions ON outbox.account=partitions.account AND outbox.deviceId=partitions.deviceId AND outbox.scope=partitions.scope WHERE outbox.account=:account AND outbox.deviceId=:device AND partitions.held=1 AND outbox.state='pending'")
    suspend fun heldCount(account: String, device: String): Int
    @Query("SELECT * FROM partitions WHERE account=:account AND deviceId=:device AND scope=:scope")
    suspend fun partition(account: String, device: String, scope: String): PartitionRow?
    @Query("SELECT * FROM snapshots WHERE account=:account AND deviceId=:device AND scope=:scope AND generation=:generation AND kind=:kind AND (:day IS NULL OR serviceDate=:day) ORDER BY snapshotOrder, entityId")
    suspend fun snapshot(account: String, device: String, scope: String, generation: String,
        kind: String, day: String?): List<SnapshotRow>
    @Query("DELETE FROM snapshots WHERE account=:account AND deviceId=:device AND scope=:scope AND generation!=:generation")
    suspend fun discardOldSnapshots(account: String, device: String, scope: String, generation: String)
    @Query("SELECT * FROM intents WHERE account=:account AND deviceId=:device AND scope=:scope AND requestId=:requestId")
    suspend fun intent(account: String, device: String, scope: String, requestId: String): IntentRow?
    @Query("SELECT * FROM outbox WHERE account=:account AND deviceId=:device AND scope=:scope AND requestId=:requestId")
    suspend fun outbox(account: String, device: String, scope: String, requestId: String): OutboxRow?
    @Query("SELECT * FROM outbox WHERE account=:account AND deviceId=:device AND scope=:scope AND state IN ('pending','sending') ORDER BY createdAt, requestId")
    suspend fun pending(account: String, device: String, scope: String): List<OutboxRow>
    @Query("UPDATE outbox SET state='sending' WHERE account=:account AND deviceId=:device AND scope=:scope AND requestId=:requestId AND state='pending'")
    suspend fun markSending(account: String, device: String, scope: String, requestId: String): Int
    @Query("UPDATE outbox SET state='pending' WHERE account=:account AND deviceId=:device AND scope=:scope AND state='sending'")
    suspend fun resetSending(account: String, device: String, scope: String)
    @Query("SELECT * FROM outbox WHERE account=:account AND deviceId=:device AND state IN ('pending','sending','review') ORDER BY createdAt, requestId")
    suspend fun outstandingForDevice(account: String, device: String): List<OutboxRow>
    @Query("UPDATE outbox SET state='done' WHERE account=:account AND deviceId=:device AND scope=:scope AND requestId=:requestId AND state IN ('pending','sending') AND EXISTS (SELECT 1 FROM acks WHERE acks.account=outbox.account AND acks.deviceId=outbox.deviceId AND acks.scope=outbox.scope AND acks.requestId=outbox.requestId)")
    suspend fun markDone(account: String, device: String, scope: String, requestId: String): Int
    @Query("UPDATE outbox SET state='review', rejectionCode=:code WHERE account=:account AND deviceId=:device AND scope=:scope AND requestId=:requestId AND state IN ('pending','sending')")
    suspend fun reject(account: String, device: String, scope: String, requestId: String, code: String): Int
    @Query("UPDATE partitions SET held=1, cursor=NULL, syncHealth='held_for_review'")
    suspend fun holdAllPartitions()

    // QSR-010 sign-out/revocation purge: server-provided cache only. Intents, outbox, acks and
    // photo rows are the person's unsent or acknowledged evidence and stay (ADR-020).
    @Query("DELETE FROM snapshots WHERE (:account IS NULL OR (account=:account AND deviceId=:device AND scope=:scope))")
    suspend fun purgeSnapshots(account: String?, device: String?, scope: String?)
    @Query("DELETE FROM call_sheets WHERE (:account IS NULL OR (account=:account AND deviceId=:device AND scope=:scope))")
    suspend fun purgeCallSheets(account: String?, device: String?, scope: String?)
    @Query("DELETE FROM call_sheet_lines WHERE (:account IS NULL OR (account=:account AND deviceId=:device AND scope=:scope))")
    suspend fun purgeCallSheetLines(account: String?, device: String?, scope: String?)
    @Query("DELETE FROM catalog_products WHERE (:account IS NULL OR (account=:account AND deviceId=:device AND scope=:scope))")
    suspend fun purgeProducts(account: String?, device: String?, scope: String?)
    @Query("DELETE FROM inventory_availability WHERE (:account IS NULL OR (account=:account AND deviceId=:device AND scope=:scope))")
    suspend fun purgeAvailability(account: String?, device: String?, scope: String?)
    @Query("DELETE FROM deltas WHERE (:account IS NULL OR (account=:account AND deviceId=:device AND scope=:scope))")
    suspend fun purgeDeltas(account: String?, device: String?, scope: String?)
    @Query("UPDATE partitions SET held=1, cursor=NULL, syncHealth='held_for_review', activeGeneration=NULL, employeeJson=NULL, routeJson=NULL, leaseExpiresAt=NULL, cacheExpiresAt=NULL WHERE (:account IS NULL OR (account=:account AND deviceId=:device AND scope=:scope))")
    suspend fun purgePartitionMetadata(account: String?, device: String?, scope: String?)
    @Query("SELECT * FROM acks WHERE account=:account AND deviceId=:device AND scope=:scope AND requestId=:requestId")
    suspend fun ack(account: String, device: String, scope: String, requestId: String): AckRow?
}

@Database(entities = [SnapshotRow::class, PartitionRow::class, IntentRow::class, OutboxRow::class, AckRow::class, DeltaRow::class, CallSheetRow::class, CallSheetLineRow::class, EvidencePhotoRow::class, OrderDraftRow::class, CatalogProductRow::class, InventoryAvailabilityRow::class],
    version = 8, exportSchema = true)
abstract class StoreDatabase : RoomDatabase() {
    abstract fun rows(): StoreDao
}
