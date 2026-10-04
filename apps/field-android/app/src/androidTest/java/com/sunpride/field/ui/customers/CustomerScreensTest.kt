package com.sunpride.field.ui.customers

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
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import com.sunpride.field.storage.CallSheetHeader
import com.sunpride.field.ui.SunprideTokens
import com.sunpride.field.ui.TodayData
import com.sunpride.field.ui.TodayScreen
import com.sunpride.field.ui.VisitDisplay
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class CustomerScreensTest {
    @get:Rule val rule = createAndroidComposeRule<androidx.activity.ComponentActivity>()

    private val now = java.time.ZonedDateTime.parse("2026-10-04T09:00:00+08:00").toInstant().toEpochMilli()
    private val todayVisit = VisitDisplay("Peña Sari-Sari Store", "Planned", "In progress", "o1", "p1",
        listOf("sell"), sequence = 1, outletCode = "OUT-001", latitude = 14.5, longitude = 121.0)
    private val pena = CustomerRecord("o1", "Peña Sari-Sari Store", "OUT-001", "CUST-9", "12 Rizal Ave, Pasig",
        14.5, 121.0, "r1", "PSG-01",
        CallSheetHeader("Peña Sari-Sari Store", null, "Ana Cruz", "0917 123 4567", "J. Santos", null,
            "North Dist", "Mon/Thu", null, null),
        listOf(PlannedCall("2026-10-04", "p1", listOf("sell")), PlannedCall("2026-10-05", "p1b", emptyList())),
        listOf(HistoryEntry(now - 600_000, "Call started", "Waiting to send")), todayVisit)
    private val nino = CustomerRecord("o2", "Sto. Niño Grocery", "OUT-002", routeId = "r2",
        planned = listOf(PlannedCall("2026-10-05", "p2", listOf("merchandise_check"))))
    private val data = TodayData(listOf(todayVisit), stale = true, customers = listOf(pena, nino),
        tasks = listOf(CustomerTask("price_survey", true)))

    private fun content(block: @androidx.compose.runtime.Composable () -> Unit) = rule.setContent {
        MaterialTheme(colorScheme = SunprideTokens.lightColors) { block() }
    }

    @Test fun searchFiltersTheCachedOutletsOfflineAndOpensOne() {
        val opened = mutableListOf<String>()
        content { CustomerSearchScreen(data, onOpen = { opened += it }, offline = true, now = now) }
        rule.onNodeWithTag("customer-count").assertTextContains("2 outlets · Saved on this phone")
        rule.onAllNodesWithTag("customer-result").assertCountEquals(2)
        rule.onAllNodesWithTag("customer-result")[0].assertTextContains("Peña Sari-Sari Store", substring = true)
            .assertTextContains("OUT-001 · CUST-9 · Today", substring = true)
        rule.onNodeWithTag("customer-search").performTextInput("sto nino")
        rule.onNodeWithTag("customer-count").assertTextContains("1 of 2 outlets", substring = true)
        rule.onAllNodesWithTag("customer-result").assertCountEquals(1)
        rule.onAllNodesWithTag("customer-result")[0].assertTextContains("Tomorrow", substring = true).performClick()
        assertEquals(listOf("o2"), opened)
        rule.onNodeWithTag("customer-search").performTextReplacement("zzz")
        rule.onNodeWithTag("customer-no-match").assertTextContains("Only outlets on your plan", substring = true)
    }

    @Test fun emptyDirectoryAsksForASync() {
        content { CustomerSearchScreen(TodayData(stale = false), onOpen = {}) }
        rule.onNodeWithTag("customer-count").assertTextContains("No outlets on this phone")
        rule.onNodeWithTag("customer-empty").assertTextContains("Sync to download", substring = true)
    }

    @Test fun detailShowsSummaryRoutePlanTasksAndHistory() {
        content { CustomerDetailScreen(pena, data, onNavigate = { true }, onDial = { true }, now = now) }
        rule.onNodeWithTag("customer-header").assertTextContains("Peña Sari-Sari Store", substring = true)
            .assertTextContains("OUT-001 · CUST-9", substring = true)
        rule.onNodeWithTag("customer-summary").assertTextContains("Ana Cruz", substring = true)
            .assertTextContains("0917 123 4567", substring = true).assertTextContains("Mon/Thu", substring = true)
            .assertTextContains("Verified pin", substring = true)
        rule.onNodeWithTag("customer-route").performScrollTo().assertTextContains("PSG-01", substring = true)
            .assertTextContains("Stop 1 of 1 · In progress", substring = true)
        rule.onNodeWithTag("customer-planned").performScrollTo().assertTextContains("Today", substring = true)
            .assertTextContains("Tomorrow", substring = true)
        rule.onNodeWithTag("customer-tasks").performScrollTo().assertTextContains("Sell", substring = true)
            .assertTextContains("Price survey", substring = true).assertTextContains("Required · your day", substring = true)
        rule.onNodeWithTag("customer-history").performScrollTo().assertTextContains("Call started", substring = true)
            .assertTextContains("8:50 AM · Waiting to send", substring = true)
            .assertTextContains("Office history is not downloaded", substring = true)
    }

    @Test fun actionsNavigateDialAndOpenTheVisitWhenRecordingIsEnabled() {
        val opened = mutableListOf<String>()
        val visits = mutableListOf<VisitDisplay>()
        content {
            CustomerDetailScreen(pena, data, onNavigate = { opened += it; true }, onDial = { opened += it; false },
                onVisit = { visits += it }, visitEnabled = true, now = now)
        }
        rule.onNodeWithTag("customer-navigate").assertIsEnabled().performClick()
        rule.onNodeWithTag("customer-call").assertIsEnabled().performClick()
        assertEquals(listOf("geo:14.500000,121.000000?q=14.500000,121.000000(Pe%C3%B1a%20Sari-Sari%20Store)",
            "tel:09171234567"), opened)
        rule.onNodeWithTag("customer-action-error").assertTextContains("No phone app on this device")
        rule.onNodeWithTag("customer-visit").assertTextContains("Continue visit").performClick()
        assertEquals("p1", visits.single().plannedVisitId)
    }

    @Test fun outletOffTodaysPlanOffersAnUnplannedVisitAndDisablesMissingActions() {
        val visits = mutableListOf<VisitDisplay>()
        content {
            CustomerDetailScreen(nino, data, onNavigate = { true }, onDial = { true },
                onVisit = { visits += it }, visitEnabled = true, now = now)
        }
        rule.onNodeWithTag("customer-navigate").assertIsNotEnabled()
        rule.onNodeWithTag("customer-call").assertIsNotEnabled()
        rule.onNodeWithTag("customer-summary").assertTextContains("No account sheet", substring = true)
        rule.onNodeWithTag("customer-route").performScrollTo().assertTextContains("Another route", substring = true)
            .assertTextContains("Not on today's plan", substring = true)
        rule.onNodeWithTag("customer-visit").performScrollTo().assertTextContains("Unplanned visit").performClick()
        assertEquals(VisitDisplay("Sto. Niño Grocery", "Unplanned", "Reason required", "o2"), visits.single())
    }

    @Test fun visitActionIsHiddenWhenRecordingIsOff() {
        content { CustomerDetailScreen(pena, data, onNavigate = { true }, onDial = { true }, now = now) }
        rule.onAllNodesWithTag("customer-visit").assertCountEquals(0)
    }

    @Test fun todayLinksToCustomerSearch() {
        var opened = 0
        content { TodayScreen(data, busy = false, onSync = {}, onSignOut = {}, onCustomers = { opened++ }) }
        rule.onNodeWithTag("customers-open").assertTextContains("2 outlets saved on this phone", substring = true)
            .performClick()
        assertEquals(1, opened)
    }
}
