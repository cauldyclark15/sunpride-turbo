package com.sunpride.field.ui

import com.sunpride.field.auth.EnrollmentState
import com.sunpride.field.device.CryptoVectors
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.JcaDeviceSigner
import com.sunpride.field.device.KeyProtection
import com.sunpride.field.ui.mapping.MappingSave
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.coroutines.EmptyCoroutineContext

/** SP-0195: the phone follows the office's App mode; only Truck selling runs Sell work; the owner can switch on the phone. */
class AppModeControllerTest {
    private class Backend : FieldBackend {
        var signedIn = false
        var selling = false
        var modes: AppModes? = null
        var choice: AppMode? = null
        var onChoiceRead: (() -> Unit)? = null
        var saves = listOf<MappingSave>()
        override val isSignedIn get() = signedIn
        override fun loadSigner(): DeviceSigner = JcaDeviceSigner(CryptoVectors.privateKey, CryptoVectors.publicKey, KeyProtection.STRONGBOX)
        override fun signIn(email: String, password: String) { signedIn = true }
        override fun signOut() { signedIn = false }
        override fun refreshEnrollment(signer: DeviceSigner): EnrollmentState = EnrollmentState.Ready("dev1")
        override fun today(deviceId: String, signer: DeviceSigner, sync: Boolean) = TodayData(lastSynced = 1, stale = false)
        override fun sellingEnabled() = selling
        override fun appModes(): AppModes = modes ?: super.appModes()
        override fun appModeChoice(): AppMode? { val got = choice; onChoiceRead?.invoke(); return got }
        override fun saveAppModeChoice(mode: AppMode?) { choice = mode }
        override fun mappingSaves() = saves
    }

    private fun run(block: suspend (FieldController, Backend) -> Unit) = runBlocking {
        val backend = Backend()
        val controller = FieldController(backend, this, Dispatchers.Unconfined, EmptyCoroutineContext) {}
        block(controller, backend)
    }

    @Test fun anOlderServerKeepsTodaysAppWithoutSell() = run { c, _ ->
        c.signIn("a@example.test", "fake").join()
        assertEquals(AppMode.VISITS, c.appMode)
        assertFalse(c.selling)
    }

    @Test fun mappingModeRunsNoSellWorkEvenForASeller() = run { c, b ->
        b.selling = true; b.modes = AppModes(AppMode.MAPPING)
        c.signIn("a@example.test", "fake").join()
        assertEquals(AppMode.MAPPING, c.appMode)
        assertFalse("Sell work only in Truck selling", c.selling)
        assertFalse(c.appModes.canSwitch)
    }

    @Test fun theOfficeChangingTheModeShowsOnTheNextRefresh() = run { c, b ->
        b.selling = true; b.modes = AppModes(AppMode.SELLING)
        c.signIn("a@example.test", "fake").join()
        assertEquals(AppMode.SELLING, c.appMode)
        assertTrue(c.selling)
        b.selling = false; b.modes = AppModes(AppMode.MAPPING)
        c.syncNow().join()
        assertEquals(AppMode.MAPPING, c.appMode)
        assertFalse(c.selling)
    }

    @Test fun theOwnerSwitchesModeOnThePhoneAndItIsRemembered() = run { c, b ->
        b.selling = true; b.modes = AppModes(AppMode.SELLING, AppMode.entries.toList())
        c.signIn("a@example.test", "fake").join()
        assertTrue(c.appModes.canSwitch)
        assertTrue(c.selling)
        c.switchMode(AppMode.MAPPING)
        assertEquals(AppMode.MAPPING, c.appMode)
        assertFalse("switching away from Truck selling stops Sell work on this phone", c.selling)
        assertEquals(AppMode.MAPPING, b.choice)
        c.syncNow().join()
        assertEquals("the choice survives a refresh", AppMode.MAPPING, c.appMode)
        c.switchMode(AppMode.SELLING)
        assertTrue(c.selling)
        assertEquals("the default choice is remembered too", AppMode.SELLING, b.choice)
    }

    @Test fun aSalesmanCannotSwitchToAModeTheOfficeDidNotGive() = run { c, b ->
        b.modes = AppModes(AppMode.MAPPING)
        c.signIn("a@example.test", "fake").join()
        c.switchMode(AppMode.SELLING)
        assertEquals(AppMode.MAPPING, c.appMode)
        assertEquals(null, b.choice)
    }

    @Test fun multipleModesOfferTheRememberedDefaultAfterSignIn() = run { c, b ->
        b.selling = true; b.modes = AppModes(AppMode.VISITS, listOf(AppMode.VISITS, AppMode.SELLING))
        c.signIn("a@example.test", "fake").join()
        assertTrue(c.needsModeChoice)
        c.switchMode(AppMode.VISITS)
        assertFalse(c.needsModeChoice)
        assertEquals(AppMode.VISITS, b.choice)
        c.signOut().join()
        c.signIn("a@example.test", "fake").join()
        assertEquals(AppMode.VISITS, c.appMode)
        assertTrue("sign-in offers the remembered choice", c.needsModeChoice)
        c.switchMode(AppMode.SELLING)
        assertFalse(c.needsModeChoice)
        assertTrue(c.selling)
        c.syncNow().join()
        assertEquals(AppMode.SELLING, c.appMode)
        b.selling = false; b.modes = AppModes(AppMode.MAPPING, listOf(AppMode.MAPPING, AppMode.VISITS))
        c.syncNow().join()
        assertTrue("removed choice asks again", c.needsModeChoice)
        assertFalse(c.selling)
        assertEquals(AppMode.MAPPING, c.appMode)
        c.switchMode(AppMode.SELLING)
        assertEquals(AppMode.MAPPING, c.appMode)
    }

    @Test fun aRefreshCannotUndoANewerChoice() = run { c, b ->
        b.selling = true; b.modes = AppModes(AppMode.VISITS, listOf(AppMode.VISITS, AppMode.SELLING))
        b.choice = AppMode.VISITS
        c.signIn("a@example.test", "fake").join()
        b.onChoiceRead = { b.onChoiceRead = null; c.switchMode(AppMode.SELLING) }
        c.syncNow().join()
        assertEquals(AppMode.SELLING, c.appMode)
        assertEquals(AppMode.SELLING, b.choice)
        assertTrue(c.selling)
    }

    @Test fun singleModeDoesNotAskForAChoice() = run { c, b ->
        b.modes = AppModes(AppMode.MAPPING)
        c.signIn("a@example.test", "fake").join()
        assertFalse(c.needsModeChoice)
    }

    @Test fun mappingHomeReadsTheSavesOnThisPhoneAndSignOutClearsThem() = run { c, b ->
        b.modes = AppModes(AppMode.MAPPING)
        b.saves = listOf(MappingSave("Aling Nena Store", "San Isidro", sent = false, savedAt = 1L))
        c.signIn("a@example.test", "fake").join()
        c.refreshMappingSaves().join()
        assertEquals(b.saves, c.mappingSaves)
        c.signOut().join()
        assertEquals(emptyList<MappingSave>(), c.mappingSaves)
        assertEquals(AppMode.VISITS, c.appMode)
    }
}
