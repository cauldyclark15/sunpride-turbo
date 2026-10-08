package com.sunpride.field.location

import android.Manifest
import android.accessibilityservice.AccessibilityService
import android.app.NotificationManager
import android.graphics.Bitmap
import android.os.Build
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.Dp
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.field.AppEnvironment
import com.sunpride.field.auth.EnrollmentState
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.KeystoreDeviceKey
import com.sunpride.field.storage.EncryptedFieldDatabase
import com.sunpride.field.storage.PING_MAX_AGE_MS
import com.sunpride.field.storage.RoomFieldStore
import com.sunpride.field.storage.ScopedSnapshot
import com.sunpride.field.storage.SnapshotItem
import com.sunpride.field.storage.StoreScope
import com.sunpride.field.ui.FieldApp
import com.sunpride.field.ui.FieldBackend
import com.sunpride.field.ui.TodayData
import com.sunpride.field.ui.applySystemBars
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.util.UUID

/**
 * SP-0136 on the phone: the encrypted ping buffer (real SQLCipher Room), the consent screen and the
 * work-day card above the 3-button navigation bar, the top-bar indicator, and the ongoing notification.
 * No location permission is granted and no real position is read; the work day uses the production
 * [WorkDay] rules with an in-memory store and a recording service stub.
 * Screenshots land in /sdcard/Android/data/com.sunpride.field.dev/files/sp-0136/ for `adb pull`.
 */
class LiveLocationDeviceTest {
    @get:Rule val rule = createAndroidComposeRule<androidx.activity.ComponentActivity>()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val configured = AppEnvironment("https://team.convex.site", "https://team.convex.cloud")
    private val alias = "sunpride-field-location-ui-test"

    @After fun cleanUp() = KeystoreDeviceKey.delete(alias)

    private fun screenshot(name: String) {
        val shot = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot() ?: return
        try {
            val dir = File(context.getExternalFilesDir(null), "sp-0136").apply { mkdirs() }
            File(dir, "$name.png").outputStream().use { shot.compress(Bitmap.CompressFormat.PNG, 100, it) }
        } finally { shot.recycle() }
    }

    @Test fun pingBufferIsScopedHeldAndPrunedInRealSqlCipher() = runBlocking {
        val scope = StoreScope("issuer|loc-${UUID.randomUUID()}", "device-L", "scope-L")
        var db = EncryptedFieldDatabase.open(context)
        try {
            val store = RoomFieldStore(db, scope)
            val now = System.currentTimeMillis()
            assertFalse("never synced: nowhere to keep pings", store.addPing("p0", now, "{}", now))
            store.swap(store.stage(ScopedSnapshot("{\"id\":\"employee\"}", null, emptyList(),
                listOf(SnapshotItem("outlet-1", "outlet")), emptyList(), emptyList())), "cursor", Long.MAX_VALUE, Long.MAX_VALUE)
            assertTrue(store.addPing("p1", now - 60_000, "{\"n\":1}", now))
            assertTrue(store.addPing("p2", now, "{\"n\":2}", now))
            assertFalse("older than the server's 7-day limit", store.addPing("p3", now - PING_MAX_AGE_MS - 1, "{}", now))
            assertEquals(0, RoomFieldStore(db, scope.copy(fingerprint = "other")).pendingPingCount())
            db.close(); db = EncryptedFieldDatabase.open(context)
            val reopened = RoomFieldStore(db, scope)
            assertEquals(listOf("p1", "p2"), reopened.pendingPings(100).map { it.clientPingId })
            assertEquals(listOf("p1"), reopened.pendingPings(1).map { it.clientPingId })
            reopened.removePings(listOf("p1"))
            assertEquals(listOf("{\"n\":2}"), reopened.pendingPings(100).map { it.json })
            reopened.holdForReview()
            assertTrue(reopened.isHeld())
            assertFalse("a held partition records nothing new", reopened.addPing("p4", now, "{}", now))
            assertEquals(1, reopened.pendingPingCount())
        } finally { db.close() }
    }

