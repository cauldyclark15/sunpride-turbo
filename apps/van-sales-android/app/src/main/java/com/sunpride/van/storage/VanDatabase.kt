package com.sunpride.van.storage

import androidx.room.*
import kotlinx.coroutines.flow.Flow

/** Full issuer|subject and registered device; never a UI-selected salesperson. */
data class StoreScope(val fullAuthSubject: String, val deviceId: String) {
    init { require(fullAuthSubject.isNotBlank() && deviceId.isNotBlank()) }
}

@Entity(tableName = "trip", primaryKeys = ["fullAuthSubject", "deviceId", "tripId"])
data class TripRow(val fullAuthSubject: String, val deviceId: String, val tripId: String, val tripNumber: String, val status: String, val serviceDate: String, val json: String, val loadId: String?, val loadStatus: String?)

@Entity(tableName = "load_line", primaryKeys = ["fullAuthSubject", "deviceId", "loadId", "lineNumber"])
data class LoadLineRow(val fullAuthSubject: String, val deviceId: String, val loadId: String, val lineNumber: Int, val productId: String, val expectedBase: Long, val actualBase: Long?, val json: String)

@Entity(tableName = "product", primaryKeys = ["fullAuthSubject", "deviceId", "productId"])
data class ProductRow(val fullAuthSubject: String, val deviceId: String, val productId: String, val code: String, val name: String, val uomCode: String, val quantityScale: Long, val barcodesJson: String, val json: String)

@Entity(tableName = "customer", primaryKeys = ["fullAuthSubject", "deviceId", "outletId"])
data class CustomerRow(val fullAuthSubject: String, val deviceId: String, val outletId: String, val code: String, val name: String, val address: String?, val sequence: Int?, val source: String, val reason: String? = null, val localOnly: Boolean = false,
    /** VAN-012 office credit terms (v2); null = no credit for this customer. */
    val creditTermsDays: Int? = null, val creditAvailableMinor: Long? = null)

@Entity(tableName = "truck_stock_baseline", primaryKeys = ["fullAuthSubject", "deviceId", "tripId", "productId", "stockStatus"])
data class BaselineRow(val fullAuthSubject: String, val deviceId: String, val tripId: String, val productId: String, val stockStatus: String, val quantityBase: Long, val baselineServerTime: Long)

@Entity(tableName = "stock_movement", primaryKeys = ["fullAuthSubject", "deviceId", "movementId"])
data class MovementRow(val fullAuthSubject: String, val deviceId: String, val movementId: String, val tripId: String, val productId: String, val type: String, val stockStatus: String, val quantityBase: Long, val reason: String?, val clientRequestId: String, val createdAt: Long)

@Entity(tableName = "movement_settlement", primaryKeys = ["fullAuthSubject", "deviceId", "movementId"])
data class SettlementRow(val fullAuthSubject: String, val deviceId: String, val movementId: String, val baselineServerTime: Long)

@Entity(tableName = "outbox", primaryKeys = ["fullAuthSubject", "deviceId", "clientRequestId"], indices = [Index(value = ["fullAuthSubject", "deviceId", "createdAt"])])
data class OutboxRow(val fullAuthSubject: String, val deviceId: String, val clientRequestId: String, val tripId: String, val kind: String, val operationJson: String, val createdAt: Long, val metadataJson: String? = null, val status: String = "pending", val rejectionCode: String? = null)

@Entity(tableName = "ack", primaryKeys = ["fullAuthSubject", "deviceId", "clientRequestId"])
data class AckRow(val fullAuthSubject: String, val deviceId: String, val clientRequestId: String, val entityId: String, val movementId: String?, val serverTime: Long)

@Entity(tableName = "sync_meta", primaryKeys = ["fullAuthSubject", "deviceId"])
data class SyncMetaRow(val fullAuthSubject: String, val deviceId: String, val lastBootstrapTime: Long? = null, val lastSyncTime: Long? = null, val health: String = "never_synced", val serviceDate: String? = null, val policyJson: String? = null, val held: Boolean = false, val sellerJson: String? = null)

