package com.sunpride.van.ledger

import com.sunpride.van.data.TruckStock
import com.sunpride.van.storage.*

enum class MovementType { LOAD, SALE, RETURN, DAMAGE, TRANSFER, ADJUSTMENT }
enum class StockStatus { available, damaged }

/** Math is shared by Room reads and JVM tests; overflow refuses instead of wrapping stock. */
object StockProjection {
    fun project(baseline: List<BaselineRow>, movements: List<MovementRow>, settled: Set<String>): List<TruckStock> {
        val amounts = linkedMapOf<Pair<String,String>,Long>()
        baseline.forEach { require(it.stockStatus in setOf("available","damaged")); amounts[it.productId to it.stockStatus] = it.quantityBase }
        movements.filter { it.movementId !in settled }.forEach { m ->
            require(m.type in MovementType.entries.map { it.name } && m.stockStatus in setOf("available","damaged"))
            val key = m.productId to m.stockStatus
            amounts[key] = Math.addExact(amounts[key] ?: 0L,m.quantityBase)
        }
        return amounts.keys.map { it.first }.distinct().sorted().map { id -> TruckStock(id,amounts[id to "available"] ?: 0L,amounts[id to "damaged"] ?: 0L) }
    }
    fun reflected(ackServerTime: Long?, baselineServerTime: Long): Boolean = ackServerTime != null && baselineServerTime > ackServerTime
    fun canRemove(available: Long, quantity: Long, allowNegativeStock: Boolean): Boolean = quantity > 0 && (allowNegativeStock || available >= quantity)
}

class TruckStockLedger(private val store: RoomVanStore, private val afterEnqueue: () -> Unit = {}) {
    suspend fun projection(): List<TruckStock> = store.stock()
    suspend fun canRemove(productId: String, qty: Long): Boolean = store.canRemove(productId,qty)
    /** Local sale/return/transfer/adjustment hook for later lanes; no unsupported gateway op is fabricated. */
    suspend fun recordLocalMovement(type: MovementType, productId: String, stockStatus: StockStatus,
        quantityBase: Long, reason: String?, clientRequestId: String): String =
        store.recordLocalMovement(type,productId,stockStatus,quantityBase,reason,clientRequestId)
    /** Available → damaged transfer plus immutable operation bytes in ONE Room transaction. */
    suspend fun recordDamage(productId: String, qty: Long, reason: String, note: String? = null): String {
        val id = store.recordDamage(productId,qty,reason,note)
        afterEnqueue()
        return id
    }
}
