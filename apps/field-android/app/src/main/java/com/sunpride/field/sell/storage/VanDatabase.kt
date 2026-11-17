package com.sunpride.field.sell.storage

import androidx.room.*
import kotlinx.coroutines.flow.Flow

/** Full issuer|subject and registered device; never a UI-selected salesperson. */
data class StoreScope(val fullAuthSubject: String, val deviceId: String) {
    init { require(fullAuthSubject.isNotBlank() && deviceId.isNotBlank()) }
}

@Entity(tableName = "sell_trip", primaryKeys = ["fullAuthSubject", "deviceId", "tripId"])
data class TripRow(val fullAuthSubject: String, val deviceId: String, val tripId: String, val tripNumber: String, val status: String, val serviceDate: String, val json: String, val loadId: String?, val loadStatus: String?)

@Entity(tableName = "sell_load_line", primaryKeys = ["fullAuthSubject", "deviceId", "loadId", "lineNumber"])
data class LoadLineRow(val fullAuthSubject: String, val deviceId: String, val loadId: String, val lineNumber: Int, val productId: String, val expectedBase: Long, val actualBase: Long?, val json: String)

@Entity(tableName = "sell_product", primaryKeys = ["fullAuthSubject", "deviceId", "productId"])
data class ProductRow(val fullAuthSubject: String, val deviceId: String, val productId: String, val code: String, val name: String, val uomCode: String, val quantityScale: Long, val barcodesJson: String, val json: String)

@Entity(tableName = "sell_customer", primaryKeys = ["fullAuthSubject", "deviceId", "outletId"])
data class CustomerRow(val fullAuthSubject: String, val deviceId: String, val outletId: String, val code: String, val name: String, val address: String?, val sequence: Int?, val source: String, val reason: String? = null, val localOnly: Boolean = false,
    /** VAN-012 office credit terms (v2); null = no credit for this customer. */
    val creditTermsDays: Int? = null, val creditAvailableMinor: Long? = null,
    /** SP-0105: null plus [priceListMode] = none; legacy snapshots retain the old any-list behaviour. */
    val priceListId: String? = null, val priceListMode: String = "legacy")

@Entity(tableName = "sell_truck_stock_baseline", primaryKeys = ["fullAuthSubject", "deviceId", "tripId", "productId", "stockStatus"])
data class BaselineRow(val fullAuthSubject: String, val deviceId: String, val tripId: String, val productId: String, val stockStatus: String, val quantityBase: Long, val baselineServerTime: Long)

@Entity(tableName = "sell_stock_movement", primaryKeys = ["fullAuthSubject", "deviceId", "movementId"])
data class MovementRow(val fullAuthSubject: String, val deviceId: String, val movementId: String, val tripId: String, val productId: String, val type: String, val stockStatus: String, val quantityBase: Long, val reason: String?, val clientRequestId: String, val createdAt: Long)

@Entity(tableName = "sell_movement_settlement", primaryKeys = ["fullAuthSubject", "deviceId", "movementId"])
data class SettlementRow(val fullAuthSubject: String, val deviceId: String, val movementId: String, val baselineServerTime: Long)

@Entity(tableName = "sell_outbox", primaryKeys = ["fullAuthSubject", "deviceId", "clientRequestId"], indices = [Index(value = ["fullAuthSubject", "deviceId", "createdAt"])])
data class OutboxRow(val fullAuthSubject: String, val deviceId: String, val clientRequestId: String, val tripId: String, val kind: String, val operationJson: String, val createdAt: Long, val metadataJson: String? = null, val status: String = "pending", val rejectionCode: String? = null)

/**
 * SP-0137: one buffered live-location ping of the truck, frozen at capture ([pingJson] is sent byte-identical on
 * every retry). Kept apart from the operation outbox (its own endpoint, never blocks or reorders sales).
 * Acknowledged rows are deleted at once; nothing here outlives 7 days on the phone.
 */
@Entity(tableName = "sell_location_ping", primaryKeys = ["fullAuthSubject", "deviceId", "clientPingId"],
    indices = [Index(value = ["fullAuthSubject", "deviceId", "tripId", "recordedAt"])])