@Entity(tableName = "sequence_counter", primaryKeys = ["fullAuthSubject", "deviceId", "tripId"])
data class SequenceCounterRow(val fullAuthSubject: String, val deviceId: String, val tripId: String, val lastSequence: Long)

@Entity(tableName = "transaction_id", primaryKeys = ["fullAuthSubject", "deviceId", "idempotencyKey"], indices = [Index(value = ["fullAuthSubject", "deviceId", "receiptNumber"], unique = true)])
data class TransactionIdRow(val fullAuthSubject: String, val deviceId: String, val idempotencyKey: String, val tripId: String, val receiptNumber: String, val sequence: Long)

@Entity(tableName = "sale", primaryKeys = ["fullAuthSubject", "deviceId", "saleId"])
data class SaleRow(val fullAuthSubject: String, val deviceId: String, val saleId: String, val tripId: String, val receiptNumber: String, val idempotencyKey: String, val customerId: String, val status: String, val totalMinor: Long? = null, val createdAt: Long,
    /** VAN-012 (v2): payment state, separate from [status] (the sale's posting state). Null on v1 rows = paid in cash. */
    val paymentStatus: String? = null)

/** VAN-021: append-only cancellation evidence; one void per scoped sale. */
@Entity(tableName = "sale_void", primaryKeys = ["fullAuthSubject", "deviceId", "voidId"],
    indices = [Index(value = ["fullAuthSubject", "deviceId", "saleId"], unique = true)])
data class SaleVoidRow(val fullAuthSubject: String, val deviceId: String, val voidId: String, val saleId: String,
    val tripId: String, val idempotencyKey: String, val reasonCode: String, val note: String?,
    val approvalMethod: String, val approvalCode: String?, val createdAt: Long)

/**
 * VAN-022: the trip's end-of-trip cash count, append-only and one per scoped trip. The full capture (denomination
 * counts, other payments, approval) is also frozen in its parked `cash.reconcile` operation bytes.
 */
@Entity(tableName = "cash_reconciliation", primaryKeys = ["fullAuthSubject", "deviceId", "reconciliationId"],
    indices = [Index(value = ["fullAuthSubject", "deviceId", "tripId"], unique = true)])
data class CashReconciliationRow(val fullAuthSubject: String, val deviceId: String, val reconciliationId: String, val tripId: String,
    val idempotencyKey: String, val currency: String, val expectedMinor: Long, val declaredMinor: Long, val varianceMinor: Long,
    val countsJson: String, val reasonCode: String?, val note: String?, val approvalMethod: String, val approvalCode: String?,
    val cashSaleCount: Int, val createdAt: Long)

@Entity(tableName = "sale_line", primaryKeys = ["fullAuthSubject", "deviceId", "saleId", "lineNumber"])
data class SaleLineRow(val fullAuthSubject: String, val deviceId: String, val saleId: String, val lineNumber: Int, val productId: String, val quantityBase: Long, val unitPriceMinor: Long? = null, val totalMinor: Long? = null)

@Entity(tableName = "payment", primaryKeys = ["fullAuthSubject", "deviceId", "paymentId"])
data class PaymentRow(val fullAuthSubject: String, val deviceId: String, val paymentId: String, val saleId: String, val method: String = "cash", val amountMinor: Long? = null, val createdAt: Long,
    /** VAN-012 (v2): normalized reference (check/e-wallet/bank), payment state, cash handed over and credit due date. */
    val reference: String? = null, val status: String? = null, val tenderedMinor: Long? = null, val dueDate: String? = null)

@Entity(tableName = "customer_return", primaryKeys = ["fullAuthSubject", "deviceId", "returnId"])
data class CustomerReturnRow(val fullAuthSubject: String, val deviceId: String, val returnId: String, val tripId: String, val receiptNumber: String, val idempotencyKey: String, val customerId: String, val status: String, val createdAt: Long)

