package com.sunpride.field

import android.graphics.Bitmap
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.ui.unit.dp
import androidx.compose.material3.Text
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.field.auth.EnrollmentState
import com.sunpride.field.ui.AccountGlyph
import com.sunpride.field.ui.AccountScreen
import com.sunpride.field.ui.DeviceKeyInfo
import com.sunpride.field.ui.EnrollmentScreen
import com.sunpride.field.ui.FieldApp
import com.sunpride.field.ui.FieldBackend
import com.sunpride.field.ui.SunprideTokens
import com.sunpride.field.ui.StatusPill
import com.sunpride.field.ui.TodayData
import com.sunpride.field.ui.TodayScreen
import com.sunpride.field.ui.VisitDisplay
import com.sunpride.field.ui.syncstatus.SyncDetails
import com.sunpride.field.ui.syncstatus.SupportDetails
import com.sunpride.field.ui.syncstatus.SyncStatus
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileOutputStream

@RunWith(AndroidJUnit4::class)
class CalmScreenshotsTest {
    @get:Rule val rule = createAndroidComposeRule<androidx.activity.ComponentActivity>()
    private val environment = AppEnvironment("https://team.convex.site", "https://team.convex.cloud")
    private val backend = object : FieldBackend {
        override val isSignedIn = false
        override fun loadSigner(): com.sunpride.field.device.DeviceSigner = error("No sign-in in screenshot")
        override fun signIn(email: String, password: String) = Unit
        override fun signOut() = Unit
        override fun refreshEnrollment(signer: com.sunpride.field.device.DeviceSigner) = EnrollmentState.SignedOut
    }

    @Test fun lightAndDarkStates() {
        var scene by mutableIntStateOf(0)
        var night by mutableIntStateOf(0)
        val names = listOf("sign-in", "waiting", "today", "sync-details", "removed", "account", "support-info")
        val status = SyncStatus(queued = 1, review = 1, health = "synced", lastSuccess = System.currentTimeMillis() - 7_200_000,
            leaseExpiresAt = System.currentTimeMillis() + 86_400_000, cacheExpiresAt = System.currentTimeMillis() + 86_400_000)
        rule.setContent {
            MaterialTheme(colorScheme = if (night == 1) SunprideTokens.darkColors else SunprideTokens.lightColors,
                shapes = SunprideTokens.shapes, typography = SunprideTokens.typography) {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    if (scene == 0) FieldApp(environment, night == 1, debug = false, backend = backend)
                    else Column {
                        Surface(color = MaterialTheme.colorScheme.surface, modifier = Modifier.statusBarsPadding()) {
                            Row(Modifier.fillMaxWidth().height(48.dp)
                                .padding(horizontal = 20.dp),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                                if (scene == 3 || scene == 5 || scene == 6) Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                                    androidx.compose.material3.IconButton(onClick = {}) { Text("‹", style = MaterialTheme.typography.titleLarge) }
                                    Text(when (scene) { 3 -> "Sync"; 5 -> "Account"; else -> "Support info" },
                                        style = MaterialTheme.typography.titleMedium)
                                } else Text("Sunpride Field", style = MaterialTheme.typography.titleMedium)
                                if (scene == 2 || scene == 3 || scene == 5 || scene == 6) Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                                    StatusPill(if (scene == 3) "1 to review" else "1 waiting")
                                    androidx.compose.material3.IconButton(onClick = {}) { AccountGlyph() }
                                }
                            }
                        }
                        Box(Modifier.weight(1f)) {
                            when (scene) {
                        1 -> EnrollmentScreen(EnrollmentState.Unregistered,
                            DeviceKeyInfo("MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEoZpcqRbe77Qr9ldcXhm7xuPYXFrVaALJKbV6bxLq0jfKF5XOw", "A4:98:11:47:BC:16", "Hardware"),
                            false, null, {}, {})
                        2 -> TodayScreen(TodayData(visits = listOf(
                            VisitDisplay("East Market", "Planned", "Scheduled"),
                            VisitDisplay("North Grocery", "Planned", "Queued"),
                            VisitDisplay("River Foods", "Planned", "Scheduled")),
                            stale = false, queuedCount = 1, syncStatus = status.copy(review = 0)), false, {}, {})
                        3 -> SyncDetails(status, onDismiss = {})
                        4 -> EnrollmentScreen(EnrollmentState.Removed, null, false, null, {}, {}, unsent = 2)
                        5 -> AccountScreen(DeviceKeyInfo("", "A4:98:11:47:BC:16", "Hardware"), {}, {})
                        else -> SupportDetails(status, {})
                    }
                        }
                    }
                }
            }
        }
        for (theme in 0..1) for (index in names.indices) {
            rule.runOnUiThread {
                night = theme; scene = index
                androidx.core.view.WindowCompat.getInsetsController(rule.activity.window,
                    rule.activity.window.decorView).isAppearanceLightStatusBars = theme == 0
            }
            rule.waitForIdle()
            Thread.sleep(350)
            captureCalmScreenshot("${if (theme == 0) "light" else "dark"}-${names[index]}")
        }
    }
}
