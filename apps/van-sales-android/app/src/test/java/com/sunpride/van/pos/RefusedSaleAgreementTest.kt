package com.sunpride.van.pos

import com.sunpride.van.auth.AuthFailure
import com.sunpride.van.data.PaymentKind
import com.sunpride.van.data.TruckStock
import com.sunpride.van.ledger.StockProjection
import com.sunpride.van.storage.BaselineRow
import com.sunpride.van.storage.MovementRow
import com.sunpride.van.storage.OutboxRow
import com.sunpride.van.storage.OutboxRules
import com.sunpride.van.sync.VanSyncClient
import com.sunpride.van.ui.VanRules
import org.junit.Assert.*
import org.junit.Test

/**
 * r6van4 (SP-0169 VAN-074/075/078/082/083/086): a sale the office refused is spoiled; the phone must then agree with
 * the office about cash and truck stock, never sell held batches, and say what to do in plain words.
 */
class RefusedSaleAgreementTest {
    private val v2 = "v2|https://office.example|seller"
    private fun pay(id: String, amount: Long, refused: Boolean = false, voided: Boolean = false) =
        TripPayment(id, "SI-$id", "cash", "Cash", PaymentKind.CASH, amount, "PHP", voided, refused)
    private fun op(id: String, status: String) = OutboxRow(v2, "dev", id, "trip", "sale.record", "{}", 1L, status = status)
    private fun sale(id: String, product: String, qty: Long) =
        MovementRow(v2, "dev", "$id:$product", "trip", product, "SALE", "available", -qty, null, id, 2L)

    @Test fun refusedSaleIsLeftOutOfExpectedCashLikeTheOffice() {
        // VAN-074: office = 16,080.53; the phone counted the refused SI-000000005 (₱210.72) on top.
        val e = CashReconciliationRules.expectation(listOf(pay("1", 1_608_053L), pay("5", 21_072L, refused = true)))
        assertEquals(1_608_053L, e.expectedMinor)
        assertEquals(1, e.cashSales)
        assertEquals(0, e.voidedSales)
        assertEquals(1, e.refusedSales)
        assertEquals(21_072L, e.refusedMinor)
    }

    @Test fun refusedSaleStockIsBackOnTheTruck() {
        // VAN-078: the refused sale's deduction never happened at the office.
        val rows = listOf(op("ok", "done"), op("refused", "rejected"), op("waiting", "pending"))
        val refused = OutboxRules.refused(v2, rows)
        assertEquals(setOf("refused"), refused)
        val baseline = listOf(BaselineRow(v2, "dev", "trip", "sardines", "available", 200L, 1L))
        val moves = listOf(sale("refused", "sardines", 2L), sale("waiting", "sardines", 1L))
        assertEquals(197L, StockProjection.project(baseline, moves, emptySet()).single().availableBase)
        assertEquals(199L, StockProjection.project(baseline, StockProjection.withoutRefused(moves, refused), emptySet()).single().availableBase)
        // Older (v1) scopes keep their previous rule.
        assertEquals(emptySet<String>(), OutboxRules.refused("https://office.example|seller", rows))
    }

    @Test fun heldBatchesCannotBeSold() {
        // SI-000000005: every Sardines 155g on the truck was a quarantined batch the office will not let leave.
        val trip = """{"tripId":"t","heldStock":[{"productId":"sardines","quantityBase":"200"},{"productId":"vienna","quantityBase":"10"}]}"""
        val held = HeldStock.decode(trip)
        assertEquals(mapOf("sardines" to 200L, "vienna" to 10L), held)
        val stock = listOf(TruckStock("sardines", 200L, 0L), TruckStock("vienna", 96L, 0L), TruckStock("beef", 20L, 0L))
        val sellable = HeldStock.sellable(stock, held).associate { it.productId to it.availableBase }
        assertEquals(mapOf("sardines" to 0L, "vienna" to 86L, "beef" to 20L), sellable)
        assertEquals(emptyMap<String, Long>(), HeldStock.decode("""{"tripId":"t"}"""))
        assertEquals(emptyMap<String, Long>(), HeldStock.decode("""{"heldStock":[{"productId":"x","quantityBase":"-1"}]}"""))
    }

    @Test fun refusedReceiptMessageSaysWhatToDoWithCashAndGoods() {
        val m = com.sunpride.van.selling.RefusedReceipt.message("SAMPLE-SMP-VAN-1-SI-000000005", "sale.record")
        assertTrue(m.contains("SI-000000005") && m.contains("spoiled"))
        assertTrue(m.contains("back in your truck stock") && m.contains("left out of your expected cash"))
        assertTrue(m.contains("give back their money") && m.contains("ring the sale again"))
    }

    @Test fun closeWithoutTheTickSaysWhatToDo() {
        // VAN-082: everything else ready, exceptions not ticked: the tap explains instead of doing nothing.
        assertEquals("Check the items below and tick the box before closing.", VanRules.closeTapMessage(true, true, false))
        assertNull(VanRules.closeTapMessage(true, true, true))
        assertNull(VanRules.closeTapMessage(false, true, false))
        assertNull(VanRules.closeTapMessage(true, false, false))
    }

    @Test fun pausedPhoneIsToldItIsPausedNotSignedOut() {
        // VAN-086: the office's refusal for a suspended phone.
        val body = """{"version":2,"serverTime":1,"error":{"code":"device_suspended","retryable":false,"action":"hold"}}"""
        assertTrue(AuthFailure.paused(body))
        assertFalse(AuthFailure.paused("""{"version":2,"error":{"code":"session_invalid"}}"""))
        assertFalse(AuthFailure.paused("not json"))
        assertEquals("This phone is paused. Ask your administrator.", AuthFailure.Kind.PAUSED.message)
        assertEquals("device_suspended", VanSyncClient.error(403, body).code)
        assertEquals("unauthorized", VanSyncClient.error(403, """{"version":2,"error":{"code":"forbidden"}}""").code)
    }
}
