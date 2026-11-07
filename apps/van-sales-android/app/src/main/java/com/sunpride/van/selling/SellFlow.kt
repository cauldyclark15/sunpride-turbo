package com.sunpride.van.selling

/** The four places a sale passes through. */
enum class SellStep { BROWSE, CART, PAYMENT, COMPLETE }

sealed interface SellEvent {
    /** A hardware scan: not a tap. */
    data object Scanned : SellEvent
    data object GridTapped : SellEvent
    data object SearchRowTapped : SellEvent
    data object CartBarTapped : SellEvent
    /** Charge on the cart bar or at the foot of the cart. */
    data object ChargeTapped : SellEvent
    /** EXACT: fills Tendered with the total (like a quick-cash bill). It is a tap, but it never saves the sale. */
    data object ExactTapped : SellEvent
    /** The big Complete button: the only thing that starts saving. */
    data object PayTapped : SellEvent
    data object SaleSaved : SellEvent
    data object SaveFailed : SellEvent
    /** "Yes, printed" / "Print again" / "Skip" on the Phase 0 sheet. */
    data object PrintAnswered : SellEvent
    data object BackTapped : SellEvent
    data object NewSaleTapped : SellEvent
}

/** [taps] counts only events a finger makes, so the tap budget of a sale can be asserted in a unit test. */
data class SellFlow(val step: SellStep = SellStep.BROWSE, val saving: Boolean = false, val taps: Int = 0, val cameFromCart: Boolean = false)

object SellFlowReducer {
    fun reduce(s: SellFlow, e: SellEvent): SellFlow = when (e) {
        SellEvent.Scanned -> s
        SellEvent.GridTapped, SellEvent.SearchRowTapped -> s.tap()
        SellEvent.CartBarTapped -> if (s.step == SellStep.BROWSE) s.tap().copy(step = SellStep.CART) else s
        SellEvent.ChargeTapped -> if (s.step == SellStep.BROWSE || s.step == SellStep.CART) s.tap().copy(step = SellStep.PAYMENT, cameFromCart = s.step == SellStep.CART) else s
        SellEvent.ExactTapped -> if (s.step == SellStep.PAYMENT && !s.saving) s.tap() else s
        SellEvent.PayTapped -> if (s.step == SellStep.PAYMENT && !s.saving) s.tap().copy(saving = true) else s
        SellEvent.SaleSaved -> if (s.step == SellStep.PAYMENT) s.copy(step = SellStep.COMPLETE, saving = false) else s
        SellEvent.SaveFailed -> s.copy(saving = false)
        SellEvent.PrintAnswered -> s.tap()
        SellEvent.BackTapped -> when (s.step) {
            SellStep.CART -> s.tap().copy(step = SellStep.BROWSE)
            SellStep.PAYMENT -> if (s.saving) s else s.tap().copy(step = if (s.cameFromCart) SellStep.CART else SellStep.BROWSE)
            else -> s
        }
        SellEvent.NewSaleTapped -> if (s.step == SellStep.COMPLETE) SellFlow(taps = s.taps + 1) else s
    }
    private fun SellFlow.tap() = copy(taps = taps + 1)
}
