package com.sunpride.field.location

import android.content.Context
import android.graphics.Bitmap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
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
import com.sunpride.field.ui.FieldApp
import com.sunpride.field.ui.FieldBackend
import com.sunpride.field.ui.TodayData
import com.sunpride.field.ui.applySystemBars
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.io.File

/**
 * SP-0140 on the phone: the one-time battery/autostart guide that keeps work-day location sharing
 * alive under Xiaomi-class battery savers. A fake guide host records which settings page was asked
 * for (no real Settings screen opens); the work day runs the production [WorkDay] rules at 10 AM.
 * Screenshots land in /sdcard/Android/data/com.sunpride.field.dev/files/sp-0140/.
 */
class BatteryGuideDeviceTest {
    @get:Rule val rule = createAndroidComposeRule<androidx.activity.ComponentActivity>()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val configured = AppEnvironment("https://team.convex.site", "https://team.convex.cloud")
    private val alias = "sunpride-field-battery-guide-test"

    @After fun cleanUp() = KeystoreDeviceKey.delete(alias)

    private class FakeGuide(@Volatile var unrestricted: Boolean, @Volatile var shown: Boolean = false) : BatteryGuideHost {
        val opened = mutableListOf<String>()
        override fun view() = BatteryGuideView("xiaomi", unrestricted, autostart = true)
        override fun shouldShow() = BatteryGuideRules.shouldShow(shown, unrestricted, "xiaomi")
        override fun markShown() { shown = true }
        override fun openBattery(activity: Context): Boolean { opened += "battery"; return true }
        override fun openAutostart(activity: Context): Boolean { opened += "autostart"; return true }
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
    /** Every call is shifted to 10:00 Manila so the checks never depend on when the suite runs. */
    private val shift = java.time.ZonedDateTime.now(WorkHours.zone).withHour(10).withMinute(0).withSecond(0)
        .toInstant().toEpochMilli() - System.currentTimeMillis()
    private inner class Morning(private val day: WorkDay) : WorkDayHost {
        override fun view(now: Long) = day.view(now + shift)
        override fun consent(now: Long) = day.consent(now + shift)
        override fun startDay(now: Long) = day.startDay(now + shift)
        override fun endDay(now: Long) = day.endDay(now + shift)
        override fun onCheckIn(now: Long) = day.onCheckIn(now + shift)
        override fun signOut(now: Long) = day.signOut(now + shift)
        override fun resume(now: Long) = day.resume(now + shift)
    }

    private fun exists(tag: String) = rule.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()
    private fun screenshot(name: String) {
        val shot = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot() ?: return
        try {
            val dir = File(context.getExternalFilesDir(null), "sp-0140").apply { mkdirs() }
            File(dir, "$name.png").outputStream().use { shot.compress(Bitmap.CompressFormat.PNG, 100, it) }
        } finally { shot.recycle() }
    }
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
    private fun open(day: WorkDay, guide: FakeGuide, dark: Boolean = false) {
        rule.runOnUiThread { rule.activity.applySystemBars(dark) }
        rule.setContent { FieldApp(configured, dark = dark, debug = true, backend = Backend(Morning(day)), batteryGuide = guide) }
        rule.waitUntil(10_000) { exists("work-day") }
    }

    @Test fun firstStartDayShowsTheGuideOnceAboveTheNavigationBar() {
        val service = StubService()
        val day = WorkDay(MapPrefs(), { "issuer|ana" }, { LocationPermissions(true, true) }, service)
        day.consent(System.currentTimeMillis() + shift)
        val guide = FakeGuide(unrestricted = false)
        open(day, guide)
        rule.onNodeWithTag("work-day-start").performScrollTo().performClick()
        rule.waitUntil(10_000) { exists("battery-guide-title") }
        assertTrue("Start day still starts sharing", service.running)
        rule.onNodeWithText("Battery saver → No restrictions").assertIsDisplayed()
        rule.onNodeWithText("Autostart → on for Sunpride Field").assertExists()
        rule.onNodeWithTag("battery-guide-battery-state").assertTextContains("Not set yet")
        rule.onNodeWithTag("battery-guide-autostart-step").assertIsDisplayed()
        rule.waitForIdle(); Thread.sleep(400)
        screenshot("battery-guide-light")
        assertAboveNavigationBar("battery-guide-done")
        rule.onNodeWithTag("battery-guide-battery").performClick()
        rule.onNodeWithTag("battery-guide-autostart").performScrollTo().performClick()
        assertEquals(listOf("battery", "autostart"), guide.opened)
        rule.waitUntil(5_000) { guide.shown }
        rule.onNodeWithTag("battery-guide-done").performClick()
        rule.waitUntil(5_000) { exists("work-day") }
        // Seen once: ending and starting the day again goes straight back to Today.
        rule.onNodeWithTag("work-day-end").performScrollTo().performClick()
        rule.waitUntil(5_000) { exists("work-day-start") }
        rule.onNodeWithTag("work-day-start").performScrollTo().performClick()
        rule.waitUntil(5_000) { exists("work-day-end") }
        assertFalse(exists("battery-guide-title"))
    }

    @Test fun todayOffersTheGuideWhileTheBatterySaverCanStillStopSharing() {
        val now = System.currentTimeMillis() + shift
        val day = WorkDay(MapPrefs(), { "issuer|ana" }, { LocationPermissions(true, false) }, StubService())
        day.consent(now); day.startDay(now)
        val guide = FakeGuide(unrestricted = false, shown = true)
        open(day, guide, dark = true)
        rule.waitUntil(10_000) { exists("work-day-battery") }
        rule.onNodeWithTag("work-day-battery").performScrollTo().performClick()
        rule.waitUntil(5_000) { exists("battery-guide-title") }
        rule.waitForIdle(); Thread.sleep(400)
        screenshot("battery-guide-dark")
        assertAboveNavigationBar("battery-guide-done")
        // The person set "No restrictions" in Settings: the guide says so and Today stops offering it.
        guide.unrestricted = true
        rule.onNodeWithTag("battery-guide-done").performClick()
        rule.waitUntil(10_000) { exists("work-day") && !exists("work-day-battery") }
    }
}
