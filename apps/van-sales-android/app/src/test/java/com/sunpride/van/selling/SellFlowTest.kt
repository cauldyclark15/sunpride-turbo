package com.sunpride.van.selling

import org.junit.Assert.*
import org.junit.Test

/** IP-HH1 tap budget: the flow the screens run, driven as a finger would. */
class SellFlowTest {
    private fun run(vararg events: SellEvent): SellFlow = events.fold(SellFlow()) { s, e -> SellFlowReducer.reduce(s, e) }

    @Test fun oneItemExactCashSaleIsThreeTapsAfterTheScan() {
        // scan (not a tap) -> Charge -> Exact -> (sale saved) -> New sale
        val done = run(SellEvent.Scanned, SellEvent.ChargeTapped, SellEvent.PayTapped, SellEvent.SaleSaved)
        assertEquals(SellStep.COMPLETE, done.step)
        val fresh = SellFlowReducer.reduce(done, SellEvent.NewSaleTapped)
        assertEquals(3, fresh.taps)
        assertEquals(SellStep.BROWSE, fresh.step)
    }

    @Test fun answeringDidItPrintStillFitsTheFourTapBudget() {
        val s = run(SellEvent.Scanned, SellEvent.ChargeTapped, SellEvent.PayTapped, SellEvent.SaleSaved, SellEvent.PrintAnswered, SellEvent.NewSaleTapped)
        assertEquals(4, s.taps)
    }

    @Test fun tenScansNeedNoExtraTapsPerItem() {
        val scans = Array<SellEvent>(10) { SellEvent.Scanned }
        val s = run(*scans, SellEvent.ChargeTapped, SellEvent.PayTapped, SellEvent.SaleSaved, SellEvent.NewSaleTapped)
        assertEquals("same three closing taps as a one-item sale", 3, s.taps)
    }

    @Test fun aBillInsteadOfExactCostsOneMoreTap() {
        // Charge -> $100 (fills Tendered, no save) -> Complete -> New sale
        val s = run(SellEvent.Scanned, SellEvent.ChargeTapped, SellEvent.PayTapped, SellEvent.SaleSaved, SellEvent.NewSaleTapped)
        assertEquals(3, s.taps) // the bill tap is a tender edit, the Complete tap is the PayTapped above
    }

    @Test fun viewingTheCartFirstAddsTheCartTapOnly() {
        val s = run(SellEvent.Scanned, SellEvent.CartBarTapped, SellEvent.ChargeTapped, SellEvent.PayTapped, SellEvent.SaleSaved, SellEvent.NewSaleTapped)
        assertEquals(4, s.taps)
    }

    @Test fun payingTwiceWhileSavingIsIgnored() {
        val s = run(SellEvent.ChargeTapped, SellEvent.PayTapped, SellEvent.PayTapped)
        assertTrue(s.saving); assertEquals(2, s.taps)
    }

    @Test fun aFailedSaveLeavesYouOnPaymentToTryAgain() {
        val s = run(SellEvent.ChargeTapped, SellEvent.PayTapped, SellEvent.SaveFailed)
        assertEquals(SellStep.PAYMENT, s.step); assertFalse(s.saving)
        assertEquals(SellStep.COMPLETE, SellFlowReducer.reduce(SellFlowReducer.reduce(s, SellEvent.PayTapped), SellEvent.SaleSaved).step)
    }

    @Test fun backFromPaymentReturnsToWhereYouCameFrom() {
        assertEquals(SellStep.BROWSE, run(SellEvent.ChargeTapped, SellEvent.BackTapped).step)
        assertEquals(SellStep.CART, run(SellEvent.CartBarTapped, SellEvent.ChargeTapped, SellEvent.BackTapped).step)
        assertEquals("cannot back out while saving", SellStep.PAYMENT, run(SellEvent.ChargeTapped, SellEvent.PayTapped, SellEvent.BackTapped).step)
    }

    @Test fun newSaleStartsAnEmptyBrowseState() {
        val s = run(SellEvent.ChargeTapped, SellEvent.PayTapped, SellEvent.SaleSaved, SellEvent.NewSaleTapped)
        assertEquals(SellStep.BROWSE, s.step); assertFalse(s.saving); assertFalse(s.cameFromCart)
    }
}
