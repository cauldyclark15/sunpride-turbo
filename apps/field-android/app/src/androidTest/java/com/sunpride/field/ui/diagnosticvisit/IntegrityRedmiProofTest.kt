package com.sunpride.field.ui.diagnosticvisit

import android.graphics.Bitmap
import android.location.Criteria
import android.location.Location
import android.location.LocationManager
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.field.AppEnvironment
import com.sunpride.field.auth.*
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.KeystoreDeviceKey
import com.sunpride.field.ui.*
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import java.io.File

/** F-007/F-024 opt-in real Redmi proof; private assets contain only a throwaway local SAMPLE account. */
class IntegrityRedmiProofTest {
    @get:Rule val rule = createAndroidComposeRule<androidx.activity.ComponentActivity>()
    private val context get() = rule.activity
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private fun fixture(): JSONObject {
        val assets=instrumentation.context.assets
        assumeTrue("Explicit local integrity proof assets required", assets.list("")!!.contains("integrity-field-proof.json"))
        return JSONObject(assets.open("integrity-field-proof.json").bufferedReader().use { it.readText() }).also {
            check(it.getString("apiOrigin")=="http://127.0.0.1:4500")
            check(it.getString("email").startsWith("integrity-field-") && it.getString("email").endsWith("@sample.sunpride.test"))
            check(context.packageName=="com.sunpride.field.dev")
        }
    }
    private fun shell(command: String): String = ParcelFileDescriptor.AutoCloseInputStream(
        instrumentation.uiAutomation.executeShellCommand(command)).bufferedReader().use { it.readText() }
    private fun output(name: String,text: String) = File(context.getExternalFilesDir(null),name).writeText(text)

    @Suppress("DEPRECATION")
    @Test fun F024_realOsMockProviderRefusesStartAndIsRemoved() {
        fixture()
        val manager=context.getSystemService(LocationManager::class.java)
        check(manager.isLocationEnabled) { "Physical proof needs enabled phone location" }
        val provider="sunpride_integrity_proof"
        check(provider !in manager.allProviders) { "Another proof owns the provider" }
        val before=shell("appops get ${context.packageName} android:mock_location")
        val mode=Regex("(?:MOCK_LOCATION|android:mock_location): (allow|ignore|deny|default)").find(before)?.groupValues?.get(1) ?: "default"
        check(mode!="allow") { "Another operation already enabled mock location" }
        var added=false
        val visit=VisitDisplay("SAMPLE integrity proof outlet","Planned","Scheduled","sample-outlet","sample-plan")
        var queued=0
        val backend=object : FieldBackend {
            override val isSignedIn=true
            override val cachedDeviceId="sample-device"
            override fun loadSigner(): DeviceSigner = KeystoreDeviceKey.loadOrCreate(context,"integrity-mock-ui")
            override fun signIn(email: String,password: String)=Unit
            override fun signOut()=Unit
            override fun refreshEnrollment(signer: DeviceSigner)=EnrollmentState.Ready("sample-device")
            override fun today(deviceId: String,signer: DeviceSigner,sync: Boolean)=TodayData(listOf(visit),stale=false,queuedCount=0)
            override fun queueVisit(kind: String,clientVisitId: String?,checkInRequestId: String?,previousRequestId: String?,
                plannedVisitId: String?,outletId: String,intents: List<String>,unplannedReason: String?,note: String?,
                outcome: String?,reasonCode: String?,location: JSONObject?) { queued++ }
        }
        try {
            shell("appops set ${context.packageName} android:mock_location allow")
            // A unique provider, never GPS/network/fused: other apps' real route sources stay untouched.
            manager.addTestProvider(provider,false,false,false,false,false,false,false,Criteria.POWER_LOW,Criteria.ACCURACY_FINE)
            added=true;manager.setTestProviderEnabled(provider,true)
            manager.setTestProviderLocation(provider,Location(provider).apply {
                latitude=10.33;longitude=123.94;accuracy=5f;time=System.currentTimeMillis()
                elapsedRealtimeNanos=SystemClock.elapsedRealtimeNanos()
            })
            rule.waitUntil(10_000) { manager.getLastKnownLocation(provider)?.let { com.sunpride.integrity.DeviceIntegrity.mock(it) }==true }
            val capture=runBlocking { AndroidVisitLocation(context).capture() }
            assertTrue((capture as? LocationCapture.Captured)?.fix?.mockSignal==true)
            rule.setContent { FieldApp(AppEnvironment("http://127.0.0.1:4500"),dark=false,debug=true,
                backend=backend,visitLocation=AndroidVisitLocation(context)) }
            rule.waitUntil(10_000) { rule.onAllNodesWithTag("diagnostic-open").fetchSemanticsNodes().isNotEmpty() }
            rule.onNodeWithTag("diagnostic-open").performScrollTo().performClick()
            rule.waitUntil(10_000) { runCatching { rule.onNodeWithTag("diagnostic-checkin").assertIsEnabled() }.isSuccess }
            rule.onNodeWithTag("diagnostic-checkin").performClick()
            rule.waitUntil(10_000) { runCatching { rule.onNodeWithTag("location-review").assertTextContains("Check-in refused. Turn off mock location and try again.") }.isSuccess }
            rule.onNodeWithTag("location-review").performScrollTo().assertIsDisplayed()
            assertEquals(0,queued)
            rule.waitForIdle()
            val image=checkNotNull(instrumentation.uiAutomation.takeScreenshot())
            File(context.getExternalFilesDir(null),"F024-mock-refused.png").outputStream().use { image.compress(Bitmap.CompressFormat.PNG,100,it) }
        } finally {
            try { if(added) manager.removeTestProvider(provider) }
            finally { shell("appops set ${context.packageName} android:mock_location $mode");KeystoreDeviceKey.delete("integrity-mock-ui") }
        }
        assertFalse(provider in manager.allProviders)
        assertFalse(shell("appops get ${context.packageName} android:mock_location").contains("MOCK_LOCATION: allow"))
        output("F024-mock-proof.json",JSONObject().put("realOsMock",true).put("uiRefused",true).put("queued",queued)
            .put("providerRemoved",true).put("mockOpRestored",mode).put("transport","stub; refusal occurs before enqueue/network").toString())
    }

