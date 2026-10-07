package com.sunpride.van.storage

import androidx.room.withTransaction
import com.sunpride.van.data.*
import com.sunpride.van.ledger.StockProjection
import com.sunpride.van.pos.*
import com.sunpride.van.sync.VanBootstrapCodec
import com.sunpride.van.sync.VanWireFailure
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** VAN-011 sale operation kind and the outbox status of a sale saved on this phone that is never sent (no gateway operation yet). */
const val SALE_KIND = "sale.record"
const val SALE_PARKED = "parked"

/** A disagreement between a saved sale and its truck-stock deduction (VAN-018); a healthy phone has none. */
data class SaleStockIssue(val saleId: String?, val movementId: String?, val code: String)
/** VAN-012 credit sold here per customer (not yet acknowledged by the office) and `method|REFERENCE` keys already used. */
data class PaymentFacts(val creditUsedMinor: Map<String,Long> = emptyMap(), val usedReferences: Set<String> = emptySet())
private fun CustomerRow.toCustomer() = Customer(outletId,code,name,address,sequence,source,reason,localOnly,
    if (creditTermsDays != null && creditAvailableMinor != null) CustomerCredit(creditTermsDays,creditAvailableMinor) else null)

/** No mutation of operation bytes or movement facts, no DELETE of work/evidence. */
class RoomVanStore(val db: VanDatabase, override val scope: StoreScope, private val clock: () -> Long = System::currentTimeMillis) : com.sunpride.van.sync.VanSyncStore {
    private val dao = db.rows()
    private val s = scope.fullAuthSubject
    private val d = scope.deviceId
    val trip: Flow<Trip?> = combine(dao.observeTrip(s,d),dao.observeOutbox(s,d)) { rows, ops ->
        rows.singleOrNull()?.let { r -> VanBootstrapCodec.trip(JSONObject(r.json)).copy(startPending = ops.any { it.tripId == r.tripId && it.kind == "trip.start" && it.status in setOf("pending","sending") }) }
    }
    val load: Flow<Load?> = combine(dao.observeTrip(s,d),dao.observeLoadLine(s,d),dao.observeOutbox(s,d)) { trips,lines,ops ->
        val t = trips.singleOrNull()
        t?.loadId?.let { id ->
            val queued = ops.lastOrNull { it.kind == "load.confirm" && it.tripId == t.tripId && it.status in setOf("pending","sending") }
            val pending = queued?.let { VanBootstrapCodec.objects(JSONObject(it.operationJson).getJSONObject("payload").getJSONArray("lines")).associateBy { it.getInt("lineNumber") } } ?: emptyMap()
            Load(id,t.loadStatus!!,lines.filter { it.loadId == id }.sortedBy { it.lineNumber }.map { row ->
                val p = pending[row.lineNumber]
                VanBootstrapCodec.line(JSONObject(row.json)).copy(pendingActualBase = p?.getString("actualBase")?.toLong(),pendingReason = p?.optString("reason")?.takeIf { it.isNotBlank() })
            },queued != null)
        }
    }
    val policy: Flow<VanPolicy?> = dao.observeSyncMeta(s,d).let { flow -> flow.map { it.singleOrNull()?.policyJson?.let { json -> VanBootstrapCodec.policy(JSONObject(json)) } } }
    val seller: Flow<Seller?> = dao.observeSyncMeta(s,d).map { it.singleOrNull()?.sellerJson?.let { json -> JSONObject(json).let { o -> Seller(o.getString("profileId"),o.getString("name")) } } }
    val products: Flow<List<Product>> = dao.observeProduct(s,d).let { flow -> flow.map { rows -> rows.map { VanBootstrapCodec.product(JSONObject(it.json)) } } }
    val priceLines: Flow<List<PriceLine>> = dao.observePriceListLine(s,d).map { rows -> rows.map { PriceLine(it.priceListId,it.productId,it.uomCode,it.unitPriceMinor,it.currency,it.effectiveFrom,it.effectiveTo) } }
    val customers: Flow<List<Customer>> = dao.observeCustomer(s,d).let { flow -> flow.map { rows -> rows.sortedWith(compareBy<CustomerRow> { it.sequence ?: Int.MAX_VALUE }.thenBy { it.name }).map { it.toCustomer() } } }
    val syncStatus: Flow<SyncStatus> = combine(dao.observeOutbox(s,d),dao.observeSyncMeta(s,d)) { ops, metas ->
        val m = metas.singleOrNull(); val held = m?.held == true
        SyncStatus(if (held) 0 else ops.count { it.status == "pending" },if (held) 0 else ops.count { it.status == "sending" },
            ops.count { it.status in setOf("rejected","conflict") },if (held) ops.count { it.status in setOf("pending","sending") } else 0,m?.lastSyncTime,m?.health ?: "never_synced",
            ops.count { it.status == SALE_PARKED })
    }
    val truckStock: Flow<List<TruckStock>> = combine(dao.observeBaseline(s,d),dao.observeMovement(s,d),dao.observeSettlement(s,d),dao.observeTrip(s,d)) { b,m,settled,t ->
        val trip = t.singleOrNull()?.tripId
        if (trip == null) emptyList() else StockProjection.project(b.filter { it.tripId == trip },m.filter { it.tripId == trip },settled.map { it.movementId }.toSet())
    }
    suspend fun stock(): List<TruckStock> {
        val tripId = dao.trip(s,d)?.tripId ?: return emptyList()
        return StockProjection.project(dao.truckstockbaselineRows(s,d).filter { it.tripId == tripId },dao.stockmovementRows(s,d).filter { it.tripId == tripId },dao.movementsettlementRows(s,d).map { it.movementId }.toSet())
    }
    suspend fun canRemove(productId: String, qty: Long): Boolean = db.withTransaction {
        val p = dao.meta(s,d)?.policyJson?.let { VanBootstrapCodec.policy(JSONObject(it)) } ?: return@withTransaction false
        dao.productRows(s,d).any { it.productId == productId } && StockProjection.canRemove(stock().firstOrNull { it.productId == productId }?.availableBase ?: 0L,qty,p.allowNegativeStock)
    }
    private suspend fun writable(): TripRow {
        check(dao.meta(s,d)?.held == false) { "Partition held or not bootstrapped" }
        return checkNotNull(dao.trip(s,d)) { "No trip assigned" }
    }
    private fun text(value: String?, max: Int): String? = value?.trim()?.takeIf { it.isNotEmpty() }?.also { require(it.length <= max && it.none(Char::isISOControl)) }
    private suspend fun enqueue(kind: String, tripId: String, payload: JSONObject, metadataJson: String? = null): OutboxRow {
        val id = UUID.randomUUID().toString()
        val at = maxOf(clock(),Math.addExact(dao.latestCreatedAt(s,d) ?: 0L,1L))
        val op = JSONObject().put("kind",kind).put("clientRequestId",id).put("payload",payload).toString()
        com.sunpride.van.sync.VanWireSchema.validate(JSONObject(String(VanBootstrapCodec.pushRequest(d,listOf(op)),Charsets.UTF_8)))
        val row = OutboxRow(s,d,id,tripId,kind,op,at,metadataJson)
        dao.insertOutbox(row)
        return row
    }
    suspend fun startTrip(vehicleConfirmed: Boolean, routeConfirmed: Boolean, driverName: String?, helperName: String?, odometerKm: Double?, note: String?): String = db.withTransaction {
        val t = writable(); require(vehicleConfirmed && routeConfirmed)
        check(t.status == "loaded") { "Load must be posted before starting" }
        check(dao.outboxRows(s,d).none { it.tripId == t.tripId && it.kind == "trip.start" && it.status in setOf("pending","sending","done") }) { "Trip already starting" }
        require(odometerKm == null || odometerKm.isFinite() && odometerKm in 0.0..10_000_000.0)
        val p = JSONObject().put("tripId",t.tripId).put("vehicleConfirmed",true).put("routeConfirmed",true).put("deviceTime",clock())
        text(driverName,80)?.let { p.put("driverName",it) }; text(helperName,80)?.let { p.put("helperName",it) }
        odometerKm?.let { p.put("odometerKm",it) }; text(note,300)?.let { p.put("note",it) }
        enqueue("trip.start",t.tripId,p).clientRequestId
    }
    suspend fun confirmLoad(lines: List<LoadActual>): String = db.withTransaction {
        val t = writable(); check(t.status == "loading" && t.loadStatus == "planned") { "Load cannot be confirmed" }
        check(dao.outboxRows(s,d).none { it.tripId == t.tripId && it.kind == "load.confirm" && it.status in setOf("pending","sending","done") })
        val sheet = dao.loadlineRows(s,d).filter { it.loadId == t.loadId }
        require(lines.isNotEmpty() && lines.size == sheet.size && lines.map { it.lineNumber }.toSet() == sheet.map { it.lineNumber }.toSet())
        val policy = VanBootstrapCodec.policy(JSONObject(dao.meta(s,d)!!.policyJson!!))
        val inputs = JSONArray()
        lines.sortedBy { it.lineNumber }.forEach { line ->
            require(line.actualBase in 0L..999_999_999_999_999_999L)
            val expected = sheet.single { it.lineNumber == line.lineNumber }.expectedBase
            require(line.reason == null || line.reason in policy.loadDiscrepancyReasons)
            require(line.actualBase == expected || line.reason in policy.loadDiscrepancyReasons)
            inputs.put(JSONObject().put("lineNumber",line.lineNumber).put("actualBase",line.actualBase.toString()).also { line.reason?.let { reason -> it.put("reason",reason) } })
        }
        enqueue("load.confirm",t.tripId,JSONObject().put("tripId",t.tripId).put("loadId",t.loadId).put("lines",inputs).put("deviceTime",clock()),
            JSONArray(sheet.map { JSONObject().put("lineNumber",it.lineNumber).put("productId",it.productId) }).toString()).clientRequestId
    }
    suspend fun recordDamage(productId: String, qty: Long, reason: String, note: String?): String = db.withTransaction {
        val t = writable()
        check(t.status == "active" || dao.outboxRows(s,d).any { it.tripId == t.tripId && it.kind == "trip.start" && it.status in setOf("pending","sending","done") }) { "Trip not active" }
        val policy = VanBootstrapCodec.policy(JSONObject(dao.meta(s,d)!!.policyJson!!))
        require(reason in policy.damageReasons && qty in 1L..999_999_999_999_999_999L)
        check(canRemove(productId,qty)) { "Insufficient available truck stock" }
        val p = JSONObject().put("tripId",t.tripId).put("productId",productId).put("quantityBase",qty.toString()).put("reason",reason).put("deviceTime",clock())
        text(note,300)?.let { p.put("note",it) }
        val row = enqueue("truck.damage",t.tripId,p)
        dao.insertMovement(MovementRow(s,d,row.clientRequestId+":available",t.tripId,productId,"DAMAGE","available",-qty,reason,row.clientRequestId,row.createdAt))
        dao.insertMovement(MovementRow(s,d,row.clientRequestId+":damaged",t.tripId,productId,"DAMAGE","damaged",qty,reason,row.clientRequestId,row.createdAt))
        row.clientRequestId
    }
    internal suspend fun recordLocalMovement(type: com.sunpride.van.ledger.MovementType, productId: String,
        stockStatus: com.sunpride.van.ledger.StockStatus, quantityBase: Long, reason: String?, clientRequestId: String): String = db.withTransaction {
        // VAN-018: a SALE deduction exists only together with its saved sale, so it is written by [commitSale] alone.
        require(type !in setOf(com.sunpride.van.ledger.MovementType.LOAD,com.sunpride.van.ledger.MovementType.DAMAGE,com.sunpride.van.ledger.MovementType.SALE)) {
            "Load, damage and sale use their atomic paths" }
        require(Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$").matches(clientRequestId) && quantityBase != 0L)
        val t = writable()
        require(dao.productRows(s,d).any { it.productId == productId })
        if (type == com.sunpride.van.ledger.MovementType.RETURN) require(quantityBase > 0)
        val id = "$clientRequestId:$productId:${stockStatus.name}:${type.name}"
        val prior = dao.stockmovementRows(s,d).singleOrNull { it.movementId == id }
        if (prior != null) {
            check(prior.tripId == t.tripId && prior.quantityBase == quantityBase && prior.reason == reason) { "Movement replay conflict" }
        } else {
            if (stockStatus == com.sunpride.van.ledger.StockStatus.available && quantityBase < 0) check(canRemove(productId,Math.negateExact(quantityBase))) { "Insufficient available truck stock" }
            dao.insertMovement(MovementRow(s,d,id,t.tripId,productId,type.name,stockStatus.name,quantityBase,reason,clientRequestId,clock()))
        }
        id
    }
    suspend fun addWalkInCustomer(name: String, reason: String): Customer = db.withTransaction {
        writable()
        check(VanBootstrapCodec.policy(JSONObject(dao.meta(s,d)!!.policyJson!!)).walkInAllowed)
        val n = checkNotNull(text(name,150)); val r = checkNotNull(text(reason,300))
        val row = CustomerRow(s,d,"local:"+UUID.randomUUID(),"",n,null,null,"walk_in",r,true)
        dao.insertCustomer(row)
        Customer(row.outletId,row.code,n,null,null,row.source,r,true)
    }
    /** Same rule as damage: the trip is on route, or its start is saved on this phone. */
    private suspend fun selling(t: TripRow): Boolean = t.status == "active" ||
        dao.outboxRows(s,d).any { it.tripId == t.tripId && it.kind == "trip.start" && it.status in setOf("pending","sending","done") }

    /** Checkout context read from this scoped partition; inside [commitSale] it is read in the sale's transaction. */
    suspend fun checkoutContext(): CheckoutContext {
        val t = dao.trip(s,d); val meta = dao.meta(s,d); val facts = paymentFacts()
        return CheckoutContext(t != null && meta?.held == false && selling(t),
            dao.customerRows(s,d).map { it.toCustomer() },
            dao.productRows(s,d).map { VanBootstrapCodec.product(JSONObject(it.json)) }, stock(),
            dao.pricelistlineRows(s,d).map { PriceLine(it.priceListId,it.productId,it.uomCode,it.unitPriceMinor,it.currency,it.effectiveFrom,it.effectiveTo) },
            meta?.policyJson?.let { VanBootstrapCodec.policy(JSONObject(it)) }, clock(), t?.serviceDate,
            facts.creditUsedMinor, facts.usedReferences)
    }

    /**
     * VAN-012 payment facts from this partition's saved payments: credit sold per customer whose sale the office has
     * not acknowledged (it still counts against the bootstrap's available credit), and every recorded reference.
     */
    suspend fun paymentFacts(): PaymentFacts {
        val acked = dao.outboxRows(s,d).filter { it.status == "done" }.map { it.clientRequestId }.toSet()
        val sales = dao.saleRows(s,d).associateBy { it.saleId }
        val credit = mutableMapOf<String,Long>(); val references = mutableSetOf<String>()
        dao.paymentRows(s,d).forEach { p ->
            p.reference?.let { references += PaymentReference.key(p.method,it) }
            val sale = sales[p.saleId] ?: return@forEach
            if (p.status == PaymentState.ON_ACCOUNT.wire && sale.idempotencyKey !in acked)
                credit[sale.customerId] = Math.addExact(credit[sale.customerId] ?: 0L,p.amountMinor ?: 0L)
        }
        return PaymentFacts(credit,references)
    }

    /**
     * VAN-011 checkout. ONE Room transaction re-validates the cart against the stored trip, customer, truck stock
     * and price list, refuses if the total differs from [expectedTotalMinor] (what the seller agreed with the
     * customer), then writes the receipt number, sale, lines, cash payment, SALE stock movements and the sale's
     * outbox operation. Any failure leaves nothing behind. The sale is complete on this phone before any upload.
     *
     * The van gateway has no sale operation yet, so the outbox row is [SALE_PARKED]: it keeps the frozen
     * operation bytes, is never sent, and its stock stays deducted. Tapping Complete again with the same
     * [CheckoutRequest.saleId] returns the saved sale instead of selling twice.
     */
    suspend fun commitSale(request: CheckoutRequest, expectedTotalMinor: Long): SaleReceipt = db.withTransaction {
        dao.saleRows(s,d).singleOrNull { it.saleId == request.saleId }?.let { return@withTransaction savedReceipt(it,request) }
        val context = checkoutContext()
        val result = CheckoutRules.evaluate(request,context)
        if (!result.ok) throw CheckoutRefused(result.issues)
        val quote = checkNotNull(result.quote)
        if (quote.totalMinor != expectedTotalMinor) throw CheckoutRefused(listOf(CheckoutIssue(CheckoutProblem.PRICES_CHANGED)))
        val t = writable()
        val customer = context.customers.single { it.outletId == request.customerId }
        val id = com.sunpride.van.ids.TransactionIds(db,scope).issue(t.tripId,t.tripNumber)
        val at = maxOf(context.now,Math.addExact(dao.latestCreatedAt(s,d) ?: 0L,1L))
        val pay = quote.payment
        // Posting state ("saved" on this phone) and payment state are separate columns (VAN-012).
        dao.insertSale(SaleRow(s,d,request.saleId,t.tripId,id.receiptNumber,id.idempotencyKey,customer.outletId,"saved",quote.totalMinor,at,pay.state.wire))
        quote.lines.forEach { dao.insertSaleLine(SaleLineRow(s,d,request.saleId,it.lineNumber,it.product.productId,it.quantityBase,it.unitPriceMinor,it.totalMinor)) }
        dao.insertPayment(PaymentRow(s,d,UUID.randomUUID().toString(),request.saleId,pay.method.code,pay.amountMinor,at,
            pay.reference,pay.state.wire,pay.tenderedMinor,pay.dueDate))
        // VAN-018: deduct every line from available truck stock in this same transaction, then prove the sale and
        // its deductions agree before commit. Any refusal or mismatch throws and rolls the whole sale back.
        val allowNegative = checkNotNull(context.policy).allowNegativeStock
        quote.lines.forEach { deductSale(t.tripId,id.idempotencyKey,it.product.productId,it.quantityBase,at,allowNegative) }
        check(saleStockIssues(request.saleId).isEmpty()) { "Sale and truck stock disagree" }
        val customerJson = if (customer.localOnly) JSONObject().put("walkIn",JSONObject().put("name",customer.name).put("reason",customer.reason))
            else JSONObject().put("outletId",customer.outletId)
        val payload = JSONObject().put("tripId",t.tripId).put("saleId",request.saleId).put("receiptNumber",id.receiptNumber)
            .put("customer",customerJson).put("currency",quote.currency).put("totalMinor",quote.totalMinor.toString())
            .put("lines",JSONArray(quote.lines.map { JSONObject().put("lineNumber",it.lineNumber).put("productId",it.product.productId)
                .put("quantityBase",it.quantityBase.toString()).put("unitPriceMinor",it.unitPriceMinor.toString()).put("totalMinor",it.totalMinor.toString())
                .put("priceListIds",JSONArray(it.priceListIds)) }))
            .put("payment",JSONObject().put("method",pay.method.code).put("kind",pay.method.kind.wire).put("status",pay.state.wire)
                .put("amountMinor",pay.amountMinor.toString())
                .apply { pay.tenderedMinor?.let { put("tenderedMinor",it.toString()).put("changeMinor",pay.changeMinor.toString()) } }
                .apply { pay.reference?.let { put("reference",it) } }
                .apply { pay.dueDate?.let { put("dueDate",it) } })
            .put("deviceTime",context.now)
        val op = JSONObject().put("kind",SALE_KIND).put("clientRequestId",id.idempotencyKey).put("payload",payload).toString()
        dao.insertOutbox(OutboxRow(s,d,id.idempotencyKey,t.tripId,SALE_KIND,op,at,null,SALE_PARKED))
        SaleReceipt(request.saleId,id.receiptNumber,customer.name,quote.lines.map { receiptLine(it.lineNumber,it.product,it.quantityBase,it.unitPriceMinor,it.totalMinor) },
            quote.currency,quote.totalMinor,quote.tenderedMinor,quote.changeMinor,at,false,pay.method.code,pay.method.label,pay.method.kind,
            pay.state.wire,pay.reference,pay.dueDate)
    }
    /** One SALE movement per sale line; the available-stock check is repeated against the rows already written in this transaction. */
    private suspend fun deductSale(tripId: String, key: String, productId: String, quantityBase: Long, at: Long, allowNegative: Boolean) {
        val movementId = saleMovementId(key,productId)
        check(dao.stockmovementRows(s,d).none { it.movementId == movementId }) { "Sale already deducted" }
        val available = stock().firstOrNull { it.productId == productId }?.availableBase ?: 0L
        if (!com.sunpride.van.ledger.StockProjection.canRemove(available,quantityBase,allowNegative))
            throw CheckoutRefused(listOf(CheckoutIssue(CheckoutProblem.INSUFFICIENT_STOCK,productId)))
        dao.insertMovement(MovementRow(s,d,movementId,tripId,productId,com.sunpride.van.ledger.MovementType.SALE.name,
            com.sunpride.van.ledger.StockStatus.available.name,Math.negateExact(quantityBase),null,key,at))
    }

    /**
     * VAN-018 invariant: every saved sale has exactly one available-stock SALE deduction per line, for the line's
     * quantity, on the sale's trip and at the sale's time, and no SALE deduction exists without a saved sale.
     * Empty means the sales and truck stock on this phone agree. [saleId] narrows the check to one sale.
     */
    suspend fun saleStockIssues(saleId: String? = null): List<SaleStockIssue> = db.withTransaction {
        val sales = dao.saleRows(s,d).filter { saleId == null || it.saleId == saleId }
        val lines = dao.salelineRows(s,d).groupBy { it.saleId }
        val movements = dao.stockmovementRows(s,d).filter { it.type == com.sunpride.van.ledger.MovementType.SALE.name }
        val issues = mutableListOf<SaleStockIssue>()
        sales.forEach { sale ->
            val saleLines = lines[sale.saleId] ?: emptyList()
            val expected = saleLines.associate { saleMovementId(sale.idempotencyKey,it.productId) to it.quantityBase }
            val actual = movements.filter { it.clientRequestId == sale.idempotencyKey }
            if (saleLines.isEmpty()) issues += SaleStockIssue(sale.saleId,null,"no_lines")
            if (expected.size != saleLines.size) issues += SaleStockIssue(sale.saleId,null,"duplicate_product")
            actual.filter { it.movementId !in expected }.forEach { issues += SaleStockIssue(sale.saleId,it.movementId,"unexpected_deduction") }
            expected.forEach { (movementId, qty) ->
                val m = actual.singleOrNull { it.movementId == movementId }
                when {
                    m == null -> issues += SaleStockIssue(sale.saleId,movementId,"missing_deduction")
                    m.quantityBase != Math.negateExact(qty) || m.stockStatus != com.sunpride.van.ledger.StockStatus.available.name ||
                        m.tripId != sale.tripId || m.createdAt != sale.createdAt -> issues += SaleStockIssue(sale.saleId,movementId,"wrong_deduction")
                }
            }
        }
        if (saleId == null) {
            val keys = dao.saleRows(s,d).map { it.idempotencyKey }.toSet()
            movements.filter { it.clientRequestId !in keys }.forEach { issues += SaleStockIssue(null,it.movementId,"deduction_without_sale") }
        }
        issues
    }
    private fun saleMovementId(key: String, productId: String) =
        "$key:$productId:${com.sunpride.van.ledger.StockStatus.available.name}:${com.sunpride.van.ledger.MovementType.SALE.name}"

    private suspend fun savedReceipt(sale: SaleRow, request: CheckoutRequest): SaleReceipt {
        val lines = dao.salelineRows(s,d).filter { it.saleId == sale.saleId }.sortedBy { it.lineNumber }
        check(sale.customerId == request.customerId && lines.map { it.productId to it.quantityBase } == request.lines.map { it.productId to it.quantityBase }) { "Sale replay conflict" }
        val op = JSONObject(checkNotNull(dao.outbox(s,d,sale.idempotencyKey)).operationJson).getJSONObject("payload")
        val payment = op.getJSONObject("payment")
        // A sale saved before VAN-012 has {"terms":"cash"}; the method, kind and state then are cash/paid.
        val code = payment.optString("method","cash")
        val method = (dao.meta(s,d)?.policyJson?.let { VanBootstrapCodec.policy(JSONObject(it)).paymentMethods } ?: emptyList())
            .firstOrNull { it.code == code } ?: PaymentMethod.CASH.takeIf { code == "cash" } ?: PaymentMethod(code,code,PaymentKind.of(payment.optString("kind","other")),false,null)
        val total = sale.totalMinor!!
        val tendered = if (payment.has("tenderedMinor")) payment.getString("tenderedMinor").toLong() else total
        val change = if (payment.has("changeMinor")) payment.getString("changeMinor").toLong() else 0L
        val products = dao.productRows(s,d).associate { it.productId to VanBootstrapCodec.product(JSONObject(it.json)) }
        val customer = dao.customerRows(s,d).singleOrNull { it.outletId == sale.customerId }?.name ?: ""
        return SaleReceipt(sale.saleId,sale.receiptNumber,customer,lines.map { receiptLine(it.lineNumber,checkNotNull(products[it.productId]),it.quantityBase,it.unitPriceMinor!!,it.totalMinor!!) },
            op.getString("currency"),total,tendered,change,sale.createdAt,true,code,method.label,method.kind,
            sale.paymentStatus ?: payment.optString("status",PaymentState.PAID.wire),payment.optString("reference").ifEmpty { null },payment.optString("dueDate").ifEmpty { null })
    }
    private fun receiptLine(n: Int, p: Product, quantityBase: Long, unit: Long, total: Long) =
        SaleReceiptLine(n,p.productId,p.name,p.uomCode,p.displayQuantity(quantityBase),unit,total)

    override suspend fun pending(): List<OutboxRow> = if (dao.meta(s,d)?.held == true) emptyList() else dao.pending(s,d)
    override suspend fun resetSending() = dao.resetSending(s,d)
    override suspend fun markSending(ids: List<String>) = dao.markSending(s,d,ids)
    override suspend fun hold() = db.withTransaction { val m = dao.meta(s,d) ?: SyncMetaRow(s,d); dao.insertSyncMeta(m.copy(held=true,health="held_for_review")); dao.resetSending(s,d) }
    override suspend fun setHealth(health: String, successTime: Long?) = db.withTransaction {
        val m = dao.meta(s,d) ?: SyncMetaRow(s,d)
        dao.insertSyncMeta(m.copy(health=health,lastSyncTime=successTime ?: m.lastSyncTime))
    }
    override suspend fun recordResult(row: OutboxRow, result: PushResult) = db.withTransaction {
        check(result.clientRequestId == row.clientRequestId && result.kind == row.kind)
        val current = checkNotNull(dao.outbox(s,d,row.clientRequestId))
        check(row.fullAuthSubject == s && row.deviceId == d && current.kind == row.kind && current.tripId == row.tripId &&
            current.operationJson == row.operationJson && current.metadataJson == row.metadataJson) { "Immutable operation mismatch" }
        if (result.status == "accepted") {
            val a = checkNotNull(result.ack); val ack = AckRow(s,d,row.clientRequestId,a.entityId,a.movementId,a.serverTime)
            val prior = dao.ack(s,d,row.clientRequestId)
            if (prior != null) check(prior == ack) else {
                check(current.status in setOf("pending","sending"))
                dao.insertAck(ack) // must exist before markDone; same Room transaction
                if (row.kind == "load.confirm" && a.movementId != null) recordPostedLoad(row,a.serverTime,settled=false)
            }
            OutboxRules.acknowledge(current.status,true)
            dao.markDone(s,d,row.clientRequestId)
            settle(dao.trip(s,d)?.tripId,dao.meta(s,d)?.lastBootstrapTime)
        } else {
            require(result.status in setOf("rejected","conflict"))
            dao.reject(s,d,row.clientRequestId,result.status,result.code ?: "invalid_request")
        }
    }
    private suspend fun recordPostedLoad(op: OutboxRow, at: Long, settled: Boolean, serverLines: List<LoadLine>? = null) {
        val p = JSONObject(op.operationJson).getJSONObject("payload"); val loadId = p.getString("loadId")
        val sheet = op.metadataJson?.let { VanBootstrapCodec.objects(JSONArray(it)) }
            ?: dao.loadlineRows(s,d).filter { it.loadId == loadId }.map { JSONObject().put("lineNumber",it.lineNumber).put("productId",it.productId) }
        val existing = dao.stockmovementRows(s,d).map { it.movementId }.toSet()
        VanBootstrapCodec.objects(p.getJSONArray("lines")).forEach { input ->
            val id = "load:$loadId:${input.getInt("lineNumber")}"
            val line = sheet.singleOrNull { it.getInt("lineNumber") == input.getInt("lineNumber") } ?: throw VanWireFailure()
            val serverLine = serverLines?.singleOrNull { it.lineNumber == input.getInt("lineNumber") }
            val quantity = serverLine?.actualBase ?: input.getString("actualBase").toLong()
            if (id !in existing) dao.insertMovement(MovementRow(s,d,id,op.tripId,line.getString("productId"),"LOAD","available",quantity,serverLine?.discrepancyReason ?: input.optString("reason").takeIf { it.isNotBlank() },op.clientRequestId,at))
            if (settled && dao.movementsettlementRows(s,d).none { it.movementId == id }) dao.insertSettlement(SettlementRow(s,d,id,at))
        }
    }
    private suspend fun settle(tripId: String?, baselineAt: Long?) {
        if (tripId == null || baselineAt == null) return
        val acknowledgements = dao.ackRows(s,d).associateBy { it.clientRequestId }
        val settled = dao.movementsettlementRows(s,d).map { it.movementId }.toSet()
        dao.stockmovementRows(s,d).filter { it.tripId == tripId && it.movementId !in settled && StockProjection.reflected(acknowledgements[it.clientRequestId]?.serverTime,baselineAt) }.forEach {
            dao.insertSettlement(SettlementRow(s,d,it.movementId,baselineAt))
        }
    }
    override suspend fun replaceBootstrap(text: String): VanBootstrap = db.withTransaction {
        val b = VanBootstrapCodec.decode(text); val o = JSONObject(text)
        val previous = dao.meta(s,d)
        check(previous?.lastBootstrapTime == null || b.serverTime >= previous.lastBootstrapTime) { "Stale bootstrap" }
        dao.clearTrip(s,d); dao.clearLoadLine(s,d); dao.clearProduct(s,d); dao.clearServerCustomers(s,d); dao.clearBaseline(s,d)
        b.trip?.let { t -> dao.insertTrip(TripRow(s,d,t.tripId,t.tripNumber,t.status,t.serviceDate,o.getJSONObject("trip").toString(),b.load?.loadId,b.load?.status)) }
        b.load?.let { l -> VanBootstrapCodec.objects(o.getJSONObject("load").getJSONArray("lines")).forEach { line ->
            val parsed = VanBootstrapCodec.line(line)
            dao.insertLoadLine(LoadLineRow(s,d,l.loadId,parsed.lineNumber,parsed.productId,parsed.expectedBase,parsed.actualBase,line.toString()))
        } }
        VanBootstrapCodec.objects(o.getJSONArray("products")).forEach { product -> val p = VanBootstrapCodec.product(product)
            dao.insertProduct(ProductRow(s,d,p.productId,p.code,p.name,p.uomCode,p.quantityScale,product.getJSONArray("barcodes").toString(),product.toString())) }
        b.customers.forEach { dao.insertCustomer(CustomerRow(s,d,it.outletId,it.code,it.name,it.address,it.sequence,it.source,
            creditTermsDays = it.credit?.termsDays,creditAvailableMinor = it.credit?.availableMinor)) }
        b.trip?.let { t -> b.truckStock.forEach { stock ->
            dao.insertBaseline(BaselineRow(s,d,t.tripId,stock.productId,"available",stock.availableBase,b.serverTime))
            dao.insertBaseline(BaselineRow(s,d,t.tripId,stock.productId,"damaged",stock.damagedBase,b.serverTime))
        } }
        // A discrepancy ack does NOT imply posted stock. A later posted snapshot is authoritative.
        if (b.load?.status == "posted") dao.outboxRows(s,d).filter { it.kind == "load.confirm" && it.tripId == b.trip?.tripId }.forEach { op ->
            val ack = dao.ack(s,d,op.clientRequestId)
            if (ack != null && b.serverTime > ack.serverTime) recordPostedLoad(op,b.serverTime,settled=true,serverLines=b.load.lines)
        }
        settle(b.trip?.tripId,b.serverTime)
        dao.insertSyncMeta(SyncMetaRow(s,d,b.serverTime,previous?.lastSyncTime,"bootstrap_ready",b.serviceDate,o.getJSONObject("policy").toString(),false,o.getJSONObject("seller").toString()))
        b
    }
}
