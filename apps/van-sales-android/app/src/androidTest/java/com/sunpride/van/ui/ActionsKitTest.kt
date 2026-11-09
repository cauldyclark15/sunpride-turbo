package com.sunpride.van.ui

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Test-only list host: search-less list, Add button, long-press multi-select, fake bottom nav. */
@Composable
private fun KitHost(onAdd: () -> Unit = {}) {
    MaterialTheme(colorScheme = SunprideTokens.lightColors, typography = SunprideTokens.typography, shapes = SunprideTokens.shapes) {
        val selection = rememberSelection<String>()
        Scaffold(bottomBar = {
            NavigationBar(Modifier.testTag("fake-nav")) {
                listOf("Today", "Stores", "More").forEach { NavigationBarItem(selected = it == "Stores", onClick = {}, icon = {}, label = { Text(it) }) }
            }
        }) { padding ->
            Box(Modifier.fillMaxSize().padding(padding)) {
                Column(Modifier.fillMaxSize()) {
                    SelectBar(selection.count, listOf("Remove" to { selection.clear() }), onClear = { selection.clear() },
                        modifier = Modifier.padding(8.dp))
                    LazyColumn(contentPadding = PaddingValues(bottom = AddFabListPadding)) {
                        items(30) { i ->
                            val id = "s$i"
                            Text((if (id in selection) "✓ " else "") + "Store $i",
                                Modifier.fillMaxWidth().heightIn(min = 56.dp).selectableRow(selection, id) {}
                                    .padding(16.dp).testTag("row-$id"))
                        }
                    }
                }
                AddFab("Add store", onAdd)
            }
        }
    }
}

class ActionsKitTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private fun shot(name: String) {
        if (InstrumentationRegistry.getArguments().getString("kitShots") != "true") return
        rule.waitForIdle()
        val ui = InstrumentationRegistry.getInstrumentation().uiAutomation
        var bmp: Bitmap? = null
        repeat(5) { if (bmp == null) { bmp = ui.takeScreenshot(); if (bmp == null) Thread.sleep(250) } }
        val dir = File(InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null), "kit-shots").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { bmp!!.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun addFabIsVisibleAboveTheBottomNav() {
        var added = 0
        rule.setContent { KitHost(onAdd = { added++ }) }
        val fab = rule.onNodeWithTag("add-fab").assertIsDisplayed()
        rule.onNodeWithTag("add-fab").assertContentDescriptionEquals("Add store")
        val fabBox = fab.getUnclippedBoundsInRoot()
        val navBox = rule.onNodeWithTag("fake-nav").getUnclippedBoundsInRoot()
        assertTrue("FAB ${fabBox.bottom} overlaps nav ${navBox.top}", fabBox.bottom <= navBox.top)
        assertTrue("FAB shorter than 56dp", fabBox.bottom - fabBox.top >= 56.dp)
        shot("add-fab")
        fab.performClick()
        assertEquals(1, added)
    }

    @Test fun longPressShowsSelectBarAndCancelClears() {
        rule.setContent { KitHost() }
        rule.onNodeWithTag("select-bar").assertDoesNotExist()
        rule.onNodeWithTag("row-s1").performTouchInput { longClick() }
        rule.onNodeWithTag("select-bar").assertIsDisplayed()
        rule.onNodeWithText("1 selected").assertIsDisplayed()
        rule.onNodeWithTag("row-s2").performClick()
        rule.onNodeWithText("2 selected").assertIsDisplayed()
        rule.onNodeWithTag("select-action-Remove").assertIsDisplayed()
        shot("select-bar")
        rule.onNodeWithTag("select-cancel").performClick()
        rule.onNodeWithTag("select-bar").assertDoesNotExist()
    }
}
