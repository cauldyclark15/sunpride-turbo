package com.sunpride.van.ui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import org.junit.Rule
import org.junit.Test

/** Lane 3: route-ops pickers show every option at once (no dropdown menu); tapping one picks it. */
class RouteOpsChoiceTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun everyOptionVisibleAndTapPicks() {
        rule.setContent {
            MaterialTheme(colorScheme = SunprideTokens.lightColors, typography = SunprideTokens.typography) {
                var v by remember { mutableStateOf("issue") }
                Column { Choice("Movement", v, listOf("issue" to "Issue to store", "receive" to "Receive from store", "count" to "Count at store")) { v = it } }
            }
        }
        listOf("issue", "receive", "count").forEach { rule.onNodeWithTag("choice-movement-$it").assertIsDisplayed() }
        rule.onNodeWithTag("choice-movement-issue").assertIsSelected()
        rule.onNodeWithTag("choice-movement-count").performClick().assertIsSelected()
        rule.onNodeWithTag("choice-movement-issue").assertIsNotSelected()
        captureVanScreenshot(rule,"lane3-route-choice")
    }
}
