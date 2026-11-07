package com.sunpride.van.selling

import org.junit.Assert.*
import org.junit.Test

/** IP-HH1 tap budget: the flow the screens run, driven as a finger would. */
class SellFlowTest {
    private fun run(vararg events: SellEvent): SellFlow = events.fold(SellFlow()) { s, e -> SellFlowReducer.reduce(s, e) }

    @Test fun exactNeverCompletesTheSale() {
        // Charge -> Exact: the screen stays on Payment, not saving, so a discount or a customer can still be added.
        val s = run(SellEvent.Scanned, SellEvent.ChargeTapped, SellEvent.ExactTapped)
        assertEquals(SellStep.PAYMENT, s.step)
        assertFalse(s.saving)
        assertEquals(2, s.taps)
    }

    @Test fun oneItemExactCashSaleIsFourTapsAfterTheScan() {
        // scan (not a tap) -> Charge -> Exact (fills Tendered only) -> Complete -> (sale saved) -> New sale
        val done = run(SellEvent.Scanned, SellEvent.ChargeTapped, SellEvent.ExactTapped, SellEvent.PayTapped, SellEvent.SaleSaved)
        assertEquals(SellStep.COMPLETE, done.step)
        val fresh = SellFlowReducer.reduce(done, SellEvent.NewSaleTapped)
        assertEquals(4, fresh.taps)
        assertEquals(SellStep.BROWSE, fresh.step)
    }

    @Test fun answeringDidItPrintAddsOneTap() {
        val s = run(SellEvent.Scanned, SellEvent.ChargeTapped, SellEvent.ExactTapped, SellEvent.PayTapped, SellEvent.SaleSaved, SellEvent.PrintAnswered, SellEvent.NewSaleTapped)
        assertEquals(5, s.taps)
    }

    @Test fun tenScansNeedNoExtraTapsPerItem() {
        val scans = Array<SellEvent>(10) { SellEvent.Scanned }
        val s = run(*scans, SellEvent.ChargeTapped, SellEvent.ExactTapped, SellEvent.PayTapped, SellEvent.SaleSaved, SellEvent.NewSaleTapped)
        assertEquals("same four closing taps as a one-item sale", 4, s.taps)
    }

    @Test fun aBillCostsTheSameTapsAsExact() {
        // Charge -> bill (fills Tendered, no save) -> Complete -> New sale; the bill tap is the same kind of tap as Exact.
        val s = run(SellEvent.Scanned, SellEvent.ChargeTapped, SellEvent.ExactTapped, SellEvent.PayTapped, SellEvent.SaleSaved, SellEvent.NewSaleTapped)
        assertEquals(4, s.taps)
    }

    @Test fun exactWhileSavingIsIgnored() {
        val s = run(SellEvent.ChargeTapped, SellEvent.PayTapped, SellEvent.ExactTapped)
        assertTrue(s.saving); assertEquals(2, s.taps)
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