data class LocationPingRow(val fullAuthSubject: String, val deviceId: String, val clientPingId: String, val tripId: String,
    val recordedAt: Long, val latitude: Double, val longitude: Double, val pingTrigger: String, val pingJson: String,
    val status: String = "pending", val rejectionCode: String? = null)

@Entity(tableName = "sell_ack", primaryKeys = ["fullAuthSubject", "deviceId", "clientRequestId"])
data class AckRow(val fullAuthSubject: String, val deviceId: String, val clientRequestId: String, val entityId: String, val movementId: String?, val serverTime: Long)

@Entity(tableName = "sell_sync_meta", primaryKeys = ["fullAuthSubject", "deviceId"])
data class SyncMetaRow(val fullAuthSubject: String, val deviceId: String, val lastBootstrapTime: Long? = null, val lastSyncTime: Long? = null, val health: String = "never_synced", val serviceDate: String? = null, val policyJson: String? = null, val held: Boolean = false, val sellerJson: String? = null, val cursor: String? = null, val scopeFingerprint: String? = null, val authorizationEpoch: String? = null, val leaseExpiresAt: Long? = null, val cacheExpiresAt: Long? = null)

@Entity(tableName = "sell_sequence_counter", primaryKeys = ["fullAuthSubject", "deviceId", "tripId"])
data class SequenceCounterRow(val fullAuthSubject: String, val deviceId: String, val tripId: String, val lastSequence: Long)

@Entity(tableName = "sell_transaction_id", primaryKeys = ["fullAuthSubject", "deviceId", "idempotencyKey"], indices = [Index(value = ["fullAuthSubject", "deviceId", "receiptNumber"], unique = true)])
data class TransactionIdRow(val fullAuthSubject: String, val deviceId: String, val idempotencyKey: String, val tripId: String, val receiptNumber: String, val sequence: Long)

@Entity(tableName = "sell_sale", primaryKeys = ["fullAuthSubject", "deviceId", "saleId"])
data class SaleRow(val fullAuthSubject: String, val deviceId: String, val saleId: String, val tripId: String, val receiptNumber: String, val idempotencyKey: String, val customerId: String, val status: String, val totalMinor: Long? = null, val createdAt: Long,
    /** VAN-012 (v2): payment state, separate from [status] (the sale's posting state). Null on v1 rows = paid in cash. */
    val paymentStatus: String? = null)

/**
 * IP-HOLD: a cart parked on THIS phone ("Hold"). Local only: never uploaded, never part of a sale or the fiscal record, no stock is
 * reserved. [linesJson] is the cart as it stood (product, base quantity, price seen); prices and stock are checked again on recall.
 */
@Entity(tableName = "sell_held_cart", primaryKeys = ["fullAuthSubject", "deviceId", "holdId"])
data class HeldCartRow(val fullAuthSubject: String, val deviceId: String, val holdId: String, val surface: String, val name: String, val note: String?,
    val customerId: String?, val customerName: String?, val linesJson: String, val totalLabel: String, val createdAt: Long)

/** VAN-021: append-only cancellation evidence; one void per scoped sale. */
@Entity(tableName = "sell_sale_void", primaryKeys = ["fullAuthSubject", "deviceId", "voidId"],
    indices = [Index(value = ["fullAuthSubject", "deviceId", "saleId"], unique = true)])
data class SaleVoidRow(val fullAuthSubject: String, val deviceId: String, val voidId: String, val saleId: String,
    val tripId: String, val idempotencyKey: String, val reasonCode: String, val note: String?,
    val approvalMethod: String, val approvalCode: String?, val createdAt: Long)

/**
 * VAN-022: the trip's end-of-trip cash count, append-only and one per scoped trip. The full capture (denomination
 * counts, other payments, approval) is also frozen in its parked `cash.reconcile` operation bytes.
 */
@Entity(tableName = "sell_cash_reconciliation", primaryKeys = ["fullAuthSubject", "deviceId", "reconciliationId"],
    indices = [Index(value = ["fullAuthSubject", "deviceId", "tripId"], unique = true)])