    private class MapPrefs : WorkDayPrefs {
        val map = mutableMapOf<String, String>()
        override fun get(key: String) = map[key]
        override fun put(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
    }
    private class StubService : LocationService {
        @Volatile var running = false
        override fun start() { running = true }
        override fun stop() { running = false }
    }

    private inner class Backend(override val workDay: WorkDayHost) : FieldBackend {
        override val isSignedIn = true
        override fun loadSigner(): DeviceSigner = KeystoreDeviceKey.loadOrCreate(rule.activity, alias)
        override fun signIn(email: String, password: String) = Unit
        override fun signOut() { workDay.signOut(System.currentTimeMillis()) }
        override fun refreshEnrollment(signer: DeviceSigner) = EnrollmentState.Ready("dev1")
        override fun today(deviceId: String, signer: DeviceSigner, sync: Boolean) = TodayData(stale = false)
    }

    /**
     * The screen reads the real clock, but these checks must not depend on when the suite runs (it
     * often runs at night, outside 05:00–22:00). Every call is shifted to 10:00 Manila today; the
     * production [WorkDay] rules see a mid-morning work day.
     */
    private fun offsetTo(hour: Int) = java.time.ZonedDateTime.now(WorkHours.zone).withHour(hour).withMinute(0).withSecond(0)
        .toInstant().toEpochMilli() - System.currentTimeMillis()
    private val offset = offsetTo(10)
    private fun clock() = System.currentTimeMillis() + offset
    private inner class Morning(private val day: WorkDay, private val shift: Long) : WorkDayHost {
        override fun view(now: Long) = day.view(now + shift)
        override fun consent(now: Long) = day.consent(now + shift)
        override fun startDay(now: Long) = day.startDay(now + shift)
        override fun endDay(now: Long) = day.endDay(now + shift)
        override fun onCheckIn(now: Long) = day.onCheckIn(now + shift)
        override fun signOut(now: Long) = day.signOut(now + shift)
        override fun resume(now: Long) = day.resume(now + shift)
    }

    private fun exists(tag: String) = rule.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()

    /** Bottom of [tag] in px must sit above the navigation bar (3-button bar on jc's Galaxy). */
    private fun assertAboveNavigationBar(tag: String) {
        var navBar = 0
        rule.runOnUiThread {
            navBar = ViewCompat.getRootWindowInsets(rule.activity.window.decorView)!!
                .getInsets(WindowInsetsCompat.Type.navigationBars()).bottom
        }
        val density = rule.activity.resources.displayMetrics.density
        fun px(dp: Dp) = dp.value * density
        val root = rule.onRoot().getBoundsInRoot()
        val button = rule.onNodeWithTag(tag).getBoundsInRoot()
        assertTrue("$tag bottom ${px(button.bottom)} must clear the ${navBar}px navigation bar (root ${px(root.bottom)})",
            px(button.bottom) <= px(root.bottom) - navBar + 1)
    }

    private fun today(day: WorkDay, dark: Boolean = false, hour: Int = 10) {
        rule.runOnUiThread { rule.activity.applySystemBars(dark) }
        val host = Morning(day, offsetTo(hour))
        rule.setContent { FieldApp(configured, dark = dark, debug = true, backend = Backend(host)) }
        rule.waitUntil(10_000) { exists("work-day") }
    }

    @Test fun startDayAsksForConsentFirstAndTheConsentScreenClearsTheNavigationBar() {
        val service = StubService()
        val day = WorkDay(MapPrefs(), { "issuer|ana" }, { LocationPermissions(true, false) }, service)
        today(day)
        rule.onNodeWithTag("work-day-status").assertTextContains("Location sharing", substring = true)
        rule.onNodeWithTag("location-indicator").assertDoesNotExist()
        screenshot("today-work-day-off")
        rule.onNodeWithTag("work-day-start").performClick()
        rule.waitUntil(5_000) { exists("location-consent-title") }
        rule.onNodeWithTag("location-consent-title").assertIsDisplayed()
        rule.waitForIdle(); Thread.sleep(400)
        screenshot("consent-light")
        assertAboveNavigationBar("location-consent-agree")
        assertAboveNavigationBar("location-consent-decline")
        assertFalse("nothing is shared before consent", service.running)
        rule.onNodeWithTag("location-consent-decline").performClick()
        rule.waitUntil(5_000) { exists("work-day") }
        assertFalse(day.view(clock()).consented)
        assertFalse(service.running)
    }

