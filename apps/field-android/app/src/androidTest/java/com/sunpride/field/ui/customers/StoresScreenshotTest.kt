package com.sunpride.field.ui.customers

import android.graphics.Bitmap
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.field.storage.CallSheetHeader
import com.sunpride.field.ui.SunprideTokens
import com.sunpride.field.ui.TodayData
import com.sunpride.field.ui.VisitDisplay
import com.sunpride.field.ui.diagnosticvisit.VisitLocation
import org.json.JSONObject
import org.junit.Rule
import org.junit.Test
import java.io.File

/** Lane 1 evidence: 360dp screenshots of Stores, a picked row, Store detail, Route and More (files/cg-shots/lane1-*.png). */
class StoresScreenshotTest {
    @get:Rule val rule = createAndroidComposeRule<androidx.activity.ComponentActivity>()

    private val now = java.time.ZonedDateTime.parse("2026-11-09T09:00:00+08:00").toInstant().toEpochMilli()
    private val visits = (1..4).map { VisitDisplay("Store %02d Sari-Sari".format(it), "Planned", if (it == 1) "Done" else "Scheduled",
        "o$it", "p$it", listOf("sell"), sequence = it, outletCode = "OUT-$it", address = "$it Rizal Ave, Pasig") }
    private val stores = (1..12).map { CustomerRecord("o$it", "Store %02d Sari-Sari".format(it), "OUT-$it", address = "$it Rizal Ave, Pasig",
        today = visits.getOrNull(it - 1),
        account = CallSheetHeader("Store %02d".format(it), null, "Ana Cruz", "0917 123 4567", null, null, null, null, null, null)) }
    private val data = TodayData(visits, stale = false, customers = stores)
    private val noFix = object : VisitLocation { override suspend fun fix(): JSONObject? = null }

    private fun show(block: @Composable () -> Unit) = rule.setContent {
        MaterialTheme(colorScheme = SunprideTokens.lightColors) {
            Surface(Modifier.fillMaxSize().statusBarsPadding()) { block() }
        }
    }

    private fun shot(name: String) {
        rule.waitForIdle(); Thread.sleep(600)
        val bmp = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot() ?: return
        val dir = File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir, "cg-shots").apply { mkdirs() }
        File(dir, "lane1-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun storesList() { show { CustomerSearchScreen(data, onOpen = {}, now = now, onAddStore = {}) }; shot("stores") }

    @Test fun storesPicked() {
        show { CustomerSearchScreen(data, onOpen = {}, now = now, onAddStore = {}) }
        rule.onAllNodesWithTag("customer-result")[1].performTouchInput { longClick() }
        shot("stores-picked")
    }

    @Test fun storeDetail() {
        show { CustomerDetailScreen(stores[1], data, onNavigate = { true }, onDial = { true }, now = now, visitEnabled = true,
            onEdit = {}) }
        shot("store-detail")
    }

    @Test fun route() {
        show { com.sunpride.field.ui.route.RouteScreen(data, noFix, onNavigate = { true }, visitEnabled = true, onAddVisit = {}) }
        shot("route")
    }

    @Test fun more() {
        show { com.sunpride.field.ui.MoreScreen(com.sunpride.field.ui.syncstatus.SyncStatus(lastSuccess = now), now, {}, {}, {}, {}, {}, {}, {}, {},
            onCensus = {}, onTeam = {}, onJointCall = {}) }
        shot("more")
    }
}
