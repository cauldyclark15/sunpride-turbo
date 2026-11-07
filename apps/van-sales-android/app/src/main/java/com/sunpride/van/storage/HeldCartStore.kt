package com.sunpride.van.storage

import androidx.room.withTransaction
import com.sunpride.van.pos.HeldCart
import com.sunpride.van.pos.HeldCartRules
import com.sunpride.van.pos.HeldLine
import kotlinx.coroutines.flow.Flow
import java.util.UUID

/**
 * IP-HOLD: parked carts on the encrypted phone store. Nothing here is uploaded or counted as a sale; it survives an app restart
 * and belongs to this register or van only (the same subject and device scope as every other row).
 */
class HeldCartStore(private val store: RoomVanStore) {
    private val db = store.db
    private val dao = db.rows()
    private val s = store.scope.fullAuthSubject
    private val d = store.scope.deviceId

    fun count(surface: String): Flow<Int> = dao.observeHeldCount(s, d, surface)
    suspend fun countNow(surface: String): Int = dao.heldCount(s, d, surface)

    suspend fun list(surface: String): List<HeldCart> = dao.heldCarts(s, d, surface).map {
        HeldCart(it.holdId, it.surface, it.name, it.note, it.customerId, it.customerName, HeldCartRules.decode(it.linesJson), it.totalLabel, it.createdAt)
    }

    /** Parks the cart. A refusal (nothing in it, too many held) throws [IllegalStateException] with the words to show. */
    suspend fun hold(surface: String, name: String?, note: String?, customerId: String?, customerName: String?, lines: List<HeldLine>, totalLabel: String): HeldCart = db.withTransaction {
        val held = dao.heldCount(s, d, surface)
        HeldCartRules.problemHolding(lines, held)?.let { throw IllegalStateException(it) }
        val row = HeldCartRow(s, d, UUID.randomUUID().toString(), surface, HeldCartRules.displayName(name, held), HeldCartRules.cleanNote(note), customerId, customerName,
            HeldCartRules.encode(lines), totalLabel, maxOf(store.now(), 1L))
        dao.insertHeldCart(row)
        HeldCart(row.holdId, surface, row.name, row.note, customerId, customerName, lines, totalLabel, row.createdAt)
    }

    suspend fun discard(holdId: String) = dao.deleteHeldCart(s, d, holdId)
    suspend fun discardAll(surface: String) = dao.deleteHeldCarts(s, d, surface)
}
