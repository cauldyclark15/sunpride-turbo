package com.sunpride.field

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.unit.Density
import com.sunpride.field.ui.FieldApp
import org.junit.Rule
import org.junit.Test

class FieldAppTest {
    @get:Rule val rule = createComposeRule()
    private val configured = AppEnvironment("https://team.convex.site", "https://team.convex.cloud")

    @Test fun shellAndPreview() {
        rule.setContent { FieldApp(configured, dark = false, debug = true) }
        rule.onNodeWithTag("shell-title").assertIsDisplayed()
        rule.onNodeWithTag("sync-status").assertIsDisplayed()
        rule.onNodeWithTag("email").assertExists()
        rule.onNodeWithTag("password").assertExists()
        rule.onNodeWithTag("sign-in").assertIsNotEnabled()
        rule.onNodeWithTag("sign-in-note").assertExists()
        rule.onNodeWithTag("design-tokens-link").performClick()
        rule.onNodeWithTag("design-tokens-screen").assertIsDisplayed()
        rule.onNodeWithTag("sync-status").assertIsDisplayed()
    }

    @Test fun darkAtDoubleFontScaleKeepsKeyNodes() {
        rule.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, 2f)) {
                FieldApp(configured, dark = true, debug = true)
            }
        }
        rule.onNodeWithTag("shell-title").assertIsDisplayed()
        rule.onNodeWithTag("sync-status").assertIsDisplayed()
        rule.onNodeWithTag("sign-in").assertExists().assertIsNotEnabled()
        rule.onNodeWithTag("design-tokens-link").assertExists()
    }

    @Test fun missingEndpointsShowVisibleError() {
        rule.setContent { FieldApp(AppEnvironment("", ""), dark = false, debug = true) }
        rule.onNodeWithTag("environment-error").assertIsDisplayed()
        rule.onNodeWithTag("sync-status").assertIsDisplayed()
    }
}
