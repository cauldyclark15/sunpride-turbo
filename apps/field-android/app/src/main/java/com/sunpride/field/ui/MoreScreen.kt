package com.sunpride.field.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.sunpride.field.BuildConfig
import com.sunpride.field.ui.syncstatus.SyncStatus

/**
 * More: everything that is not a daily tab, in three plain groups. Each row opens the screen that used to hang off Today
 * or Account, so nothing is lost. Rows whose feature is off for this build or role are simply absent.
 */
@Composable
fun MoreScreen(
    status: SyncStatus, now: Long, onSync: () -> Unit, onAccount: () -> Unit, onSupport: () -> Unit,
    onCatalogue: () -> Unit, onWorkforce: () -> Unit, onCollections: () -> Unit, onIncentives: () -> Unit,
    onSignOut: () -> Unit, modifier: Modifier = Modifier,
    onCensus: (() -> Unit)? = null, onJointCall: (() -> Unit)? = null, onTeam: (() -> Unit)? = null,
    onBatteryGuide: (() -> Unit)? = null, onReportIssue: (() -> Unit)? = null,
) {
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Group("Your work") {
            ListRow("Products", "Search and scan. Works offline", "box",
                Modifier.testTag("catalogue-open"), onClick = onCatalogue)
            if (onCensus != null) { Rule(); ListRow("Add customer", "Works offline",
                "shop", Modifier.testTag("census-open"), onClick = onCensus) }
            Rule(); ListRow("Attendance", "Time in and out, prospects", "clock",
                Modifier.testTag("workforce-open"), onClick = onWorkforce)
            Rule(); ListRow("Collections", "Payments to collect", "cash",
                Modifier.testTag("collections-open"), onClick = onCollections)
            if (onJointCall != null) { Rule(); ListRow("Work-With & coaching", "Ride-along visits and coaching notes", "person",
                Modifier.testTag("jointcall-open"), onClick = onJointCall) }
            if (onTeam != null) { Rule(); ListRow("Your team", "Who is on route today", "team",
                Modifier.testTag("team-open"), onClick = onTeam) }
            Rule(); ListRow("Earned statements", "Your results. Needs signal", "list",
                Modifier.testTag("earned-statements-open"), onClick = onIncentives)
        }
        Group("This phone") {
            val label = status.label(now)
            ListRow("Sync", label, "sync", Modifier.testTag("more-sync"), onClick = onSync)
            if (onBatteryGuide != null) { Rule(); ListRow("Keep location sharing on", "Battery and background settings", "battery",
                Modifier.testTag("more-battery"), onClick = onBatteryGuide) }
        }
        Group("Account and help") {
            ListRow("Account", "Fingerprint, password, phone", "person",
                Modifier.testTag("more-account"), onClick = onAccount)
            Rule(); ListRow("Support info", "App version for the team", "info",
                Modifier.testTag("more-support"), onClick = onSupport)
            if (onReportIssue != null) { Rule(); ListRow("Report an issue", "Tell us what went wrong", "chat",
                Modifier.testTag("more-report"), onClick = onReportIssue) }
        }
        SecondaryButton("Sign out", onSignOut, Modifier.fillMaxWidth().testTag("more-sign-out"), danger = true)
        Spacer(Modifier.height(0.dp))
        Text("Sunpride Field ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
    }
}

@Composable
private fun Group(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionTitle(title)
        LookCard { content() }
    }
}

@Composable
private fun Rule() = HorizontalDivider(Modifier.padding(start = 68.dp), color = Look.hairline.copy(alpha = 0.7f))
