package com.sunpride.van.ui

import androidx.activity.ComponentActivity
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import com.sunpride.van.AppEnvironment
import com.sunpride.van.data.VanRepository
import com.sunpride.van.location.LocationSharing
import com.sunpride.van.location.SharingState
import com.sunpride.van.storage.StoreScope
import kotlinx.coroutines.runBlocking
import org.junit.*
import org.junit.Assert.*

/**
 * SP-0137 on the handheld: the one-time consent before the first Start trip, the "Location sharing on/off"
 * indicator on Today, and the service started only while the trip is on the road. Android permissions and the
 * service are replaced by [FakeSharing] (no permission dialog, no GPS); the practice repository is real.
 */
class LocationSharingUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val repositories = mutableListOf<VanRepository>()
    private var controller by mutableStateOf<VanController?>(null)
    private val c get() = controller!!

    /** Records what the app asked for; consent kept in memory, permission switchable. */
    private class FakeSharing(var granted: Boolean = true) : LocationSharing {
        val consents = mutableMapOf<StoreScope,Boolean>()
        val updates = mutableListOf<Pair<StoreScope?,Boolean>>()
        override val enabled = true
        override fun consented(scope: StoreScope) = consents[scope] == true
        override fun setConsent(scope: StoreScope, accepted: Boolean) { consents[scope] = accepted }
        override fun permitted() = granted
        override fun missingPermissions() = emptyList<String>()
        override fun update(scope: StoreScope?, track: Boolean) { if (updates.lastOrNull()?.second != track || track && updates.last().first != scope) updates += scope to track }
        val tracking get() = updates.lastOrNull()?.second == true
    }

    @Before fun resetFixture() {
        WorkManager.getInstance(context).cancelUniqueWork("van-sales-sync-stub").result.get()
        context.deleteDatabase("van_stub_store.db")
        context.getSharedPreferences("van_fixture_backend",0).edit().clear().commit()
        rule.runOnUiThread { rule.activity.applySystemBars(false) }
    }
    @After fun close() {
        rule.runOnUiThread { controller = null }
        rule.waitForIdle()
        repositories.forEach { it.close() }
    }

    private fun mount(sharing: FakeSharing) {
        val repo = VanRepository.forWorker(context,true).also { repositories += it }
        controller = VanController(repo,AppEnvironment("",""),fixtureMode = true,locationSharing = sharing)
        rule.setContent { controller?.let { VanApp(it) } }
        rule.waitUntil(20_000) { c.initialized && !c.busy && c.trip != null && c.policy != null }
    }
    /** Today's location row (ListRow's tag sits on its Surface; the words are its descendants). */
    private fun sharingRow(text: String) = rule.onNode(hasTestTag("location-sharing") and hasAnyDescendant(hasText(text,substring = true)))
    private fun open(page: Page) { rule.runOnUiThread { c.open(page) }; rule.waitForIdle() }
    private fun sync() { runBlocking { c.repository.syncNow() }; rule.waitForIdle() }
    private fun loadAndOpenStart() {
        open(Page.LOAD)
        rule.onNodeWithTag("confirm-load").performClick()
        rule.waitUntil(10_000) { c.load?.confirmPending == true && !c.busy }
        sync(); rule.waitUntil(10_000) { c.trip?.status == "loaded" }
        open(Page.START)
        rule.onNodeWithTag("confirm-truck").performClick()
        rule.onNodeWithTag("confirm-route").performClick()
    }

    @Test fun consentComesBeforeTheFirstTripAndSharingRunsOnlyWhileOnTheRoad() {
        val sharing = FakeSharing()
        mount(sharing)
        assertFalse("nothing is shared before the trip",sharing.tracking)
        rule.onNodeWithTag("location-sharing").assertDoesNotExist()
        loadAndOpenStart()
        rule.onNodeWithTag("start-location-note").assertExists()
        rule.onNodeWithTag("start-trip").performClick()
        // The consent page, not the trip, comes first.
        rule.waitUntil(5_000) { c.page == Page.LOCATION_CONSENT }
        rule.onNodeWithTag("location-consent-intro").assertExists()
        rule.onNodeWithTag("location-point-0").assertTextContains("What:",substring = true)
        captureVanScreenshot(rule,"location-consent","location-agree")
        assertNull("the trip waits for the answer",c.trip?.takeIf { it.startPending })
        rule.onNodeWithTag("location-agree").performClick()
        rule.waitUntil(10_000) { c.trip?.startPending == true && !c.busy && c.page == Page.HOME }
        assertTrue(sharing.consents.values.single())
        rule.waitUntil(5_000) { sharing.tracking }
        sharingRow("Location sharing on").performScrollTo().assertExists()
        captureVanScreenshot(rule,"location-sharing-on","home-primary")
        sync(); rule.waitUntil(10_000) { c.trip?.status == "active" }
        assertTrue("still sharing once the office has the trip",sharing.tracking)
        // Sign-out ends sharing (the service then records the stop ping).
        rule.runOnUiThread { c.signOut() }
        rule.waitUntil(10_000) { !c.session.signedIn && !c.busy }
        assertFalse(sharing.tracking)
    }

    @Test fun notNowStillStartsTheTripWithoutSharingAndTodayOffersToTurnItOn() {
        val sharing = FakeSharing()
        mount(sharing)
        loadAndOpenStart()
        rule.onNodeWithTag("start-trip").performClick()
        rule.waitUntil(5_000) { c.page == Page.LOCATION_CONSENT }
        rule.onNodeWithTag("location-not-now").performScrollTo().performClick()
        rule.waitUntil(10_000) { c.trip?.startPending == true && !c.busy && c.page == Page.HOME }
        assertFalse(sharing.tracking)
        assertEquals(SharingState.NEEDS_CONSENT,c.sharing)
        sharingRow("Location sharing off").performScrollTo().performClick()
        rule.waitUntil(5_000) { c.page == Page.LOCATION_CONSENT }
        rule.onNodeWithTag("location-agree").performClick()
        rule.waitUntil(5_000) { c.page == Page.HOME && sharing.tracking }
        assertEquals(SharingState.ON,c.sharing)
        // Turning it off again stops at once.
        rule.onNodeWithTag("location-sharing").performScrollTo().performClick()
        rule.waitUntil(5_000) { c.page == Page.LOCATION_CONSENT }
        captureVanScreenshot(rule,"location-consent-on","location-agree")
        rule.onNodeWithTag("location-withdraw").performScrollTo().performClick()
        rule.waitUntil(5_000) { c.page == Page.HOME && !sharing.tracking }
        assertEquals(SharingState.NEEDS_CONSENT,c.sharing)
    }

    @Test fun permissionOffShowsSharingOffWithoutBlockingTheTrip() {
        val sharing = FakeSharing(granted = false)
        mount(sharing)
        loadAndOpenStart()
        rule.onNodeWithTag("start-trip").performClick()
        rule.waitUntil(5_000) { c.page == Page.LOCATION_CONSENT }
        rule.onNodeWithTag("location-agree").performClick()
        rule.waitUntil(10_000) { c.trip?.startPending == true && !c.busy && c.page == Page.HOME }
        assertFalse(sharing.tracking)
        assertEquals(SharingState.NEEDS_PERMISSION,c.sharing)
        sharingRow("Allow location").performScrollTo().assertExists()
        // Allowed later in Settings: picked up when the app comes back.
        sharing.granted = true
        rule.runOnUiThread { c.refreshSharing() }
        rule.waitUntil(5_000) { sharing.tracking }
    }

    @Test fun disabledSharingNeverShowsConsentOrIndicator() {
        val repo = VanRepository.forWorker(context,true).also { repositories += it }
        controller = VanController(repo,AppEnvironment("",""),fixtureMode = true)
        rule.setContent { controller?.let { VanApp(it) } }
        rule.waitUntil(20_000) { c.initialized && !c.busy && c.trip != null && c.policy != null }
        loadAndOpenStart()
        rule.onNodeWithTag("start-location-note").assertDoesNotExist()
        rule.onNodeWithTag("start-trip").performClick()
        rule.waitUntil(10_000) { c.trip?.startPending == true && !c.busy }
        assertEquals(Page.HOME,c.page)
        rule.onNodeWithTag("location-sharing").assertDoesNotExist()
    }
}
