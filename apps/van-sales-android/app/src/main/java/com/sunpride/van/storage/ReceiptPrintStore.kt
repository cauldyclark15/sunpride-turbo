package com.sunpride.van.storage

import androidx.room.*
import com.sunpride.van.data.*
import com.sunpride.van.pos.PaymentState
import com.sunpride.van.printing.*
import com.sunpride.van.sync.VanBootstrapCodec
import org.json.JSONObject
import java.util.UUID

/** VAN-017 (v3): every print of a saved sale. Rows are only inserted and finished once, never deleted. */
@Entity(tableName = "receipt_print", primaryKeys = ["fullAuthSubject", "deviceId", "printId"],
    indices = [Index(value = ["fullAuthSubject", "deviceId", "saleId"])])
data class ReceiptPrintRow(val fullAuthSubject: String, val deviceId: String, val printId: String, val saleId: String,
    val kind: String, val copyNumber: Int, val reason: String?, val outcome: String, val startedAt: Long, val finishedAt: Long? = null)

@Dao
interface ReceiptPrintDao {
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insert(row: ReceiptPrintRow)
    @Query("SELECT * FROM receipt_print WHERE fullAuthSubject=:subject AND deviceId=:device AND saleId=:saleId ORDER BY startedAt,printId")
    suspend fun forSale(subject: String, device: String, saleId: String): List<ReceiptPrintRow>
    @Query("SELECT * FROM receipt_print WHERE fullAuthSubject=:subject AND deviceId=:device ORDER BY startedAt,printId")
    suspend fun all(subject: String, device: String): List<ReceiptPrintRow>
    /** Only a `started` attempt can be finished, and only once. */
    @Query("UPDATE receipt_print SET outcome=:outcome,finishedAt=:at WHERE fullAuthSubject=:subject AND deviceId=:device AND printId=:printId AND outcome='started'")
    suspend fun finish(subject: String, device: String, printId: String, outcome: String, at: Long): Int
}

/** A saved sale on the current trip, for the Receipts list. */
data class SavedSale(val receipt: SaleReceipt, val prints: List<PrintAttempt>) {
    val printed: Boolean get() = prints.any { it.mayHaveReachedPaper }
    val reprintsLeft: Int get() = ReprintRules.remaining(prints)
}

private fun ReceiptPrintRow.attempt() = PrintAttempt(printId, saleId, PrintKind.of(kind), copyNumber, reason, PrintOutcome.of(outcome), startedAt, finishedAt)

/**
 * The scoped (full auth subject + registered device) print log. Authorization is the store scope itself: only the
 * signed-in, registered seller's own sales on this phone, on the trip the phone is on now, and never while held.
 */
class RoomReceiptPrintLog(private val db: VanDatabase, private val scope: StoreScope, private val clock: () -> Long = System::currentTimeMillis) : ReceiptPrintLog {
    private val dao = db.rows()
    private val prints = db.receiptPrints()
    private val s = scope.fullAuthSubject
    private val d = scope.deviceId

    override suspend fun begin(saleId: String, explicit: Boolean, reasonCode: String?): BeginPrint = db.withTransaction {
        val sale = dao.saleRows(s, d).singleOrNull { it.saleId == saleId } ?: return@withTransaction BeginPrint.Refused(PrintRefusal.SALE_NOT_FOUND)
        if (dao.meta(s, d)?.held != false) return@withTransaction BeginPrint.Refused(PrintRefusal.HELD)
        val trip = dao.trip(s, d)
        if (trip?.tripId != sale.tripId) return@withTransaction BeginPrint.Refused(PrintRefusal.NOT_THIS_TRIP)
        val history = prints.forSale(s, d, saleId).map { it.attempt() }
        when (val decision = ReprintRules.decide(history, explicit, reasonCode)) {
            is PrintDecision.Refused -> BeginPrint.Refused(decision.refusal)
            is PrintDecision.Print -> {
                // Strictly increasing per sale, so the history reads in print order even within one millisecond.
                val at = maxOf(clock(), Math.addExact(history.maxOfOrNull { it.startedAt } ?: 0L, 1L))
                val row = ReceiptPrintRow(s, d, UUID.randomUUID().toString(), saleId, decision.kind.wire, decision.copyNumber,
                    decision.reason, PrintOutcome.STARTED.wire, at)
                prints.insert(row)
                BeginPrint.Go(row.attempt(), receipt(sale), header(trip))
            }
        }
    }

