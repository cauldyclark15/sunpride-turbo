package com.sunpride.van.data

import java.math.BigDecimal

data class VanPolicy(val allowNegativeStock: Boolean = false,
    val loadDiscrepancyRequiresApproval: Boolean = true, val walkInAllowed: Boolean = false,
    val loadDiscrepancyReasons: List<String> = emptyList(), val damageReasons: List<String> = emptyList())
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
    val sequence: Int?, val source: String, val reason: String? = null, val localOnly: Boolean = false)
data class TruckStock(val productId: String, val availableBase: Long, val damagedBase: Long)
/** A cached price-list line (minor currency units). Empty until the governed price feed exists (ADR-008). */
data class PriceLine(val priceListId: String, val productId: String, val uomCode: String, val unitPriceMinor: Long,
    val currency: String, val effectiveFrom: Long, val effectiveTo: Long?)
data class VanBootstrap(val serverTime: Long, val serviceDate: String, val seller: Seller, val policy: VanPolicy,
    val trip: Trip?, val load: Load?, val truckStock: List<TruckStock>, val products: List<Product>, val customers: List<Customer>)
data class LoadActual(val lineNumber: Int, val actualBase: Long, val reason: String? = null)
/** [savedSales]: VAN-011 sales committed on this phone whose office upload is not available yet (parked, never sent). */
data class SyncStatus(val queued: Int = 0, val sending: Int = 0, val review: Int = 0,
    val held: Int = 0, val lastSyncTime: Long? = null, val health: String = "never_synced", val savedSales: Int = 0)
/** A completed van sale as saved on this phone (VAN-011). Money is in minor units of [currency]. */
data class SaleReceiptLine(val lineNumber: Int, val productId: String, val name: String, val uomCode: String,
    val quantityLabel: String, val unitPriceMinor: Long, val totalMinor: Long)
data class SaleReceipt(val saleId: String, val receiptNumber: String, val customerName: String, val lines: List<SaleReceiptLine>,
    val currency: String, val totalMinor: Long, val tenderedMinor: Long, val changeMinor: Long, val createdAt: Long, val replay: Boolean = false)
data class PushAck(val entityId: String, val movementId: String?, val serverTime: Long)
data class PushResult(val kind: String, val clientRequestId: String, val status: String,
    val ack: PushAck? = null, val code: String? = null)
