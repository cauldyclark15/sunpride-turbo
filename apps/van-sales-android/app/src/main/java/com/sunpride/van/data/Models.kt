package com.sunpride.van.data

import java.math.BigDecimal

/** [paymentMethods]: VAN-012 methods the office allows; a cache or server without the list allows cash only. */
data class VanPolicy(val allowNegativeStock: Boolean = false,
    val loadDiscrepancyRequiresApproval: Boolean = true, val walkInAllowed: Boolean = false,
    val loadDiscrepancyReasons: List<String> = emptyList(), val damageReasons: List<String> = emptyList(),
    val paymentMethods: List<PaymentMethod> = PaymentMethod.CASH_ONLY, val damagePolicy: DamagePolicy? = null,
    val voidReasons: List<String> = emptyList(), val voidApproval: VoidApproval? = null,
    val cashReconciliation: CashReconciliationPolicy? = null)
data class VoidApproval(val required: Boolean, val thresholdMinor: Long, val key: String?)
/**
 * VAN-022 end-of-trip cash count: any difference needs one of [reasons]; when [approvalRequired] a difference of more
 * than [toleranceMinor] either way also needs a supervisor code checked with the trip [key] (null = not available).
 * A policy cached before VAN-022 has none, and then every difference needs a code that cannot be checked.
 */
data class CashReconciliationPolicy(val approvalRequired: Boolean, val toleranceMinor: Long, val reasons: List<String>, val key: String?)
/** How a payment settles: [CASH] gives change, [OTHER] (check, e-wallet, bank) equals the total, [CREDIT] charges the account. */
enum class PaymentKind(val wire: String) { CASH("cash"), CREDIT("credit"), OTHER("other");
    companion object { fun of(wire: String) = entries.single { it.wire == wire } } }
/** VAN-012: one office-configured payment method; [referenceLabel] names the number to type (e.g. "Check number"). */
data class PaymentMethod(val code: String, val label: String, val kind: PaymentKind, val referenceRequired: Boolean, val referenceLabel: String?) {
    companion object {
        val CASH = PaymentMethod("cash","Cash",PaymentKind.CASH,false,null)
        val CASH_ONLY = listOf(CASH)
    }
}
/** VAN-012 office credit terms for one customer: days until due and credit available as of the bootstrap, in centavos. */
data class CustomerCredit(val termsDays: Int, val availableMinor: Long)
data class Seller(val profileId: String, val name: String)
data class Vehicle(val vehicleId: String, val vehicleCode: String, val plateNumber: String, val name: String?)
data class Route(val routeId: String, val code: String, val name: String)
data class Trip(val tripId: String, val tripNumber: String, val status: String, val serviceDate: String,
    val vehicle: Vehicle?, val route: Route?, val driverName: String?, val helperName: String?,
    val truckLocationId: String, val routeSessionId: String?, val startedAt: Long?,
    val startPending: Boolean = false) {
    val statusLabel: String get() = if (startPending) "Starting… waiting for sync" else status
}
data class LoadLine(val lineNumber: Int, val productId: String, val productCode: String,
    val productName: String, val uomCode: String, val quantityScale: Long, val lotNumber: String?,
    val expectedBase: Long, val actualBase: Long?, val discrepancyReason: String?,
    val pendingActualBase: Long? = null, val pendingReason: String? = null)
data class Load(val loadId: String, val status: String, val lines: List<LoadLine>, val confirmPending: Boolean = false)
/**
 * VAN-009: the unit one barcode scans into. [baseQuantity] is the base quantity of ONE scan
 * (e.g. a 24-piece case = 24 × quantityScale); null when the office has no exact conversion, so
 * the handheld names the unit but never guesses a quantity.
 */
data class BarcodeUnit(val barcode: String, val uomCode: String, val baseQuantity: Long?)
data class Product(val productId: String, val code: String, val name: String, val uomCode: String,
    val quantityScale: Long, val barcodes: List<String>, val barcodeUnits: List<BarcodeUnit> = emptyList()) {
    fun displayQuantity(base: Long): String = BigDecimal.valueOf(base).divide(BigDecimal.valueOf(quantityScale),java.math.MathContext.DECIMAL128).stripTrailingZeros().toPlainString()
}
data class Customer(val outletId: String, val code: String, val name: String, val address: String?,
    val sequence: Int?, val source: String, val reason: String? = null, val localOnly: Boolean = false,
    val credit: CustomerCredit? = null)
data class TruckStock(val productId: String, val availableBase: Long, val damagedBase: Long)
/** A governed price-list line cached from the server bootstrap (minor currency units, ADR-008). */
data class PriceLine(val priceListId: String, val productId: String, val uomCode: String, val unitPriceMinor: Long,
    val currency: String, val effectiveFrom: Long, val effectiveTo: Long?)
data class VanBootstrap(val serverTime: Long, val serviceDate: String, val seller: Seller, val policy: VanPolicy,
    val trip: Trip?, val load: Load?, val truckStock: List<TruckStock>, val products: List<Product>, val customers: List<Customer>,
    val priceLines: List<PriceLine> = emptyList(), val damageRecords: List<DamageRecord> = emptyList())
data class LoadActual(val lineNumber: Int, val actualBase: Long, val reason: String? = null)
/**
 * [savedSales]: VAN-011 sales committed on this phone whose office upload is not available yet (parked, never sent);
 * [savedReturns]: VAN-019 customer returns parked the same way.
 * VAN-025: [phoneOnly] every parked row (sales, voids, returns, cash counts); [received] rows the office acknowledged;
 * [sapPending] SAP-relevant rows (none is posted to SAP from the van this phase); [items] newest first, bounded.
 */
data class SyncStatus(val queued: Int = 0, val sending: Int = 0, val review: Int = 0,
    val held: Int = 0, val lastSyncTime: Long? = null, val health: String = "never_synced", val savedSales: Int = 0, val savedReturns: Int = 0,
    val phoneOnly: Int = 0, val received: Int = 0, val sapPending: Int = 0,
    val items: List<com.sunpride.van.sync.SyncItem> = emptyList())
/** A completed van sale as saved on this phone (VAN-011). Money is in minor units of [currency]. */
data class SaleReceiptLine(val lineNumber: Int, val productId: String, val name: String, val uomCode: String,
    val quantityLabel: String, val unitPriceMinor: Long, val totalMinor: Long)
/**
 * [paymentStatus] is separate from the sale's posting state: `paid` (cash), `awaiting_confirmation` (check, e-wallet,
 * bank: the office confirms the reference) or `on_account` (credit, due on [dueDate]). The sale itself is saved on
 * this phone whatever the payment state.
 */
data class SaleReceipt(val saleId: String, val receiptNumber: String, val customerName: String, val lines: List<SaleReceiptLine>,
    val currency: String, val totalMinor: Long, val tenderedMinor: Long, val changeMinor: Long, val createdAt: Long, val replay: Boolean = false,
    val paymentMethod: String = "cash", val paymentLabel: String = "Cash", val paymentKind: PaymentKind = PaymentKind.CASH,
    val paymentStatus: String = "paid", val reference: String? = null, val dueDate: String? = null)
data class PushAck(val entityId: String, val movementId: String?, val serverTime: Long)
data class PushResult(val kind: String, val clientRequestId: String, val status: String,
    val ack: PushAck? = null, val code: String? = null)
