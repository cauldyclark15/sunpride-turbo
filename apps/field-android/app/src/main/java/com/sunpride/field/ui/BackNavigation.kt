package com.sunpride.field.ui

/**
 * SP-0141: what the phone's Back key does on each screen. It mirrors the on-screen ‹ exactly
 * (photo/form/order → call sheet → visit → customer → customers → Today); only Today, sign-in,
 * the unlock prompt and the waiting-for-admin screen let Back leave the app.
 */
sealed interface BackStep {
    data object ClosePhoto : BackStep
    data object CloseActivityForm : BackStep
    data object CloseOrderReview : BackStep
    data object CloseOrder : BackStep
    data object CloseCallSheet : BackStep
    data object CloseVisit : BackStep
    data class ToPage(val page: String) : BackStep
    /** Leave the app (the system's own Back). */
    data object Exit : BackStep
}

/** The screen state Back depends on; matches the order in which FieldApp picks the visible screen. */
data class BackState(
    val locked: Boolean = false,
    val signedIn: Boolean = true,
    val ready: Boolean = true,
    val page: String = "home",
    val visitOpen: Boolean = false,
    val visitsEnabled: Boolean = true,
    val photoCaptureOpen: Boolean = false,
    val activityFormOpen: Boolean = false,
    val orderOpen: Boolean = false,
    val orderReview: Boolean = false,
    val callSheetOpen: Boolean = false,
)

object BackNavigation {
    fun step(s: BackState): BackStep = when {
        s.locked || !s.signedIn -> BackStep.Exit
        s.page == "account" || s.page == "sync" -> BackStep.ToPage("home")
        s.page == "support" -> BackStep.ToPage("account")
        s.ready && (s.page == "location-consent" || s.page == "location-background") -> BackStep.ToPage("home")
        s.visitOpen && s.visitsEnabled && s.ready -> when {
            s.photoCaptureOpen -> BackStep.ClosePhoto
            s.activityFormOpen -> BackStep.CloseActivityForm
            s.orderOpen && s.orderReview -> BackStep.CloseOrderReview
            s.orderOpen -> BackStep.CloseOrder
            s.callSheetOpen -> BackStep.CloseCallSheet
            else -> BackStep.CloseVisit
        }
        s.ready && s.page == "customer" -> BackStep.ToPage("customers")
        s.ready && (s.page == "route" || s.page == "customers" || s.page == "team") -> BackStep.ToPage("home")
        else -> BackStep.Exit
    }
}