    @Test fun F007_secondRealKeystoreIdentityRequiresHandoverOnRealApi() {
        val config=fixture();val environment=AppEnvironment(config.getString("apiOrigin"))
        val first=KeystoreDeviceKey.loadOrCreate(context,"integrity-live-first")
        val second=KeystoreDeviceKey.loadOrCreate(context,"integrity-live-second")
        val vault1=KeystoreSessionVault(context,"integrity-live-session1","integrity-live-aes1")
        val vault2=KeystoreSessionVault(context,"integrity-live-session2","integrity-live-aes2")
        val auth1=AuthClient(environment,vault1,signer={first})
        val auth2=AuthClient(environment,vault2,signer={second})
        try {
            auth1.signIn(config.getString("email"),config.getString("password"))
            val functions1=ServerFunctions(environment,auth1).apply { signer={first} }
            val state=Enrollment(ServerDeviceApi(functions1),first,vault1).refresh()
            assertTrue(state is EnrollmentState.Ready)
            val id=(state as EnrollmentState.Ready).deviceId
            auth2.signIn(config.getString("email"),config.getString("password"))
            val functions2=ServerFunctions(environment,auth2).apply { signer={second} }
            assertTrue(functions2.api.me().getBoolean("handoverRequired"))
            try { ServerDeviceApi(functions2).mine(second.publicKeyBase64);fail("Second registration must require controlled handover") }
            catch(error: ServerError) { assertEquals("device_handover_required",error.code) }
            assertEquals(id,functions1.api.me().getJSONObject("device").getString("id"))
            output("F007-second-key-proof.json",JSONObject().put("firstBound",true).put("secondRequiresHandover",true)
                .put("originalRegistrationUnchanged",true).put("mode","real native API and two Android Keystore identities on one physical Redmi; not two physical phones").toString())
        } finally {
            runCatching { auth1.signOut() };runCatching { auth2.signOut() }
            for(alias in listOf("integrity-live-first","integrity-live-second","integrity-live-aes1","integrity-live-aes2")) KeystoreDeviceKey.delete(alias)
        }
    }
}
