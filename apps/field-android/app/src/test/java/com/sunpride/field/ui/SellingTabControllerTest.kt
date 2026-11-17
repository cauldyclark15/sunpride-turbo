package com.sunpride.field.ui

import com.sunpride.field.auth.EnrollmentState
import com.sunpride.field.device.CryptoVectors
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.JcaDeviceSigner
import com.sunpride.field.device.KeyProtection
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.coroutines.EmptyCoroutineContext

/** SP-0192: the Sell tab follows the office's per-person Selling switch; a non-seller's app does no selling work at all. */
class SellingTabControllerTest {
    private class Backend : FieldBackend {
        var signedIn = false
        var selling = false
        var partner = false
        var sellingReads = 0
        var accessAsked = 0
        val syncs = mutableListOf<Boolean>()
        override val isSignedIn get() = signedIn
        override fun loadSigner(): DeviceSigner = JcaDeviceSigner(CryptoVectors.privateKey, CryptoVectors.publicKey, KeyProtection.STRONGBOX)
        override fun signIn(email: String, password: String) { signedIn = true }
        override fun signOut() { signedIn = false }
        override fun refreshEnrollment(signer: DeviceSigner): EnrollmentState = EnrollmentState.Ready("dev1")
        override fun today(deviceId: String, signer: DeviceSigner, sync: Boolean): TodayData {
            syncs += sync
            return TodayData(lastSynced = 1, stale = false, partnerMode = partner)
        }
        override fun sellingEnabled(): Boolean { sellingReads++; return selling }
        override fun sellAccess(): com.sunpride.field.sell.auth.SellAccess? { accessAsked++; return null }
    }

    private fun run(block: suspend (FieldController, Backend) -> Unit) = runBlocking {
        val backend = Backend()
        val controller = FieldController(backend, this, Dispatchers.Unconfined, EmptyCoroutineContext) {}
        block(controller, backend)
    }

    @Test fun nonSellerSeesNoSellTabAndNothingSellingIsAskedFor() = run { c, b ->
        c.signIn("a@example.test", "fake").join()
        assertTrue(c.state is EnrollmentState.Ready)
        assertFalse(c.selling)
        c.syncNow().join()
        assertFalse(c.selling)
        // The Field app never asks for the Sell area's session for a person without Selling.
        assertEquals(0, b.accessAsked)
        assertEquals(null, c.sellSync)
    }

    @Test fun sellerSeesTheSellTabAndLosesItWhenTheOfficeSwitchesItOff() = run { c, b ->
        b.selling = true
        c.signIn("a@example.test", "fake").join()
        assertTrue(c.selling)
        b.selling = false
        c.syncNow().join()
        assertFalse("Sell hides once the office switches Selling off", c.selling)
    }

    @Test fun signOutAndPartnerModeNeverShowSell() = run { c, b ->
        b.selling = true
        c.signIn("a@example.test", "fake").join()
        assertTrue(c.selling)
        c.signOut().join()
        assertFalse(c.selling)
        b.partner = true
        c.signIn("a@example.test", "fake").join()
        assertFalse("a distributor's app has no Sell tab", c.selling)
    }

    @Test fun syncNowAlsoSendsTheSellAreaOnlyWhenSelling() = run { c, b ->
        var sent = 0
        c.signIn("a@example.test", "fake").join()
        c.sellSync = { sent++ }
        c.syncNow().join()
        assertEquals("not selling: the Sell area is never sent", 0, sent)
        b.selling = true
        c.syncNow().join()
        assertEquals(1, sent)
    }
}