    override suspend fun finish(printId: String, outcome: PrintOutcome) {
        require(outcome != PrintOutcome.STARTED)
        check(prints.finish(s, d, printId, outcome.wire, clock()) == 1) { "Print already finished" }
    }

    /** Sales saved on the trip this phone is on now, newest first, with their print history. */
    suspend fun savedSales(): List<SavedSale> = db.withTransaction {
        val tripId = dao.trip(s, d)?.tripId ?: return@withTransaction emptyList()
        val history = prints.all(s, d).groupBy { it.saleId }
        dao.saleRows(s, d).filter { it.tripId == tripId }.sortedWith(compareByDescending<SaleRow> { it.createdAt }.thenByDescending { it.receiptNumber })
            .map { SavedSale(receipt(it), history[it.saleId].orEmpty().map { row -> row.attempt() }) }
    }

    suspend fun history(saleId: String): List<PrintAttempt> = prints.forSale(s, d, saleId).map { it.attempt() }

    private suspend fun header(trip: TripRow?): ReceiptHeader {
        val seller = dao.meta(s, d)?.sellerJson?.let { JSONObject(it).optString("name").ifBlank { null } }
        val parsed = trip?.let { runCatching { VanBootstrapCodec.trip(JSONObject(it.json)) }.getOrNull() }
        return ReceiptHeader(seller, trip?.tripNumber, parsed?.vehicle?.let { "${it.vehicleCode} ${it.plateNumber}" })
    }

    /** Rebuilt from the saved rows and the sale's frozen operation bytes, exactly as Complete sale returned it. */
    private suspend fun receipt(sale: SaleRow): SaleReceipt {
        val lines = dao.salelineRows(s, d).filter { it.saleId == sale.saleId }.sortedBy { it.lineNumber }
        val op = JSONObject(checkNotNull(dao.outbox(s, d, sale.idempotencyKey)).operationJson).getJSONObject("payload")
        val payment = op.getJSONObject("payment")
        val code = payment.optString("method", "cash")
        val method = (dao.meta(s, d)?.policyJson?.let { VanBootstrapCodec.policy(JSONObject(it)).paymentMethods } ?: emptyList())
            .firstOrNull { it.code == code } ?: PaymentMethod.CASH.takeIf { code == "cash" }
            ?: PaymentMethod(code, code, PaymentKind.of(payment.optString("kind", "other")), false, null)
        val total = checkNotNull(sale.totalMinor)
        val tendered = if (payment.has("tenderedMinor")) payment.getString("tenderedMinor").toLong() else total
        val change = if (payment.has("changeMinor")) payment.getString("changeMinor").toLong() else 0L
        val products = dao.productRows(s, d).associate { it.productId to VanBootstrapCodec.product(JSONObject(it.json)) }
        val customer = dao.customerRows(s, d).singleOrNull { it.outletId == sale.customerId }?.name
            ?: op.optJSONObject("customer")?.optJSONObject("walkIn")?.optString("name") ?: ""
        val receiptLines = lines.map { line ->
            val product = products[line.productId]
            SaleReceiptLine(line.lineNumber, line.productId, product?.name ?: line.productId, product?.uomCode ?: "",
                product?.displayQuantity(line.quantityBase) ?: line.quantityBase.toString(), checkNotNull(line.unitPriceMinor), checkNotNull(line.totalMinor))
        }
        return SaleReceipt(sale.saleId, sale.receiptNumber, customer, receiptLines, op.getString("currency"), total, tendered, change,
            sale.createdAt, true, code, method.label, method.kind, sale.paymentStatus ?: payment.optString("status", PaymentState.PAID.wire),
            payment.optString("reference").ifEmpty { null }, payment.optString("dueDate").ifEmpty { null })
    }
}
