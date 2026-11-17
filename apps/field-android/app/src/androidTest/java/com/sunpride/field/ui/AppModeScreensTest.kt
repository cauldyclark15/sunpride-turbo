package com.sunpride.field.ui

import android.graphics.Bitmap
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.field.ui.mapping.MappingHomeScreen
import com.sunpride.field.ui.mapping.MappingSave
import com.sunpride.field.ui.syncstatus.SyncStatus
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import java.io.File

/**
 * SP-0195: each App mode's bar (never more than four tabs, Messages in the top bar with its unread badge), the Customer
 * mapping Home, and the owner's Switch mode. Each screen is also saved as a PNG (practice data, no server) under the
 * app's files/sp195 folder for the visual review.
 */
class AppModeScreensTest {
    @get:Rule val rule = createComposeRule()

    private fun save(name: String) {
        val dir = File(InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null), "sp195").apply { mkdirs() }
        rule.waitForIdle()
        val bitmap = com.sunpride.field.captureUiScreenshot()
        File(dir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Composable
    private fun Phone(mode: AppMode, title: String, unread: Int, content: @Composable (Modifier) -> Unit) {
        MaterialTheme(colorScheme = SunprideTokens.lightColors, shapes = SunprideTokens.shapes, typography = SunprideTokens.typography) {
            Scaffold(containerColor = MaterialTheme.colorScheme.background, topBar = {
                FieldHeader(title, subtitle = "Wed, Nov 18", actions = {
                    HeaderMessagesButton(unread, {})
                    HeaderRoundButton(GlyphKind.PERSON, "Account", {})
                }, below = { StatusPill(SyncStatus.waitingToSend(2), good = false, onClick = {}) })
            }, bottomBar = {
                val tabs = FieldNav.tabs(mode)
                FieldBottomBar(tabs.first(), onSelect = {}, tabs = tabs)
            }) { padding -> content(Modifier.padding(padding)) }
        }
    }

    private val now = System.currentTimeMillis()
    private val saves = listOf(
        MappingSave("Aling Nena Sari-Sari Store", "San Isidro", sent = false, savedAt = now - 5 * 60_000),
        MappingSave("JM Mini Mart", "Poblacion", sent = false, savedAt = now - 40 * 60_000),
        MappingSave("Tindahan ni Mang Ben", "Bagong Silang", sent = true, savedAt = now - 2 * 3600_000),
        MappingSave("Rosario Grocery", "San Roque", sent = true, savedAt = now - 26 * 3600_000),
        MappingSave("Lucky 8 Store", null, sent = true, savedAt = now - 50 * 3600_000),
    )

    @Test fun mappingModeShowsHomeCustomersMoreAndTheBigAddCustomerButton() {
        var added = 0
        rule.setContent {
            Phone(AppMode.MAPPING, "Home", unread = 3) { m ->
                MappingHomeScreen(saves, now, onAddCustomer = { added++ }, modifier = m)
            }
        }
        for (tab in listOf(FieldTab.HOME, FieldTab.STORES, FieldTab.MORE)) rule.onNodeWithTag(tab.tag).assertIsDisplayed()
        for (tab in listOf(FieldTab.TODAY, FieldTab.ROUTE, FieldTab.SELL, FieldTab.MESSAGES)) rule.onNodeWithTag(tab.tag).assertDoesNotExist()
        rule.onNodeWithTag("messages-badge", useUnmergedTree = true).assertIsDisplayed()
        rule.onNodeWithContentDescription("Messages, 3 unread").assertIsDisplayed()
        rule.onNodeWithTag("mapping-recent-0").assertIsDisplayed()
        save("01-mapping-home")
        // The fifth saved customer is reachable by scrolling and clears the bottom bar.
        rule.onNodeWithTag("mapping-recent-4").performScrollTo().assertIsDisplayed()
        save("01b-mapping-home-scrolled")
        rule.onNodeWithTag("mapping-add-customer").performClick()
        assertEquals(1, added)
    }

    @Test fun mappingHomeWhenNothingIsSavedYet() {
        rule.setContent { Phone(AppMode.MAPPING, "Home", unread = 0) { m -> MappingHomeScreen(emptyList(), now, {}, m) } }
        rule.onNodeWithTag("mapping-count-today", useUnmergedTree = true).assertTextEquals("0")
        rule.onNodeWithTag("mapping-recent-empty", useUnmergedTree = true).assertIsDisplayed()
        rule.onNodeWithTag("messages-badge", useUnmergedTree = true).assertDoesNotExist()
        save("02-mapping-home-empty")
    }

    @Test fun visitsAndSellingBarsHaveFourTabs() {
        var mode by mutableStateOf(AppMode.VISITS)
        rule.setContent {
            Phone(mode, "Today", unread = 12) { m -> Box(m.fillMaxSize().padding(16.dp)) { Text("Today", Modifier.testTag("body")) } }
        }
        for (tab in listOf(FieldTab.TODAY, FieldTab.ROUTE, FieldTab.STORES, FieldTab.MORE)) rule.onNodeWithTag(tab.tag).assertIsDisplayed()
        rule.onNodeWithTag(FieldTab.SELL.tag).assertDoesNotExist()
        save("03-visits-bar")
        mode = AppMode.SELLING
        rule.waitForIdle()
        for (tab in listOf(FieldTab.TODAY, FieldTab.SELL, FieldTab.STORES, FieldTab.MORE)) rule.onNodeWithTag(tab.tag).assertIsDisplayed()
        rule.onNodeWithTag(FieldTab.ROUTE.tag).assertDoesNotExist()
        save("04-selling-bar")
    }

    @Test fun switchModeShowsOnlyWithMoreThanOneMode() {
        var picked: AppMode? = null
        var modes by mutableStateOf(listOf(AppMode.MAPPING))
        rule.setContent {
            Phone(AppMode.SELLING, "More", unread = 0) { m ->
                MoreScreen(SyncStatus(), now, {}, {}, {}, {}, {}, {}, {}, {}, modifier = m,
                    modes = modes, mode = AppMode.SELLING, onSwitchMode = { picked = it })
            }
        }
        rule.onNodeWithTag("more-switch-mode").assertDoesNotExist()
        modes = AppMode.entries.toList()
        rule.waitForIdle()
        rule.onNodeWithTag("more-switch-mode").assertIsDisplayed()
        save("05-more-switch-mode")
        rule.onNodeWithTag("more-switch-mode").performClick()
        rule.onNodeWithTag("switch-mode-dialog").assertIsDisplayed()
        save("06-switch-mode-dialog")
        rule.onNodeWithTag("switch-mode-mapping").performClick()
        assertEquals(AppMode.MAPPING, picked)
        rule.onNodeWithTag("switch-mode-dialog").assertDoesNotExist()
    }
}
