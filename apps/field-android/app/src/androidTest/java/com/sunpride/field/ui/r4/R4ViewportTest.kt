package com.sunpride.field.ui.r4

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.dp
import com.sunpride.field.auth.EnrollmentState
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.KeystoreDeviceKey
import com.sunpride.field.storage.CallSheet
import com.sunpride.field.storage.CallSheetHeader
import com.sunpride.field.storage.CallSheetProduct
import com.sunpride.field.storage.IntentRow
import com.sunpride.field.storage.StoreScope
import com.sunpride.field.ui.FieldBackend
import com.sunpride.field.ui.FieldController
import com.sunpride.field.ui.VisitDisplay
import com.sunpride.field.ui.diagnosticvisit.PhotoCameraSeam
import com.sunpride.field.ui.diagnosticvisit.PhotoCaptureScreen
import com.sunpride.field.ui.diagnosticvisit.VisitIntentFactory
import com.sunpride.field.ui.orders.OrderDraftScreen
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Rule
import org.junit.Test

/**
 * Round-4 phone failures that were "not on screen" rather than "not in the tree". Each screen is drawn in the
 * space it really gets on the 360 dp wide REDMI A7 Pro, so assertIsDisplayed means the person can read it.
 */
class R4ViewportTest {
    @get:Rule val rule = createAndroidComposeRule<androidx.activity.ComponentActivity>()
    private val alias = "r4-viewport-test"
    private val identity = StoreScope("test|r4", "device", "scope")
    private val start: IntentRow = VisitIntentFactory.create(identity, "visit.checkIn", null, null, null, null,
        "outlet-1", listOf("sell"), "walk-in", null, null, null, null)
    private inner class Backend : FieldBackend {
        override val isSignedIn = true
        override val cachedDeviceId = identity.deviceId
        override fun loadSigner(): DeviceSigner = KeystoreDeviceKey.loadOrCreate(rule.activity, alias)
        override fun signIn(email: String, password: String) = Unit
        override fun signOut() = Unit
        override fun refreshEnrollment(signer: DeviceSigner) = EnrollmentState.Ready(identity.deviceId)
        override fun visitStates() = listOf(start to "pending")
    }
    private fun controller() = FieldController(Backend(), MainScope()).also { c ->
        runBlocking { c.openDiagnostic(VisitDisplay("Outlet", "Unplanned", "Reason required", "outlet-1")).join() }
    }
    private fun shot(name: String) {
        val bmp = rule.onRoot().captureToImage().asAndroidBitmap()
        java.io.File(rule.activity.getExternalFilesDir(null), "$name.png").outputStream().use {
            bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
    }
    @After fun cleanup() { PhotoCameraSeam.denied = false; KeystoreDeviceKey.delete(alias) }

    /** FLD-099: after "Don't allow" the reason sits next to the Allow camera button, not below the fold. */
    @Test fun cameraDeniedSentenceIsOnScreen() {
        PhotoCameraSeam.denied = true
        val c = controller()
        // The visit body under the red header and sync pill on the REDMI: 360 x 615 dp.
        rule.setContent { Box(Modifier.size(360.dp, 615.dp)) { PhotoCaptureScreen(c) } }
        rule.onNodeWithTag("photo-type-storefront").performClick()
        rule.waitForIdle()
        shot("FLD-099-denied")
        rule.onNodeWithTag("camera-permission").assertIsDisplayed()
            .assertTextContains("Camera access is off. Allow it in Settings to take visit photos.")
        rule.onNodeWithTag("photo-take").assertTextContains("Allow camera")
    }

    /** FLD-112: with the keyboard up the order list is about 255 dp tall; typing must bring results (or No match) into view. */
    @Test fun orderSearchResultsAreOnScreenWithTheKeyboardUp() {
        val products = (1..40).map { CallSheetProduct("p$it", "SMP-P${100 + it}", "Sample product $it", "PC", null, null) } +
            CallSheetProduct("pch", "SMP-PCH-227", "Sunpride Pineapple Chunks 227g", "CAN", null, null)
        val sheet = CallSheet("outlet-1", 1, CallSheetHeader("Account", null, null, null, null, null, null, null, null, null), products)
        val c = controller()
        val visit = VisitDisplay("Outlet", "Unplanned", "Reason required", "outlet-1")
        // Full window like the app: 145 dp of red header and sync pill above, the real soft keyboard below.
        rule.setContent { androidx.compose.foundation.layout.Column(Modifier.fillMaxSize()) {
            androidx.compose.foundation.layout.Spacer(Modifier.height(145.dp))
            OrderDraftScreen(visit, sheet, c, Modifier.weight(1f))
        } }
        rule.onNodeWithTag("order-search").performTextInput("pch")
        rule.waitForIdle()
        shot("FLD-112-pch")
        rule.onNodeWithText("Sunpride Pineapple Chunks 227g").assertIsDisplayed()
        rule.onNodeWithTag("order-search").performTextClearance()
        rule.onNodeWithTag("order-search").performTextInput("pine")
        rule.waitForIdle()
        rule.onNodeWithText("Sunpride Pineapple Chunks 227g").assertIsDisplayed()
        rule.onNodeWithTag("order-search").performTextClearance()
        rule.onNodeWithTag("order-search").performTextInput("zzz")
        rule.waitForIdle()
        shot("FLD-112-zzz")
        rule.onNodeWithText("No products match").assertIsDisplayed()
        rule.onNodeWithTag("order-search").performTextClearance()
        rule.waitForIdle()
        rule.onNodeWithTag("order-count").assertTextContains("0 of 41 products in this order")
    }
}
