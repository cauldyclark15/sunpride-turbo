package com.sunpride.van.ui

import android.graphics.Bitmap
import android.view.WindowInsets
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.AndroidComposeTestRule
import androidx.test.espresso.Espresso
import androidx.test.ext.junit.rules.ActivityScenarioRule
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import java.io.File

typealias VanComposeRule = AndroidComposeTestRule<ActivityScenarioRule<ComponentActivity>,ComponentActivity>

fun assertPrimaryClearance(rule: VanComposeRule, tag: String) {
    rule.waitForIdle()
    val node = rule.onNodeWithTag(tag).fetchSemanticsNode()
    val bounds = node.boundsInWindow
    val view = rule.activity.window.decorView
    val insets = view.rootWindowInsets.getInsets(WindowInsets.Type.systemBars())
    val density = rule.activity.resources.displayMetrics.density
    assertTrue("$tag intrudes into status bar: $bounds",bounds.top >= insets.top)
    assertTrue("$tag intrudes into navigation bar: $bounds vs ${view.height-insets.bottom}",bounds.bottom <= view.height-insets.bottom+1)
    assertTrue("$tag is shorter than 56dp: $bounds",bounds.height >= 56*density-1)
    assertTrue("$tag extends beyond screen width: $bounds",bounds.left >= 0 && bounds.right <= view.width)
}

/** No socket/host dependency. TARGET context path, full display including both system bars. */
fun captureVanScreenshot(rule: VanComposeRule, name: String, primaryTag: String? = null) {
    runCatching { Espresso.closeSoftKeyboard() }
    rule.waitForIdle()
    InstrumentationRegistry.getInstrumentation().waitForIdleSync()
    Thread.sleep(450)
    primaryTag?.let { assertPrimaryClearance(rule,it) }
    val target = InstrumentationRegistry.getInstrumentation().targetContext
    val dir = File(checkNotNull(target.getExternalFilesDir(null)),"van-pos-shots").also { check(it.exists() || it.mkdirs()) }
    val shot = checkNotNull(InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot())
    assertEquals("H10P full display width",720,shot.width)
    assertEquals("H10P full display height",1440,shot.height)
    File(dir,"$name.png").outputStream().use { check(shot.compress(Bitmap.CompressFormat.PNG,100,it)) }
    shot.recycle()
}
