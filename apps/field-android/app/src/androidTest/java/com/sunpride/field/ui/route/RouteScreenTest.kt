package com.sunpride.field.ui.route

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.sunpride.field.ui.SunprideTokens
import com.sunpride.field.ui.TodayData
import com.sunpride.field.ui.TodayScreen
import com.sunpride.field.ui.VisitDisplay
import com.sunpride.field.ui.diagnosticvisit.VisitLocation
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class RouteScreenTest {
    @get:Rule val rule = createAndroidComposeRule<androidx.activity.ComponentActivity>()

    /** In-app fake fix: no permission grant, no real GPS (works on any device without adb pm grant). */
    private class FakeLocation(val fix: JSONObject?) : VisitLocation {
        override val requiresPermission = false
        var calls = 0
        override suspend fun fix(): JSONObject? { calls++; return fix }
    }

    private val day = TodayData(listOf(
        VisitDisplay("Third Store", "Planned", "Scheduled", "o3", "p3", sequence = 3, address = "3 Mabini St"),
        VisitDisplay("First Store", "Planned", "Done", "o1", "p1", sequence = 1, timeSpent = "12 min",
            latitude = 14.5764, longitude = 121.0851, outletCode = "OUT-1", customerCode = "LOCAL-C"),
        VisitDisplay("Second Store", "Planned", "Scheduled", "o2", "p2", listOf("merchandise"), sequence = 2,
            latitude = 14.5864, longitude = 121.0851, outletCode = "OUT-2"),
        VisitDisplay("Fourth Store", "Planned", "Scheduled", "o4", "p4", sequence = 4),
    ), stale = true)

    private fun summaries() = rule.onAllNodesWithTag("route-stop-summary", useUnmergedTree = false)

    @Test fun listsStopsInPlanOrderWithStateAndDistanceFromTheCachedDay() {
        // A complete fix, as AndroidVisitLocation returns one: a bare lat/lng is not a fix the app accepts.
        val location = FakeLocation(JSONObject().put("latitude", 14.5764).put("longitude", 121.0851)
            .put("accuracyMeters", 8.0).put("fixTime", System.currentTimeMillis()).put("provider", "fused"))
        rule.setContent {
            MaterialTheme(colorScheme = SunprideTokens.lightColors) {
                RouteScreen(day, location, onNavigate = { true }, offline = true)
            }
        }
        rule.waitUntil(5_000) { location.calls > 0 }
        // The fix lands after the call returns; distance shows once the "needs location" row goes away.
        rule.waitUntil(5_000) { rule.onAllNodesWithTag("route-location").fetchSemanticsNodes().isEmpty() }
        rule.onNodeWithTag("route-summary").assertTextContains("1 of 4 done · Saved on this phone")
        summaries().assertCountEquals(4)
        summaries()[0].assertTextContains("First Store").assertTextContains("Done · 10 m · 12 min")
        summaries()[1].assertTextContains("Second Store").assertTextContains("Next · 1.1 km")
        summaries()[2].assertTextContains("Third Store").assertTextContains("Later")
        summaries()[3].assertTextContains("Fourth Store").assertTextContains("Later")
    }

    @Test fun navigateUsesPinThenAddressAndIsDisabledWithoutEither() {
        val opened = mutableListOf<String>()
        rule.setContent {
            MaterialTheme(colorScheme = SunprideTokens.lightColors) {
                RouteScreen(day, FakeLocation(null), onNavigate = { opened += it; it.startsWith("geo:14") })
            }
        }
        val navigate = rule.onAllNodesWithTag("route-navigate")
        navigate[1].performClick()
        navigate[2].performScrollTo().performClick()
        assertEquals(listOf("geo:14.586400,121.085100?q=14.586400,121.085100(Second%20Store)",
            "geo:0,0?q=3%20Mabini%20St"), opened)
        // The address search "failed" in this fake, so the screen tells the user plainly.
        rule.onNodeWithTag("route-navigation-error").assertTextContains("No maps app on this phone")
        navigate[3].performScrollTo().assertIsNotEnabled()
        rule.onNodeWithTag("route-location").assertTextContains("Location unavailable")
    }

    @Test fun customerActionShowsCodesAndOpensTheVisitWhenRecordingIsEnabled() {
        val visits = mutableListOf<VisitDisplay>()
        rule.setContent {
            MaterialTheme(colorScheme = SunprideTokens.lightColors) {
                RouteScreen(day, FakeLocation(null), onNavigate = { true }, onVisit = { visits += it }, visitEnabled = true)
            }
        }
        rule.onAllNodesWithTag("route-customer-toggle")[0].performClick()
        rule.onNodeWithTag("route-customer").assertTextContains("OUT-1", substring = true)
            .assertTextContains("LOCAL-C", substring = true)
        rule.onNodeWithTag("route-open-visit").performScrollTo().assertIsEnabled().performClick()
        assertEquals("p1", visits.single().plannedVisitId)
    }

    @Test fun todayLinksToTheRouteWithTheNextStop() {
        var opened = 0
        rule.setContent {
            MaterialTheme(colorScheme = SunprideTokens.lightColors) {
                TodayScreen(day, busy = false, onSync = {}, onSignOut = {}, onRoute = { opened++ })
            }
        }
        rule.onNodeWithTag("route-open").assertTextContains("Next: Second Store", substring = true).performClick()
        assertEquals(1, opened)
    }

    @Test fun emptyDayAsksForASync() {
        rule.setContent {
            MaterialTheme(colorScheme = SunprideTokens.lightColors) {
                RouteScreen(TodayData(stale = false), FakeLocation(null), onNavigate = { true })
            }
        }
        rule.onNodeWithTag("route-summary").assertTextContains("No stops today")
        rule.onNodeWithTag("route-empty").assertTextContains("Sync to download today's plan")
    }
}
