package com.sunpride.van.device

import android.os.Build
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.van.data.VanRepository
import com.sunpride.van.auth.EnrollmentState
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.first
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/** Explicit opt-in only; never prints or changes a business record during the ordinary suite. */
class V2HandheldProofTest {
    @Test fun exportRegistrationPublicKey() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("v2Proof") == "key")
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val key=KeystoreDeviceKey.loadOrCreate(context)
        File(context.getExternalFilesDir(null),"v2-registration.json").writeText(JSONObject()
            .put("publicKeySpki",key.publicKeyBase64).put("keyId",hex(sha256(key.publicKeySpki))).toString())
        assertEquals(64,hex(sha256(key.publicKeySpki)).length)
    }
    @Test fun androidMockProviderFixReachesRealSync()=runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("v2Proof") == "location")
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val repo=VanRepository.create(context)
        val manager=context.getSystemService(android.content.Context.LOCATION_SERVICE) as android.location.LocationManager
        val received=kotlinx.coroutines.CompletableDeferred<android.location.Location>()
        val listener=android.location.LocationListener { received.complete(it) }
        var providerAdded=false
        var visible: androidx.test.core.app.ActivityScenario<com.sunpride.van.MainActivity>?=null
        var db: com.sunpride.van.storage.VanDatabase?=null
        try {
            repo.restoreSession(); assertTrue(repo.sessionState.value.signedIn); repo.syncNow()
            val scope=checkNotNull(repo.storeScope.first())
            db=com.sunpride.van.storage.EncryptedVanDatabase.open(context)
            val store=com.sunpride.van.storage.LocationPingStore(db,scope)
            assertTrue("A real active sample trip is required",store.onRoad())
            // Instrumentation without an Activity is background-restricted on Android 14. Keep the real
            // app visible; stop its competing listener only during this isolated provider→store proof.
            visible=androidx.test.core.app.ActivityScenario.launch(com.sunpride.van.MainActivity::class.java)
            val activities=context.getSystemService(android.content.Context.ACTIVITY_SERVICE) as android.app.ActivityManager
            @Suppress("DEPRECATION")
            kotlinx.coroutines.withTimeout(15_000) {
                while (activities.getRunningServices(20).none { it.service.className==com.sunpride.van.location.TripLocationService::class.java.name && it.foreground }) kotlinx.coroutines.delay(100)
            }
            context.stopService(android.content.Intent(context,com.sunpride.van.location.TripLocationService::class.java))
            kotlinx.coroutines.withTimeout(5_000) {
                while (activities.getRunningServices(20).any { it.service.className==com.sunpride.van.location.TripLocationService::class.java.name }) kotlinx.coroutines.delay(50)
            }
            @Suppress("DEPRECATION")
            manager.addTestProvider(android.location.LocationManager.GPS_PROVIDER,false,false,false,false,true,true,true,3,1)
            providerAdded=true
            manager.setTestProviderEnabled(android.location.LocationManager.GPS_PROVIDER,true)
            manager.requestLocationUpdates(android.location.LocationManager.GPS_PROVIDER,0,0f,listener,android.os.Looper.getMainLooper())
            val fix=android.location.Location(android.location.LocationManager.GPS_PROVIDER).apply {
                latitude=10.3157; longitude=123.8854; accuracy=5f; time=System.currentTimeMillis(); elapsedRealtimeNanos=android.os.SystemClock.elapsedRealtimeNanos()
            }
            manager.setTestProviderLocation(android.location.LocationManager.GPS_PROVIDER,fix)
            val platform=kotlinx.coroutines.withTimeout(15_000) { received.await() }
            assertTrue("Must be Android's marked mock fix, not a fabricated wire ping",platform.isMock)
            val converted=checkNotNull(com.sunpride.van.location.TripLocationService.toFix(platform))
            val outcome=store.record(converted,80)
            assertTrue(outcome is com.sunpride.van.storage.LocationPingStore.Outcome.Recorded)
            val ping=(outcome as com.sunpride.van.storage.LocationPingStore.Outcome.Recorded).clientPingId
            repo.syncNow()
            assertTrue(store.pending().none { it.clientPingId==ping })
            assertNull("A server refusal is not a successful upload",db.rows().locationPingRows(scope.fullAuthSubject,scope.deviceId).firstOrNull { it.clientPingId==ping })
            File(context.getExternalFilesDir(null),"v2-location-proof.json").writeText(JSONObject().put("clientOpId",ping).put("mockLocation",true).put("provider","gps").toString())
        } finally {
            manager.removeUpdates(listener)
            if (providerAdded) manager.removeTestProvider(android.location.LocationManager.GPS_PROVIDER)
            visible?.close(); db?.close(); repo.close()
        }; Unit
    }
    @Test fun signedInRealServerBootstrapRetainsAuthoritativeTrip()=runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("v2Proof") == "bootstrap")
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val repo=VanRepository.create(context)
        try {
            repo.restoreSession(); assertTrue(repo.sessionState.value.signedIn)
            assertTrue(repo.enrollmentState.value is EnrollmentState.Ready)
            repo.syncNow()
            val trip=checkNotNull(repo.currentTrip.first())
            assertTrue(trip.tripNumber.startsWith("TRIP-") || trip.tripNumber.startsWith("SMP-"))
            assertTrue(repo.products.first().isNotEmpty())
            val status=repo.syncStatus.first()
            assertEquals(0,status.review)
        } finally { repo.close() }; Unit
    }
}
