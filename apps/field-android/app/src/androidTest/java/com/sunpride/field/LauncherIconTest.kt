package com.sunpride.field

import android.graphics.drawable.AdaptiveIconDrawable
import android.os.Build
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** SP-0126: Sunpride logo as launcher icon, splash and sign-in brand on the installed app. */
@RunWith(AndroidJUnit4::class)
class LauncherIconTest {
    @get:Rule val rule = createAndroidComposeRule<MainActivity>()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test fun signInShowsTheLogo() {
        rule.onNodeWithTag("sign-in-logo").assertIsDisplayed().assertContentDescriptionEquals("Sunpride")
    }

    @Test fun launcherIconIsTheAdaptiveLogo() {
        val info = context.packageManager.getApplicationInfo(context.packageName, 0)
        assertEquals(R.mipmap.ic_launcher, info.icon)
        assertTrue(context.packageManager.getApplicationIcon(context.packageName) is AdaptiveIconDrawable)
    }

    @Test fun splashIsTheLogoRedAndTheActivityLeavesIt() {
        val red = context.getColor(R.color.sunpride_red)
        assertEquals(0xFFEE1C25.toInt(), red)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val attrs = context.obtainStyledAttributes(R.style.Theme_SunprideField_Starting,
                intArrayOf(android.R.attr.windowSplashScreenBackground))
            try { assertEquals(red, attrs.getColor(0, 0)) } finally { attrs.recycle() }
        }
        rule.activityRule.scenario.onActivity { activity ->
            val attrs = activity.theme.obtainStyledAttributes(intArrayOf(android.R.attr.windowBackground))
            try { assertNotEquals(R.drawable.splash_background, attrs.getResourceId(0, 0)) } finally { attrs.recycle() }
        }
    }
}