@Entity(tableName = "return_line", primaryKeys = ["fullAuthSubject", "deviceId", "returnId", "lineNumber"])
data class ReturnLineRow(val fullAuthSubject: String, val deviceId: String, val returnId: String, val lineNumber: Int, val productId: String, val stockStatus: String, val quantityBase: Long, val reason: String)

@Entity(tableName = "reconciliation", primaryKeys = ["fullAuthSubject", "deviceId", "reconciliationId"])
data class ReconciliationRow(val fullAuthSubject: String, val deviceId: String, val reconciliationId: String, val tripId: String, val countLinesJson: String, val declaredCashMinor: Long?, val status: String, val createdAt: Long)

@Entity(tableName = "price_list_line", primaryKeys = ["fullAuthSubject", "deviceId", "priceListId", "productId"])
data class PriceListLineRow(val fullAuthSubject: String, val deviceId: String, val priceListId: String, val productId: String, val uomCode: String, val unitPriceMinor: Long, val currency: String, val effectiveFrom: Long, val effectiveTo: Long?)

@Dao
interface VanDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertTrip(row: TripRow)
    @Query("SELECT * FROM trip WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun tripRows(subject: String, device: String): List<TripRow>
    @Query("SELECT * FROM trip WHERE fullAuthSubject=:subject AND deviceId=:device") fun observeTrip(subject: String, device: String): Flow<List<TripRow>>
    @Query("DELETE FROM trip WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun clearTrip(subject: String, device: String)
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertLoadLine(row: LoadLineRow)
    @Query("SELECT * FROM load_line WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun loadlineRows(subject: String, device: String): List<LoadLineRow>
    @Query("SELECT * FROM load_line WHERE fullAuthSubject=:subject AND deviceId=:device") fun observeLoadLine(subject: String, device: String): Flow<List<LoadLineRow>>
    @Query("DELETE FROM load_line WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun clearLoadLine(subject: String, device: String)
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertProduct(row: ProductRow)
    @Query("SELECT * FROM product WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun productRows(subject: String, device: String): List<ProductRow>
    @Query("SELECT * FROM product WHERE fullAuthSubject=:subject AND deviceId=:device") fun observeProduct(subject: String, device: String): Flow<List<ProductRow>>
    @Query("DELETE FROM product WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun clearProduct(subject: String, device: String)
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertCustomer(row: CustomerRow)
    @Query("SELECT * FROM customer WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun customerRows(subject: String, device: String): List<CustomerRow>
    @Query("SELECT * FROM customer WHERE fullAuthSubject=:subject AND deviceId=:device") fun observeCustomer(subject: String, device: String): Flow<List<CustomerRow>>
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertBaseline(row: BaselineRow)
    @Query("SELECT * FROM truck_stock_baseline WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun truckstockbaselineRows(subject: String, device: String): List<BaselineRow>
    @Query("SELECT * FROM truck_stock_baseline WHERE fullAuthSubject=:subject AND deviceId=:device") fun observeBaseline(subject: String, device: String): Flow<List<BaselineRow>>
    @Query("DELETE FROM truck_stock_baseline WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun clearBaseline(subject: String, device: String)
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertMovement(row: MovementRow)
    @Query("SELECT * FROM stock_movement WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun stockmovementRows(subject: String, device: String): List<MovementRow>
    @Query("SELECT * FROM stock_movement WHERE fullAuthSubject=:subject AND deviceId=:device") fun observeMovement(subject: String, device: String): Flow<List<MovementRow>>
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertSettlement(row: SettlementRow)
    @Query("SELECT * FROM movement_settlement WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun movementsettlementRows(subject: String, device: String): List<SettlementRow>
    @Query("SELECT * FROM movement_settlement WHERE fullAuthSubject=:subject AND deviceId=:device") fun observeSettlement(subject: String, device: String): Flow<List<SettlementRow>>
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertOutbox(row: OutboxRow)
    @Query("SELECT * FROM outbox WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun outboxRows(subject: String, device: String): List<OutboxRow>
    @Query("SELECT * FROM outbox WHERE fullAuthSubject=:subject AND deviceId=:device") fun observeOutbox(subject: String, device: String): Flow<List<OutboxRow>>
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertAck(row: AckRow)
    @Query("SELECT * FROM ack WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun ackRows(subject: String, device: String): List<AckRow>
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertSyncMeta(row: SyncMetaRow)
    @Query("SELECT * FROM sync_meta WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun syncmetaRows(subject: String, device: String): List<SyncMetaRow>
    @Query("SELECT * FROM sync_meta WHERE fullAuthSubject=:subject AND deviceId=:device") fun observeSyncMeta(subject: String, device: String): Flow<List<SyncMetaRow>>
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertSequenceCounter(row: SequenceCounterRow)
    @Query("SELECT * FROM sequence_counter WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun sequencecounterRows(subject: String, device: String): List<SequenceCounterRow>
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertTransactionId(row: TransactionIdRow)
    @Query("SELECT * FROM transaction_id WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun transactionidRows(subject: String, device: String): List<TransactionIdRow>
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertSale(row: SaleRow)
    @Query("SELECT * FROM sale WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun saleRows(subject: String, device: String): List<SaleRow>
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertSaleVoid(row: SaleVoidRow)
    @Query("SELECT * FROM sale_void WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun salevoidRows(subject: String, device: String): List<SaleVoidRow>
    @Query("SELECT * FROM sale_void WHERE fullAuthSubject=:subject AND deviceId=:device AND saleId=:saleId") suspend fun saleVoid(subject: String, device: String, saleId: String): SaleVoidRow?
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertCashReconciliation(row: CashReconciliationRow)
    @Query("SELECT * FROM cash_reconciliation WHERE fullAuthSubject=:subject AND deviceId=:device AND tripId=:tripId") suspend fun cashReconciliation(subject: String, device: String, tripId: String): CashReconciliationRow?
    @Query("SELECT * FROM cash_reconciliation WHERE fullAuthSubject=:subject AND deviceId=:device") fun observeCashReconciliation(subject: String, device: String): Flow<List<CashReconciliationRow>>
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertSaleLine(row: SaleLineRow)
    @Query("SELECT * FROM sale_line WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun salelineRows(subject: String, device: String): List<SaleLineRow>
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertPayment(row: PaymentRow)
    @Query("SELECT * FROM payment WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun paymentRows(subject: String, device: String): List<PaymentRow>
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertCustomerReturn(row: CustomerReturnRow)
    @Query("SELECT * FROM customer_return WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun customerreturnRows(subject: String, device: String): List<CustomerReturnRow>
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertReturnLine(row: ReturnLineRow)
    @Query("SELECT * FROM return_line WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun returnlineRows(subject: String, device: String): List<ReturnLineRow>
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertReconciliation(row: ReconciliationRow)
    @Query("SELECT * FROM reconciliation WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun reconciliationRows(subject: String, device: String): List<ReconciliationRow>
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertPriceListLine(row: PriceListLineRow)
    @Query("SELECT * FROM price_list_line WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun pricelistlineRows(subject: String, device: String): List<PriceListLineRow>
    @Query("SELECT * FROM price_list_line WHERE fullAuthSubject=:subject AND deviceId=:device") fun observePriceListLine(subject: String, device: String): Flow<List<PriceListLineRow>>
    @Query("DELETE FROM price_list_line WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun clearPriceListLine(subject: String, device: String)

    @Query("DELETE FROM customer WHERE fullAuthSubject=:subject AND deviceId=:device AND localOnly=0") suspend fun clearServerCustomers(subject: String, device: String)
    @Query("SELECT * FROM sync_meta WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun meta(subject: String, device: String): SyncMetaRow?
    @Query("SELECT * FROM trip WHERE fullAuthSubject=:subject AND deviceId=:device LIMIT 1") suspend fun trip(subject: String, device: String): TripRow?
    @Query("SELECT MAX(createdAt) FROM outbox WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun latestCreatedAt(subject: String, device: String): Long?
    @Query("SELECT * FROM outbox WHERE fullAuthSubject=:subject AND deviceId=:device AND status='pending' ORDER BY createdAt,clientRequestId LIMIT 20") suspend fun pending(subject: String, device: String): List<OutboxRow>
    @Query("SELECT * FROM outbox WHERE fullAuthSubject=:subject AND deviceId=:device AND clientRequestId=:id") suspend fun outbox(subject: String, device: String, id: String): OutboxRow?
    @Query("SELECT * FROM ack WHERE fullAuthSubject=:subject AND deviceId=:device AND clientRequestId=:id") suspend fun ack(subject: String, device: String, id: String): AckRow?
    @Query("UPDATE outbox SET status='sending' WHERE fullAuthSubject=:subject AND deviceId=:device AND clientRequestId IN (:ids) AND status='pending'") suspend fun markSending(subject: String, device: String, ids: List<String>)
    @Query("UPDATE outbox SET status='pending' WHERE fullAuthSubject=:subject AND deviceId=:device AND status='sending'") suspend fun resetSending(subject: String, device: String)
    @Query("UPDATE outbox SET status='done' WHERE fullAuthSubject=:subject AND deviceId=:device AND clientRequestId=:id AND status IN ('pending','sending') AND EXISTS (SELECT 1 FROM ack WHERE ack.fullAuthSubject=outbox.fullAuthSubject AND ack.deviceId=outbox.deviceId AND ack.clientRequestId=outbox.clientRequestId)") suspend fun markDone(subject: String, device: String, id: String)
    @Query("UPDATE outbox SET status=:status,rejectionCode=:code WHERE fullAuthSubject=:subject AND deviceId=:device AND clientRequestId=:id AND status IN ('pending','sending')") suspend fun reject(subject: String, device: String, id: String, status: String, code: String)
    @Query("SELECT * FROM sequence_counter WHERE fullAuthSubject=:subject AND deviceId=:device AND tripId=:tripId") suspend fun counter(subject: String, device: String, tripId: String): SequenceCounterRow?
}

@Database(entities = [TripRow::class,LoadLineRow::class,ProductRow::class,CustomerRow::class,BaselineRow::class,MovementRow::class,SettlementRow::class,OutboxRow::class,AckRow::class,SyncMetaRow::class,SequenceCounterRow::class,TransactionIdRow::class,SaleRow::class,SaleLineRow::class,PaymentRow::class,CustomerReturnRow::class,ReturnLineRow::class,ReconciliationRow::class,PriceListLineRow::class,
    ReceiptPrintRow::class,SaleReceiptRow::class,SaleVoidRow::class,CashReconciliationRow::class], version = 6, exportSchema = true)
abstract class VanDatabase : RoomDatabase() {
    abstract fun rows(): VanDao
    /** VAN-017 receipt print history (v3). */
    abstract fun receiptPrints(): ReceiptPrintDao
    companion object {
        /** VAN-022: one new append-only table for the end-of-trip cash count; no existing row changes. */
        val MIGRATION_5_6 = object : androidx.room.migration.Migration(5,6) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL("CREATE TABLE IF NOT EXISTS `cash_reconciliation` (`fullAuthSubject` TEXT NOT NULL, `deviceId` TEXT NOT NULL, `reconciliationId` TEXT NOT NULL, `tripId` TEXT NOT NULL, `idempotencyKey` TEXT NOT NULL, `currency` TEXT NOT NULL, `expectedMinor` INTEGER NOT NULL, `declaredMinor` INTEGER NOT NULL, `varianceMinor` INTEGER NOT NULL, `countsJson` TEXT NOT NULL, `reasonCode` TEXT, `note` TEXT, `approvalMethod` TEXT NOT NULL, `approvalCode` TEXT, `cashSaleCount` INTEGER NOT NULL, `createdAt` INTEGER NOT NULL, PRIMARY KEY(`fullAuthSubject`, `deviceId`, `reconciliationId`))")
                db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_cash_reconciliation_fullAuthSubject_deviceId_tripId` ON `cash_reconciliation` (`fullAuthSubject`, `deviceId`, `tripId`)")
            }
        }
        /** VAN-021: additive cancellation evidence only, never edit or delete a sale. */
        val MIGRATION_4_5 = object : androidx.room.migration.Migration(4,5) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL("CREATE TABLE IF NOT EXISTS `sale_void` (`fullAuthSubject` TEXT NOT NULL, `deviceId` TEXT NOT NULL, `voidId` TEXT NOT NULL, `saleId` TEXT NOT NULL, `tripId` TEXT NOT NULL, `idempotencyKey` TEXT NOT NULL, `reasonCode` TEXT NOT NULL, `note` TEXT, `approvalMethod` TEXT NOT NULL, `approvalCode` TEXT, `createdAt` INTEGER NOT NULL, PRIMARY KEY(`fullAuthSubject`, `deviceId`, `voidId`))")
                db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_sale_void_fullAuthSubject_deviceId_saleId` ON `sale_void` (`fullAuthSubject`, `deviceId`, `saleId`)")
            }
        }
        /** VAN-017: one new append-only table of receipts frozen at checkout; sales saved before it have none. */
        val MIGRATION_3_4 = object : androidx.room.migration.Migration(3,4) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL("CREATE TABLE IF NOT EXISTS `sale_receipt` (`fullAuthSubject` TEXT NOT NULL, `deviceId` TEXT NOT NULL, `saleId` TEXT NOT NULL, `documentJson` TEXT NOT NULL, PRIMARY KEY(`fullAuthSubject`, `deviceId`, `saleId`))")
            }
        }
        /** VAN-017: one new append-only table; no existing row, operation byte or movement changes. */
        val MIGRATION_2_3 = object : androidx.room.migration.Migration(2,3) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL("CREATE TABLE IF NOT EXISTS `receipt_print` (`fullAuthSubject` TEXT NOT NULL, `deviceId` TEXT NOT NULL, `printId` TEXT NOT NULL, `saleId` TEXT NOT NULL, `kind` TEXT NOT NULL, `copyNumber` INTEGER NOT NULL, `reason` TEXT, `outcome` TEXT NOT NULL, `startedAt` INTEGER NOT NULL, `finishedAt` INTEGER, PRIMARY KEY(`fullAuthSubject`, `deviceId`, `printId`))")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_receipt_print_fullAuthSubject_deviceId_saleId` ON `receipt_print` (`fullAuthSubject`, `deviceId`, `saleId`)")
            }
        }
        /** VAN-012: additive nullable columns only; no saved row, operation byte or movement changes. */
        val MIGRATION_1_2 = object : androidx.room.migration.Migration(1,2) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE customer ADD COLUMN creditTermsDays INTEGER")
                db.execSQL("ALTER TABLE customer ADD COLUMN creditAvailableMinor INTEGER")
                db.execSQL("ALTER TABLE sale ADD COLUMN paymentStatus TEXT")
                db.execSQL("ALTER TABLE payment ADD COLUMN reference TEXT")
                db.execSQL("ALTER TABLE payment ADD COLUMN status TEXT")
                db.execSQL("ALTER TABLE payment ADD COLUMN tenderedMinor INTEGER")
                db.execSQL("ALTER TABLE payment ADD COLUMN dueDate TEXT")
            }
        }
    }
}
