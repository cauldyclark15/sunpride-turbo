package com.sunpride.field.storage

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
    val serviceDate: String? = null)

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

@Dao
interface StoreDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun putDelta(row: DeltaRow)
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
    @Query("SELECT * FROM snapshots WHERE account=:account AND deviceId=:device AND scope=:scope AND generation=:generation AND kind=:kind AND (:day IS NULL OR serviceDate=:day) ORDER BY entityId")
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
    @Query("SELECT * FROM acks WHERE account=:account AND deviceId=:device AND scope=:scope AND requestId=:requestId")
    suspend fun ack(account: String, device: String, scope: String, requestId: String): AckRow?
}

@Database(entities = [SnapshotRow::class, PartitionRow::class, IntentRow::class, OutboxRow::class, AckRow::class, DeltaRow::class],
    version = 3, exportSchema = true)
abstract class StoreDatabase : RoomDatabase() {
    abstract fun rows(): StoreDao
}