    @Test fun startDayIsDisabledAfterTheTenPmClose() {
        val day = WorkDay(MapPrefs(), { "issuer|ana" }, { LocationPermissions(true, false) }, StubService())
        today(day, hour = 23)
        rule.onNodeWithTag("work-day-start").assertIsNotEnabled()
        rule.onNodeWithTag("work-day-status").assertTextContains("5 AM until the 10 PM close", substring = true)
    }

    @Test fun consentScreenInDarkTheme() {
        val day = WorkDay(MapPrefs(), { "issuer|ana" }, { LocationPermissions(true, false) }, StubService())
        today(day, dark = true)
        rule.onNodeWithTag("work-day-start").performClick()
        rule.waitUntil(5_000) { exists("location-consent-title") }
        rule.waitForIdle(); Thread.sleep(400)
        screenshot("consent-dark")
        assertAboveNavigationBar("location-consent-agree")
    }

    @Test fun sharingShowsTheIndicatorAndEndDayStopsIt() {
        val now = clock()
        val service = StubService()
        val day = WorkDay(MapPrefs(), { "issuer|ana" }, { LocationPermissions(true, false) }, service)
        day.consent(now); day.startDay(now)
        assertTrue(service.running)
        today(day)
        rule.onNodeWithTag("location-indicator").assertTextContains("Location sharing on")
        rule.onNodeWithTag("work-day-status").assertTextContains("Location sharing on since", substring = true)
        rule.waitForIdle(); Thread.sleep(300)
        screenshot("today-sharing-on")
        rule.onNodeWithTag("work-day-end").performScrollTo().performClick()
        rule.waitUntil(5_000) { exists("work-day-start") }
        assertFalse(service.running)
        rule.onNodeWithTag("location-indicator").assertDoesNotExist()
        rule.onNodeWithTag("work-day-status").assertTextContains("Day ended", substring = true)
    }

    @Test fun deniedLocationKeepsTheAppWorkingAndSaysLocationOff() {
        val now = clock()
        val service = StubService()
        val day = WorkDay(MapPrefs(), { "issuer|ana" }, { LocationPermissions(false, false) }, service)
        day.consent(now); day.startDay(now)
        assertFalse("no permission: the service is never started", service.running)
        today(day)
        rule.onNodeWithTag("location-indicator").assertTextContains("Location off")
        rule.onNodeWithTag("work-day-allow").assertIsDisplayed()
        rule.onNodeWithTag("today-title").assertIsDisplayed()
        screenshot("today-location-off")
    }

    @Test fun ongoingNotificationSaysSunprideIsSharingYourLocationForWork() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val manager = context.getSystemService(NotificationManager::class.java)
        val notification = LocationShareService.notification(context)
        assertTrue(notification.flags and android.app.Notification.FLAG_ONGOING_EVENT != 0)
        assertEquals(LocationShareService.TEXT, notification.extras.getCharSequence(android.app.Notification.EXTRA_TEXT).toString())
        assertEquals(NotificationManager.IMPORTANCE_LOW, manager.getNotificationChannel(LocationShareService.CHANNEL).importance)
        if (Build.VERSION.SDK_INT >= 33) instrumentation.uiAutomation.grantRuntimePermission(context.packageName,
            Manifest.permission.POST_NOTIFICATIONS)
        val id = LocationShareService.NOTIFICATION_ID + 1 // never collides with a real running service
        manager.notify(id, notification)
        try {
            Thread.sleep(500)
            assertTrue(manager.activeNotifications.any { it.id == id && it.isOngoing })
            instrumentation.uiAutomation.performGlobalAction(AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS)
            Thread.sleep(1_200)
            screenshot("notification-shade")
        } finally {
            instrumentation.uiAutomation.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
            manager.cancel(id)
        }
    }
}
