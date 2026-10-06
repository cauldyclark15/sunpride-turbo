package com.sunpride.van.ui

import android.content.Intent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import com.sunpride.van.MainActivity
import com.sunpride.van.data.VanRepository
import org.junit.Rule
import org.junit.Test

class MainActivityDeviceTest {
    @get:Rule val rule = createComposeRule()
    @Test fun launcherActivityUsesOnlyExplicitDebugFixtureIntent() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        WorkManager.getInstance(context).cancelUniqueWork("van-sales-sync-stub").result.get()
        context.deleteDatabase("van_stub_store.db")
        context.getSharedPreferences("van_fixture_backend",0).edit().clear().commit()
        val intent = Intent(context,MainActivity::class.java).putExtra(VanRepository.STUB_EXTRA,"ready")
        ActivityScenario.launch<MainActivity>(intent).use {
            rule.waitUntil(20_000) { rule.onAllNodesWithTag("trip-number").fetchSemanticsNodes().isNotEmpty() }
            rule.onNodeWithTag("trip-number").assertTextEquals("TRIP-20261007-V014-1")
            rule.onNodeWithTag("home-primary").assertTextContains("Check the load")
            rule.onNodeWithTag("open-customers").performScrollTo().performClick()
            rule.onNodeWithText("Today's route").assertExists()
        }
    }
}