data class CashReconciliationRow(val fullAuthSubject: String, val deviceId: String, val reconciliationId: String, val tripId: String,
    val idempotencyKey: String, val currency: String, val expectedMinor: Long, val declaredMinor: Long, val varianceMinor: Long,
    val countsJson: String, val reasonCode: String?, val note: String?, val approvalMethod: String, val approvalCode: String?,
    val cashSaleCount: Int, val createdAt: Long)

/** VAN-023: append-only physical stock count, one per scoped trip. Lines and approval facts are frozen in the row and op. */
@Entity(tableName = "sell_stock_reconciliation", primaryKeys = ["fullAuthSubject", "deviceId", "reconciliationId"],
    indices = [Index(value = ["fullAuthSubject", "deviceId", "tripId"], unique = true)])
data class StockReconciliationRow(val fullAuthSubject: String, val deviceId: String, val reconciliationId: String, val tripId: String,
    val idempotencyKey: String, val linesJson: String, val countCode: String, val varianceLines: Int, val shortBase: Long,
    val overBase: Long, val note: String?, val approvalMethod: String, val approvalCode: String?, val createdAt: Long)

/**
 * VAN-024: the trip closed on this phone, append-only and one per scoped trip. The exceptions the seller confirmed and
 * the list of this trip's operations are also frozen in its parked `trip.close` operation bytes.
 */
@Entity(tableName = "sell_trip_close", primaryKeys = ["fullAuthSubject", "deviceId", "closeId"],
    indices = [Index(value = ["fullAuthSubject", "deviceId", "tripId"], unique = true)])
data class TripCloseRow(val fullAuthSubject: String, val deviceId: String, val closeId: String, val tripId: String,
    val idempotencyKey: String, val exceptionsJson: String, val reviewed: Boolean, val endOdometerKm: Double?, val note: String?,
    val operationCount: Int, val createdAt: Long)

@Entity(tableName = "sell_sale_line", primaryKeys = ["fullAuthSubject", "deviceId", "saleId", "lineNumber"])
data class SaleLineRow(val fullAuthSubject: String, val deviceId: String, val saleId: String, val lineNumber: Int, val productId: String, val quantityBase: Long, val unitPriceMinor: Long? = null, val totalMinor: Long? = null,
    /** SP-0105: null on pre-v7 rows; quantityBase remains the total stock deduction. */
    val freeBase: Long? = null, val discountMinor: Long? = null)

@Entity(tableName = "sell_payment", primaryKeys = ["fullAuthSubject", "deviceId", "paymentId"])
data class PaymentRow(val fullAuthSubject: String, val deviceId: String, val paymentId: String, val saleId: String, val method: String = "cash", val amountMinor: Long? = null, val createdAt: Long,
    /** VAN-012 (v2): normalized reference (check/e-wallet/bank), payment state, cash handed over and credit due date. */
    val reference: String? = null, val status: String? = null, val tenderedMinor: Long? = null, val dueDate: String? = null)

@Entity(tableName = "sell_customer_return", primaryKeys = ["fullAuthSubject", "deviceId", "returnId"])
data class CustomerReturnRow(val fullAuthSubject: String, val deviceId: String, val returnId: String, val tripId: String, val receiptNumber: String, val idempotencyKey: String, val customerId: String, val status: String, val createdAt: Long)

@Entity(tableName = "sell_return_line", primaryKeys = ["fullAuthSubject", "deviceId", "returnId", "lineNumber"])
data class ReturnLineRow(val fullAuthSubject: String, val deviceId: String, val returnId: String, val lineNumber: Int, val productId: String, val stockStatus: String, val quantityBase: Long, val reason: String)

@Entity(tableName = "sell_reconciliation", primaryKeys = ["fullAuthSubject", "deviceId", "reconciliationId"])
data class ReconciliationRow(val fullAuthSubject: String, val deviceId: String, val reconciliationId: String, val tripId: String, val countLinesJson: String, val declaredCashMinor: Long?, val status: String, val createdAt: Long)

@Entity(tableName = "sell_price_list_line", primaryKeys = ["fullAuthSubject", "deviceId", "priceListId", "productId"])
data class PriceListLineRow(val fullAuthSubject: String, val deviceId: String, val priceListId: String, val productId: String, val uomCode: String, val unitPriceMinor: Long, val currency: String, val effectiveFrom: Long, val effectiveTo: Long?, val priceListCode: String? = null)

