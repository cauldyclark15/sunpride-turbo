package com.sunpride.field

import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.assertIsDisplayed
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Launches the real activity (live backend wiring, Keystore vault); makes no sign-in request. */
@RunWith(AndroidJUnit4::class)
class MainActivityTest {
    @get:Rule val rule = createAndroidComposeRule<MainActivity>()

    @Test fun launchesAndSurvivesRecreation() {
        rule.onNodeWithTag("shell-title").assertIsDisplayed()
        rule.activityRule.scenario.recreate()
        rule.onNodeWithTag("shell-title").assertIsDisplayed()
    }
}
