package com.sunpride.field.ui.customers

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import com.sunpride.field.storage.CallSheetHeader
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.graphics.asAndroidBitmap
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
        rule.onNodeWithTag("customer-count").assertTextContains("2 stores · Saved on this phone")
        rule.onAllNodesWithTag("customer-result").assertCountEquals(2)
        rule.onAllNodesWithTag("customer-result")[0].assertTextContains("Peña Sari-Sari Store", substring = true)
            .assertTextContains("OUT-001 · CUST-9 · Today", substring = true)
        rule.onNodeWithTag("customer-search").performTextInput("sto nino")
        rule.onNodeWithTag("customer-count").assertTextContains("1 of 2 stores", substring = true)
        rule.onAllNodesWithTag("customer-result").assertCountEquals(1)
        rule.onAllNodesWithTag("customer-result")[0].assertTextContains("Tomorrow", substring = true).performClick()
        assertEquals(listOf("o2"), opened)
        rule.onNodeWithTag("customer-search").performTextReplacement("zzz")
        rule.onNodeWithTag("customer-no-match").assertTextContains("No store matches", substring = true)
    }

    @Test fun emptyDirectoryAsksForASync() {
        content { CustomerSearchScreen(TodayData(stale = false), onOpen = {}) }
        rule.onNodeWithTag("customer-count").assertTextContains("No stores on this phone")
        rule.onNodeWithTag("customer-empty").assertTextContains("Sync to download", substring = true)
    }

    @Test fun syncedEmptyDirectorySaysNothingIsPlannedInsteadOfAskingForASync() {
        content { CustomerSearchScreen(TodayData(stale = false, lastSynced = 1_790_000_000_000L), onOpen = {}) }
        rule.onNodeWithTag("customer-empty").assertTextContains("No stores on your plan", substring = true)
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
            .assertTextContains("Visits from this phone only", substring = true)
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

    /** FLD-052 (r4): the sample sheets carry only the store's own name; Summary must still say so. */
    @Test fun sheetWithOnlyTheStoreNameSaysNoAccountDetailsYet() {
        val bare = CustomerRecord("o3", "Sample Luz Sari-sari", "SMP-O0291", "SMP-C0291", "Cebu", 10.3, 123.9,
            account = CallSheetHeader("Sample Luz Sari-sari", null, null, null, null, null, null, null, null, null))
        content { CustomerDetailScreen(bare, data, onNavigate = { true }, onDial = { true }, onVisit = {}, visitEnabled = true, now = now) }
        rule.onNodeWithTag("customer-summary").performScrollTo()
            .assertTextContains("No account details yet", substring = true)
        val bmp = rule.onRoot().captureToImage().asAndroidBitmap()
        java.io.File(rule.activity.getExternalFilesDir(null), "FLD-052-summary.png").outputStream().use {
            bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
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

    @Test fun addStoreFabNeverCoversTheLastRowAndEmptySearchPrefillsTheName() {
        val many = (1..30).map { CustomerRecord("o$it", "Store %02d".format(it), "OUT-$it") }
        val added = mutableListOf<String>()
        content { CustomerSearchScreen(TodayData(stale = false, customers = many), onOpen = {}, now = now,
            onAddStore = { added += it }) }
        rule.onNodeWithTag("customer-list").performScrollToIndex(many.size + 1)
        rule.waitForIdle()
        val fab = rule.onNodeWithTag("customer-add-store-fab").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        val last = rule.onAllNodesWithTag("customer-result").fetchSemanticsNodes().maxBy { it.boundsInRoot.bottom }
        assertEquals("Store 30", last.config[androidx.compose.ui.semantics.SemanticsProperties.Text]
            .firstOrNull { it.text.startsWith("Store") }?.text)
        org.junit.Assert.assertTrue("FAB overlaps last row: fab=$fab row=${last.boundsInRoot}",
            fab.top >= last.boundsInRoot.bottom)
        rule.onNodeWithTag("customer-add-store-fab").assertContentDescriptionEquals("Add store")
        rule.onNodeWithTag("customer-add-store-fab").performClick()
        rule.onNodeWithTag("customer-list").performScrollToIndex(0)
        rule.onNodeWithTag("customer-search").performTextInput("Aling Nena")
        rule.onNodeWithTag("customer-add-store").assertTextContains("Add store").performClick()
        assertEquals(listOf("", "Aling Nena"), added)
    }

    @Test fun noAddStoreFabWithoutPermission() {
        content { CustomerSearchScreen(data, onOpen = {}, now = now) }
        rule.onNodeWithTag("customer-add-store-fab").assertDoesNotExist()
    }

    @Test fun longPressPicksStoresAndTapTogglesWhilePicking() {
        val opened = mutableListOf<String>()
        content { CustomerSearchScreen(data, onOpen = { opened += it }, now = now, onAddStore = {}) }
        rule.onNodeWithTag("select-bar").assertDoesNotExist()
        val rows = rule.onAllNodesWithTag("customer-result")
        rows[0].performTouchInput { longClick() }
        rule.onNodeWithTag("select-count").assertTextContains("1 selected")
        rows[0].assertIsSelected()
        rows[1].performClick() // tap adds while picking, never opens
        rule.onNodeWithTag("select-count").assertTextContains("2 selected")
        assertEquals(emptyList<String>(), opened)
        rule.onNodeWithText("Cancel").performClick()
        rule.onNodeWithTag("select-bar").assertDoesNotExist()
        rows[1].performClick()
        assertEquals(listOf("o2"), opened)
    }

    @Test fun detailHasAVisibleEditStoreButton() {
        var edits = 0
        content { CustomerDetailScreen(pena, data, onNavigate = { true }, onDial = { true }, now = now, onEdit = { edits++ }) }
        rule.onNodeWithTag("customer-edit").assertIsDisplayed().assertTextContains("Edit store").performClick()
        assertEquals(1, edits)
    }

    @Test fun detailHidesEditWithoutPermission() {
        content { CustomerDetailScreen(pena, data, onNavigate = { true }, onDial = { true }, now = now) }
        rule.onNodeWithTag("customer-edit").assertDoesNotExist()
    }

    @Test fun pendingChangeShowsOnTheStorePage() {
        content { CustomerDetailScreen(pena, data, onNavigate = { true }, onDial = { true }, now = now, onEdit = {},
            changeLabel = com.sunpride.field.census.CensusRules.CHANGE_WAITING) }
        rule.onNodeWithTag("customer-change-pending", useUnmergedTree = true).assertIsDisplayed()
            .assertTextContains("Change waiting for office")
    }

    @Test fun noPendingLabelWithoutAChange() {
        content { CustomerDetailScreen(pena, data, onNavigate = { true }, onDial = { true }, now = now, onEdit = {}) }
        rule.onNodeWithTag("customer-change-pending", useUnmergedTree = true).assertDoesNotExist()
    }

    @Test fun approvedOwnerAndPhoneShowAndCallDialsThem() {
        val opened = mutableListOf<String>()
        // A store with no account sheet: before, Call was disabled; the owner contact now enables it.
        val owned = nino.copy(ownerName = "New Owner", ownerPhone = "0917 555 0199")
        content { CustomerDetailScreen(owned, data, onNavigate = { true }, onDial = { opened += it; true }, now = now) }
        rule.onNodeWithTag("customer-summary").assertTextContains("New Owner", substring = true)
            .assertTextContains("0917 555 0199", substring = true)
        rule.onNodeWithTag("customer-call").assertIsEnabled().performClick()
        assertEquals(listOf("tel:09175550199"), opened)
    }

    @Test fun rejectedChangeSaysWhyOnTheStorePage() {
        content { CustomerDetailScreen(pena, data, onNavigate = { true }, onDial = { true }, now = now, onEdit = {},
            changeLabel = com.sunpride.field.census.CensusRules.notAccepted("Owner did not confirm")) }
        rule.onNodeWithTag("customer-change-pending", useUnmergedTree = true).assertIsDisplayed()
            .assertTextContains("Change not accepted: Owner did not confirm")
    }
}
