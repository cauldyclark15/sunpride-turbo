package com.sunpride.field.ui.location

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.sunpride.field.location.EndReason
import com.sunpride.field.location.WorkDayView
import com.sunpride.field.ui.PrimaryBottomButton
import com.sunpride.field.ui.SecondaryButton
import com.sunpride.field.ui.SectionCard
import com.sunpride.field.ui.StatusPill
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.util.Locale

/** What Start day asks Android for: location while in use (+ notifications on Android 13+ for the ongoing notice). */
object LocationPermissionRequest {
    fun permissions(sdk: Int = android.os.Build.VERSION.SDK_INT): Array<String> = buildList {
        add(android.Manifest.permission.ACCESS_FINE_LOCATION); add(android.Manifest.permission.ACCESS_COARSE_LOCATION)
        if (sdk >= 33) add(android.Manifest.permission.POST_NOTIFICATIONS)
    }.toTypedArray()
}

/** Plain wording for the Today work-day card (pure, unit-tested). */
object WorkDayCopy {
    private val clock = DateTimeFormatter.ofPattern("h:mm a", Locale.ENGLISH)
    fun time(ms: Long): String = Instant.ofEpochMilli(ms).atZone(com.sunpride.field.location.WorkHours.zone).format(clock)

    fun status(view: WorkDayView): String = when {
        view.sharing -> "Location sharing on since ${view.startedAt?.let(::time) ?: "today"}"
        view.started && !view.locationAllowed -> "Location off — your supervisor's map shows you as location off"
        !view.withinHours -> "Location sharing runs from 5 AM until the 10 PM close"
        view.endReason == EndReason.END_DAY -> "Day ended — location sharing off"
        view.endReason == EndReason.DAILY_CLOSE -> "Stopped at the 10 PM close"
        else -> "Location sharing off — starts with Start day or your first visit"
    }

    /** Top-bar indicator text, or null when nothing should show. */
    fun indicator(view: WorkDayView): String? = when {
        view.sharing -> "Location sharing on"
        view.started && !view.locationAllowed -> "Location off"
        else -> null
    }
}

@Composable
fun LocationIndicator(view: WorkDayView, modifier: Modifier = Modifier) {
    val label = WorkDayCopy.indicator(view) ?: return
    StatusPill(label, modifier.testTag("location-indicator"), warning = !view.sharing)
}

@Composable
fun WorkDayCard(view: WorkDayView, busy: Boolean, onStart: () -> Unit, onEnd: () -> Unit,
    onAllowLocation: () -> Unit, modifier: Modifier = Modifier) {
    if (!view.available) return
    SectionCard("Work day", modifier.testTag("work-day")) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(WorkDayCopy.status(view), style = MaterialTheme.typography.bodyMedium,
                color = if (view.started && !view.locationAllowed) MaterialTheme.colorScheme.error
                    else MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.testTag("work-day-status"))
            when {
                view.started -> {
                    if (!view.locationAllowed) SecondaryButton("Allow location", onAllowLocation,
                        Modifier.fillMaxWidth().testTag("work-day-allow"), !busy)
                    SecondaryButton("End day", onEnd, Modifier.fillMaxWidth().testTag("work-day-end"), !busy)
                }
                else -> PrimaryBottomButton("Start day", onStart, Modifier.testTag("work-day-start"),
                    !busy && view.withinHours)
            }
        }
    }
}

/**
 * The one-time consent (Data Privacy Act, RA 10173): what is collected, when, and who sees it.
 * Nothing is recorded until the person agrees; declining keeps every other part of the app working.
 */
@Composable
fun LocationConsentScreen(onAgree: () -> Unit, onDecline: () -> Unit, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 16.dp)) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("Share your location during work", style = MaterialTheme.typography.headlineMedium,
                modifier = Modifier.testTag("location-consent-title"))
            ConsentSection("What we collect", "Your phone's position, how accurate it is, your speed and direction, " +
                "the battery level, the time, and whether the position came from a fake-location app.")
            ConsentSection("When", "Only during your work day: from Start day or your first visit, until you tap " +
                "End day, sign out, or the 10 PM daily close. Never outside 5 AM to 10 PM, and never on days you " +
                "don't start. A notification stays on screen the whole time sharing is on.")
            ConsentSection("Who sees it", "Your supervisors and managers in your area see it on the Sunpride live map; " +
                "office analysts can view it but not change it. It is not shared outside Sunpride.")
            ConsentSection("How long", "Positions are kept for 90 days, then deleted automatically.")
            ConsentSection("Your choice", "If you don't agree, or you turn location off, the app keeps working. " +
                "Your supervisor's map shows you as location off. You can change this later in your phone's Settings.")
            Text("Under the Data Privacy Act of 2012 you may ask Sunpride to see or correct your location records.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.height(12.dp))
        SecondaryButton("Not now", onDecline, Modifier.fillMaxWidth().testTag("location-consent-decline"))
        Spacer(Modifier.height(8.dp))
        PrimaryBottomButton("I agree", onAgree, Modifier.testTag("location-consent-agree"))
    }
}

@Composable
private fun ConsentSection(title: String, body: String) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(title, style = MaterialTheme.typography.titleSmall)
        Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** Android 10+: "Allow all the time" is optional and explained before Android's own Settings page. */
@Composable
fun BackgroundLocationScreen(onOpenSettings: () -> Unit, onSkip: () -> Unit, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 16.dp)) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("Keep sharing when the app is closed", style = MaterialTheme.typography.headlineMedium,
                modifier = Modifier.testTag("location-background-title"))
            Text("Sharing already works while the Sunpride notification is showing. If Android closes the app " +
                "to save memory, \"Allow all the time\" lets sharing continue until your day ends.",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text("On the next screen choose Location → Allow all the time. The same work-day limits apply: " +
                "nothing is shared before Start day, after End day or sign-out, or after 10 PM.",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.height(12.dp))
        SecondaryButton("Not now", onSkip, Modifier.fillMaxWidth().testTag("location-background-skip"))
        Spacer(Modifier.height(8.dp))
        PrimaryBottomButton("Open settings", onOpenSettings, Modifier.testTag("location-background-settings"))
    }
}