/** SP-0105: the exact promotion JSON is frozen per bootstrap generation in the scoped encrypted store. */
@Entity(tableName = "sell_promotion", primaryKeys = ["fullAuthSubject", "deviceId", "promotionId"])
data class PromotionRow(val fullAuthSubject: String, val deviceId: String, val promotionId: String, val json: String)

@Dao
interface VanDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertTrip(row: TripRow)
    @Query("SELECT * FROM sell_trip WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun tripRows(subject: String, device: String): List<TripRow>
    @Query("SELECT * FROM sell_trip WHERE fullAuthSubject=:subject AND deviceId=:device") fun observeTrip(subject: String, device: String): Flow<List<TripRow>>
    @Query("DELETE FROM sell_trip WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun clearTrip(subject: String, device: String)
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertLoadLine(row: LoadLineRow)
    @Query("SELECT * FROM sell_load_line WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun loadlineRows(subject: String, device: String): List<LoadLineRow>
    @Query("SELECT * FROM sell_load_line WHERE fullAuthSubject=:subject AND deviceId=:device") fun observeLoadLine(subject: String, device: String): Flow<List<LoadLineRow>>
    @Query("DELETE FROM sell_load_line WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun clearLoadLine(subject: String, device: String)
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertProduct(row: ProductRow)
    @Query("SELECT * FROM sell_product WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun productRows(subject: String, device: String): List<ProductRow>
    @Query("SELECT * FROM sell_product WHERE fullAuthSubject=:subject AND deviceId=:device") fun observeProduct(subject: String, device: String): Flow<List<ProductRow>>
    @Query("DELETE FROM sell_product WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun clearProduct(subject: String, device: String)
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertCustomer(row: CustomerRow)
    @Query("SELECT * FROM sell_customer WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun customerRows(subject: String, device: String): List<CustomerRow>
    @Query("SELECT * FROM sell_customer WHERE fullAuthSubject=:subject AND deviceId=:device") fun observeCustomer(subject: String, device: String): Flow<List<CustomerRow>>
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertBaseline(row: BaselineRow)
    @Query("SELECT * FROM sell_truck_stock_baseline WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun truckstockbaselineRows(subject: String, device: String): List<BaselineRow>
    @Query("SELECT * FROM sell_truck_stock_baseline WHERE fullAuthSubject=:subject AND deviceId=:device") fun observeBaseline(subject: String, device: String): Flow<List<BaselineRow>>
    @Query("DELETE FROM sell_truck_stock_baseline WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun clearBaseline(subject: String, device: String)
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertMovement(row: MovementRow)
    @Query("SELECT * FROM sell_stock_movement WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun stockmovementRows(subject: String, device: String): List<MovementRow>
    @Query("SELECT * FROM sell_stock_movement WHERE fullAuthSubject=:subject AND deviceId=:device") fun observeMovement(subject: String, device: String): Flow<List<MovementRow>>
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertSettlement(row: SettlementRow)
    @Query("SELECT * FROM sell_movement_settlement WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun movementsettlementRows(subject: String, device: String): List<SettlementRow>
    @Query("SELECT * FROM sell_movement_settlement WHERE fullAuthSubject=:subject AND deviceId=:device") fun observeSettlement(subject: String, device: String): Flow<List<SettlementRow>>
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertOutbox(row: OutboxRow)
    @Query("SELECT * FROM sell_outbox WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun outboxRows(subject: String, device: String): List<OutboxRow>
    @Query("SELECT * FROM sell_outbox WHERE fullAuthSubject=:subject AND deviceId=:device") fun observeOutbox(subject: String, device: String): Flow<List<OutboxRow>>
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertAck(row: AckRow)
    @Query("SELECT * FROM sell_ack WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun ackRows(subject: String, device: String): List<AckRow>
    @Query("UPDATE sell_sync_meta SET held=1, health='held_for_review' WHERE fullAuthSubject<>:subject OR deviceId<>:device") suspend fun holdOtherScopes(subject: String, device: String)
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertSyncMeta(row: SyncMetaRow)
    @Query("SELECT * FROM sell_sync_meta WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun syncmetaRows(subject: String, device: String): List<SyncMetaRow>
    @Query("SELECT * FROM sell_sync_meta WHERE fullAuthSubject=:subject AND deviceId=:device") fun observeSyncMeta(subject: String, device: String): Flow<List<SyncMetaRow>>
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertSequenceCounter(row: SequenceCounterRow)
    @Query("SELECT * FROM sell_sequence_counter WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun sequencecounterRows(subject: String, device: String): List<SequenceCounterRow>
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertTransactionId(row: TransactionIdRow)
    @Query("SELECT * FROM sell_transaction_id WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun transactionidRows(subject: String, device: String): List<TransactionIdRow>
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertSale(row: SaleRow)
    @Query("SELECT * FROM sell_sale WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun saleRows(subject: String, device: String): List<SaleRow>
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertSaleVoid(row: SaleVoidRow)
    @Query("SELECT * FROM sell_sale_void WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun salevoidRows(subject: String, device: String): List<SaleVoidRow>
    @Query("SELECT * FROM sell_sale_void WHERE fullAuthSubject=:subject AND deviceId=:device AND saleId=:saleId") suspend fun saleVoid(subject: String, device: String, saleId: String): SaleVoidRow?
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertCashReconciliation(row: CashReconciliationRow)
    @Query("SELECT * FROM sell_cash_reconciliation WHERE fullAuthSubject=:subject AND deviceId=:device AND tripId=:tripId") suspend fun cashReconciliation(subject: String, device: String, tripId: String): CashReconciliationRow?
    /** VAN-079: a count the office refused is not a count; the seller counts again. */
    @Query("DELETE FROM sell_cash_reconciliation WHERE fullAuthSubject=:subject AND deviceId=:device AND idempotencyKey=:key") suspend fun deleteCashReconciliation(subject: String, device: String, key: String)
    @Query("DELETE FROM sell_stock_reconciliation WHERE fullAuthSubject=:subject AND deviceId=:device AND idempotencyKey=:key") suspend fun deleteStockReconciliation(subject: String, device: String, key: String)
    @Query("SELECT * FROM sell_cash_reconciliation WHERE fullAuthSubject=:subject AND deviceId=:device") fun observeCashReconciliation(subject: String, device: String): Flow<List<CashReconciliationRow>>
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertStockReconciliation(row: StockReconciliationRow)
    @Query("SELECT * FROM sell_stock_reconciliation WHERE fullAuthSubject=:subject AND deviceId=:device AND tripId=:tripId") suspend fun stockReconciliation(subject: String, device: String, tripId: String): StockReconciliationRow?
    @Query("SELECT * FROM sell_stock_reconciliation WHERE fullAuthSubject=:subject AND deviceId=:device") fun observeStockReconciliation(subject: String, device: String): Flow<List<StockReconciliationRow>>
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertTripClose(row: TripCloseRow)
    @Query("SELECT * FROM sell_trip_close WHERE fullAuthSubject=:subject AND deviceId=:device AND tripId=:tripId") suspend fun tripClose(subject: String, device: String, tripId: String): TripCloseRow?
    @Query("SELECT * FROM sell_trip_close WHERE fullAuthSubject=:subject AND deviceId=:device") fun observeTripClose(subject: String, device: String): Flow<List<TripCloseRow>>
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertSaleLine(row: SaleLineRow)
    @Query("SELECT * FROM sell_sale_line WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun salelineRows(subject: String, device: String): List<SaleLineRow>
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertPayment(row: PaymentRow)
    @Query("SELECT * FROM sell_payment WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun paymentRows(subject: String, device: String): List<PaymentRow>
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertCustomerReturn(row: CustomerReturnRow)
    @Query("SELECT * FROM sell_customer_return WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun customerreturnRows(subject: String, device: String): List<CustomerReturnRow>
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertReturnLine(row: ReturnLineRow)
    @Query("SELECT * FROM sell_return_line WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun returnlineRows(subject: String, device: String): List<ReturnLineRow>
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertReconciliation(row: ReconciliationRow)
    @Query("SELECT * FROM sell_reconciliation WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun reconciliationRows(subject: String, device: String): List<ReconciliationRow>
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertPriceListLine(row: PriceListLineRow)
    @Query("SELECT * FROM sell_price_list_line WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun pricelistlineRows(subject: String, device: String): List<PriceListLineRow>
    @Query("SELECT * FROM sell_price_list_line WHERE fullAuthSubject=:subject AND deviceId=:device") fun observePriceListLine(subject: String, device: String): Flow<List<PriceListLineRow>>
    @Query("DELETE FROM sell_price_list_line WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun clearPriceListLine(subject: String, device: String)
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertPromotion(row: PromotionRow)
    @Query("SELECT * FROM sell_promotion WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun promotionRows(subject: String, device: String): List<PromotionRow>
    @Query("SELECT * FROM sell_promotion WHERE fullAuthSubject=:subject AND deviceId=:device") fun observePromotion(subject: String, device: String): Flow<List<PromotionRow>>
    @Query("DELETE FROM sell_promotion WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun clearPromotion(subject: String, device: String)

    // SP-0137 live-location pings.
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertLocationPing(row: LocationPingRow)
    @Query("SELECT * FROM sell_location_ping WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun locationPingRows(subject: String, device: String): List<LocationPingRow>
    @Query("SELECT * FROM sell_location_ping WHERE fullAuthSubject=:subject AND deviceId=:device AND tripId=:tripId ORDER BY recordedAt DESC LIMIT 1") suspend fun latestLocationPing(subject: String, device: String, tripId: String): LocationPingRow?
    @Query("SELECT * FROM sell_location_ping WHERE fullAuthSubject=:subject AND deviceId=:device AND status='pending' AND tripId IN (:tripIds) ORDER BY recordedAt,clientPingId LIMIT :limit") suspend fun pendingLocationPings(subject: String, device: String, tripIds: List<String>, limit: Int): List<LocationPingRow>
    @Query("SELECT COUNT(*) FROM sell_location_ping WHERE fullAuthSubject=:subject AND deviceId=:device AND status='pending'") fun observePendingLocationPings(subject: String, device: String): Flow<Int>
    @Query("DELETE FROM sell_location_ping WHERE fullAuthSubject=:subject AND deviceId=:device AND clientPingId=:id AND status='pending'") suspend fun deleteLocationPing(subject: String, device: String, id: String)
    @Query("UPDATE sell_location_ping SET status='rejected',rejectionCode=:code WHERE fullAuthSubject=:subject AND deviceId=:device AND clientPingId=:id AND status='pending'") suspend fun rejectLocationPing(subject: String, device: String, id: String, code: String)
    @Query("DELETE FROM sell_location_ping WHERE fullAuthSubject=:subject AND deviceId=:device AND (recordedAt < :before OR status='rejected')") suspend fun pruneLocationPings(subject: String, device: String, before: Long)

    @Query("DELETE FROM sell_customer WHERE fullAuthSubject=:subject AND deviceId=:device AND localOnly=0") suspend fun clearServerCustomers(subject: String, device: String)
    @Query("SELECT * FROM sell_held_cart WHERE fullAuthSubject=:subject AND deviceId=:device AND surface=:surface ORDER BY createdAt DESC") suspend fun heldCarts(subject: String, device: String, surface: String): List<HeldCartRow>
    @Query("SELECT COUNT(*) FROM sell_held_cart WHERE fullAuthSubject=:subject AND deviceId=:device AND surface=:surface") fun observeHeldCount(subject: String, device: String, surface: String): Flow<Int>
    @Query("SELECT COUNT(*) FROM sell_held_cart WHERE fullAuthSubject=:subject AND deviceId=:device AND surface=:surface") suspend fun heldCount(subject: String, device: String, surface: String): Int
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertHeldCart(row: HeldCartRow)
    @Query("DELETE FROM sell_held_cart WHERE fullAuthSubject=:subject AND deviceId=:device AND holdId=:id") suspend fun deleteHeldCart(subject: String, device: String, id: String)
    @Query("DELETE FROM sell_held_cart WHERE fullAuthSubject=:subject AND deviceId=:device AND surface=:surface") suspend fun deleteHeldCarts(subject: String, device: String, surface: String)
    @Query("SELECT * FROM sell_sync_meta WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun meta(subject: String, device: String): SyncMetaRow?
    @Query("SELECT * FROM sell_trip WHERE fullAuthSubject=:subject AND deviceId=:device LIMIT 1") suspend fun trip(subject: String, device: String): TripRow?
    @Query("SELECT MAX(createdAt) FROM sell_outbox WHERE fullAuthSubject=:subject AND deviceId=:device") suspend fun latestCreatedAt(subject: String, device: String): Long?
    @Query("SELECT * FROM sell_outbox WHERE fullAuthSubject=:subject AND deviceId=:device AND status='pending' ORDER BY createdAt,clientRequestId LIMIT 20") suspend fun pending(subject: String, device: String): List<OutboxRow>
    @Query("SELECT * FROM sell_outbox WHERE fullAuthSubject=:subject AND deviceId=:device AND clientRequestId=:id") suspend fun outbox(subject: String, device: String, id: String): OutboxRow?
    @Query("SELECT * FROM sell_ack WHERE fullAuthSubject=:subject AND deviceId=:device AND clientRequestId=:id") suspend fun ack(subject: String, device: String, id: String): AckRow?
    @Query("UPDATE sell_outbox SET status='sending' WHERE fullAuthSubject=:subject AND deviceId=:device AND clientRequestId IN (:ids) AND status='pending'") suspend fun markSending(subject: String, device: String, ids: List<String>)
    @Query("UPDATE sell_outbox SET status='pending',rejectionCode=:code WHERE fullAuthSubject=:subject AND deviceId=:device AND clientRequestId=:id AND status IN ('pending','sending')") suspend fun markWaiting(subject: String, device: String, id: String, code: String)
    @Query("UPDATE sell_outbox SET status='pending' WHERE fullAuthSubject=:subject AND deviceId=:device AND status='sending'") suspend fun resetSending(subject: String, device: String)
    @Query("UPDATE sell_outbox SET status='done',rejectionCode=NULL WHERE fullAuthSubject=:subject AND deviceId=:device AND clientRequestId=:id AND status IN ('pending','sending') AND EXISTS (SELECT 1 FROM sell_ack WHERE sell_ack.fullAuthSubject=sell_outbox.fullAuthSubject AND sell_ack.deviceId=sell_outbox.deviceId AND sell_ack.clientRequestId=sell_outbox.clientRequestId)") suspend fun markDone(subject: String, device: String, id: String)
    @Query("UPDATE sell_outbox SET status=:status,rejectionCode=:code WHERE fullAuthSubject=:subject AND deviceId=:device AND clientRequestId=:id AND status IN ('pending','sending')") suspend fun reject(subject: String, device: String, id: String, status: String, code: String)
    @Query("SELECT * FROM sell_sequence_counter WHERE fullAuthSubject=:subject AND deviceId=:device AND tripId=:tripId") suspend fun counter(subject: String, device: String, tripId: String): SequenceCounterRow?
}

/**
 * SP-0192: the selling tables live in the Field app's one encrypted database ([com.sunpride.field.storage.StoreDatabase],
 * `sell_` tables, added by its v10 -> v11 migration). The copied selling code keeps its old name for it.
 */
typealias VanDatabase = com.sunpride.field.storage.StoreDatabase

/** Every selling entity, in the order the Field database lists them. */
val SELL_ENTITIES = listOf(TripRow::class,LoadLineRow::class,ProductRow::class,CustomerRow::class,BaselineRow::class,MovementRow::class,SettlementRow::class,OutboxRow::class,AckRow::class,SyncMetaRow::class,SequenceCounterRow::class,TransactionIdRow::class,SaleRow::class,SaleLineRow::class,PaymentRow::class,CustomerReturnRow::class,ReturnLineRow::class,ReconciliationRow::class,PriceListLineRow::class,PromotionRow::class,
    ReceiptPrintRow::class,SaleReceiptRow::class,SaleVoidRow::class,CashReconciliationRow::class,StockReconciliationRow::class,TripCloseRow::class,LocationPingRow::class,HeldCartRow::class)
