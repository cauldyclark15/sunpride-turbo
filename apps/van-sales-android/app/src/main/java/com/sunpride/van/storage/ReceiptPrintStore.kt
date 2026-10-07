package com.sunpride.van.storage

import androidx.room.*
import com.sunpride.van.data.*
import com.sunpride.van.pos.PaymentState
import com.sunpride.van.printing.*
import com.sunpride.van.sync.VanBootstrapCodec
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** VAN-017 (v3): every print of a saved sale. Rows are only inserted and finished once, never deleted. */
@Entity(tableName = "receipt_print", primaryKeys = ["fullAuthSubject", "deviceId", "printId"],
    indices = [Index(value = ["fullAuthSubject", "deviceId", "saleId"])])
data class ReceiptPrintRow(val fullAuthSubject: String, val deviceId: String, val printId: String, val saleId: String,
    val kind: String, val copyNumber: Int, val reason: String?, val outcome: String, val startedAt: Long, val finishedAt: Long? = null)

/**
 * VAN-017 (v4): the receipt exactly as sold — customer, product names, UOM and quantity labels, payment wording,
 * seller, trip and truck — frozen in the checkout transaction. Inserted once and never updated, so a later
 * bootstrap that renames, re-units or removes master data can never change what a reprint says.
 */
@Entity(tableName = "sale_receipt", primaryKeys = ["fullAuthSubject", "deviceId", "saleId"])
data class SaleReceiptRow(val fullAuthSubject: String, val deviceId: String, val saleId: String, val documentJson: String)

/** Wire form of [SaleReceiptRow.documentJson]; amounts are strings so no long ever passes through a double. */
object FrozenReceipts {
    const val VERSION = 1
    fun encode(receipt: SaleReceipt, header: ReceiptHeader): String = JSONObject()
        .put("version", VERSION)
        .put("saleId", receipt.saleId).put("receiptNumber", receipt.receiptNumber).put("customerName", receipt.customerName)
        .put("lines", JSONArray(receipt.lines.map { JSONObject().put("lineNumber", it.lineNumber).put("productId", it.productId)
            .put("name", it.name).put("uomCode", it.uomCode).put("quantityLabel", it.quantityLabel)
            .put("unitPriceMinor", it.unitPriceMinor.toString()).put("totalMinor", it.totalMinor.toString()) }))
        .put("currency", receipt.currency).put("totalMinor", receipt.totalMinor.toString())
        .put("tenderedMinor", receipt.tenderedMinor.toString()).put("changeMinor", receipt.changeMinor.toString())
        .put("createdAt", receipt.createdAt.toString())
        .put("paymentMethod", receipt.paymentMethod).put("paymentLabel", receipt.paymentLabel).put("paymentKind", receipt.paymentKind.wire)
        .put("paymentStatus", receipt.paymentStatus).put("reference", receipt.reference ?: JSONObject.NULL).put("dueDate", receipt.dueDate ?: JSONObject.NULL)
        .put("header", JSONObject().put("sellerName", header.sellerName ?: JSONObject.NULL)
            .put("tripNumber", header.tripNumber ?: JSONObject.NULL).put("truck", header.truck ?: JSONObject.NULL))
        .toString()

    /** Always a replayed receipt: a frozen receipt is only read back for a saved sale. */
    fun decode(json: String): Pair<SaleReceipt, ReceiptHeader> {
        val o = JSONObject(json)
        check(o.getInt("version") == VERSION) { "Unknown frozen receipt version" }
        fun JSONObject.text(k: String): String? = if (isNull(k)) null else getString(k)
        val lines = o.getJSONArray("lines").let { a -> (0 until a.length()).map { i -> a.getJSONObject(i) } }.map {
            SaleReceiptLine(it.getInt("lineNumber"), it.getString("productId"), it.getString("name"), it.getString("uomCode"),
                it.getString("quantityLabel"), it.getString("unitPriceMinor").toLong(), it.getString("totalMinor").toLong())
        }
        val receipt = SaleReceipt(o.getString("saleId"), o.getString("receiptNumber"), o.getString("customerName"), lines,
            o.getString("currency"), o.getString("totalMinor").toLong(), o.getString("tenderedMinor").toLong(), o.getString("changeMinor").toLong(),
            o.getString("createdAt").toLong(), true, o.getString("paymentMethod"), o.getString("paymentLabel"), PaymentKind.of(o.getString("paymentKind")),
            o.getString("paymentStatus"), o.text("reference"), o.text("dueDate"))
        val h = o.getJSONObject("header")
        return receipt to ReceiptHeader(h.text("sellerName"), h.text("tripNumber"), h.text("truck"))
    }
}

/** Seller, trip and truck as the phone holds them now; frozen into [SaleReceiptRow] at checkout. */
internal suspend fun currentReceiptHeader(dao: VanDao, subject: String, device: String, trip: TripRow?): ReceiptHeader {
    val seller = dao.meta(subject, device)?.sellerJson?.let { JSONObject(it).optString("name").ifBlank { null } }
    val parsed = trip?.let { runCatching { VanBootstrapCodec.trip(JSONObject(it.json)) }.getOrNull() }
    return ReceiptHeader(seller, trip?.tripNumber, parsed?.vehicle?.let { "${it.vehicleCode} ${it.plateNumber}" })
}

@Dao
interface ReceiptPrintDao {
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insert(row: ReceiptPrintRow)
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertSaleReceipt(row: SaleReceiptRow)
    @Query("SELECT * FROM sale_receipt WHERE fullAuthSubject=:subject AND deviceId=:device AND saleId=:saleId")
    suspend fun saleReceipt(subject: String, device: String, saleId: String): SaleReceiptRow?
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
                val (receipt, header) = frozen(sale, trip)
                BeginPrint.Go(row.attempt(), receipt, header)
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
            .map { SavedSale(frozen(it, null).first, history[it.saleId].orEmpty().map { row -> row.attempt() }) }
    }

    suspend fun history(saleId: String): List<PrintAttempt> = prints.forSale(s, d, saleId).map { it.attempt() }

    /**
     * The receipt frozen at checkout. Only a sale saved before v4 (development phones) has none; it falls back to a
     * rebuild from saved rows and the sale's operation bytes, which reads names and units from current master data.
     */
    private suspend fun frozen(sale: SaleRow, trip: TripRow?): Pair<SaleReceipt, ReceiptHeader> =
        prints.saleReceipt(s, d, sale.saleId)?.let { FrozenReceipts.decode(it.documentJson) }
            ?: (legacyReceipt(sale) to currentReceiptHeader(dao, s, d, trip ?: dao.trip(s, d)))

    private suspend fun legacyReceipt(sale: SaleRow): SaleReceipt {
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
