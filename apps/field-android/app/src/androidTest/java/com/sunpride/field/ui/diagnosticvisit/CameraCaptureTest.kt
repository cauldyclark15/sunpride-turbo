package com.sunpride.field.ui.diagnosticvisit

import android.Manifest
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.field.auth.EnrollmentState
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.KeystoreDeviceKey
import com.sunpride.field.storage.EvidencePhotos
import com.sunpride.field.storage.IntentRow
import com.sunpride.field.storage.StoreScope
import com.sunpride.field.ui.FieldBackend
import com.sunpride.field.ui.FieldController
import com.sunpride.field.ui.VisitDisplay
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * AND-016 on a real camera stack: CameraX binds the back camera, takes a still into memory and hands
 * the controller a JPEG. Emulator only (the camera permission is granted to the test package here).
 */
class CameraCaptureTest {
    @get:Rule val rule = createAndroidComposeRule<androidx.activity.ComponentActivity>()
    private val alias = "camera-capture-test"
    private val identity = StoreScope("test|camera", "device", "scope")
    private val start: IntentRow = VisitIntentFactory.create(identity, "visit.checkIn", null, null, null, null,
        "outlet-1", listOf("sell"), "walk-in", null, null, null, null)
    @Volatile private var captured: Pair<String, ByteArray>? = null
    private inner class Backend : FieldBackend {
        override val isSignedIn = true
        override val cachedDeviceId = identity.deviceId
        override fun loadSigner(): DeviceSigner = KeystoreDeviceKey.loadOrCreate(rule.activity, alias)
        override fun signIn(email: String, password: String) = Unit
        override fun signOut() = Unit
        override fun refreshEnrollment(signer: DeviceSigner) = EnrollmentState.Ready(identity.deviceId)
        override fun visitStates() = listOf(start to "pending")
        override fun savePhoto(clientVisitId: String, checkInRequestId: String, outletId: String, photoType: String,
            jpeg: ByteArray, capturedAt: Long) {
            assertEquals(start.clientVisitId, clientVisitId); assertEquals(start.requestId, checkInRequestId)
            captured = photoType to jpeg
        }
    }
    @After fun cleanup() { KeystoreDeviceKey.delete(alias) }

    @Test fun backCameraTakesAJpegIntoMemory() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.grantRuntimePermission(instrumentation.targetContext.packageName, Manifest.permission.CAMERA)
        val controller = FieldController(Backend(), MainScope())
        runBlocking { controller.openDiagnostic(VisitDisplay("Outlet", "Unplanned", "Reason required", "outlet-1")).join() }
        rule.setContent { PhotoCaptureScreen(controller) }
        rule.onNodeWithTag("photo-type-storefront").performScrollTo().performClick()
        // Enabled only once CameraX has bound the preview and still capture.
        rule.waitUntil(20_000) { runCatching { rule.onNodeWithTag("photo-take").assertIsEnabled() }.isSuccess }
        rule.onNodeWithTag("photo-take").performClick()
        rule.waitUntil(20_000) { captured != null }
        val (type, jpeg) = captured!!
        assertEquals("storefront", type)
        assertTrue(EvidencePhotos.isJpeg(jpeg))
        assertTrue("${jpeg.size} bytes", jpeg.size in 1_000..EvidencePhotos.MAX_BYTES.toInt())
    }
}
