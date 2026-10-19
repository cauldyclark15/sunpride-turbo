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
