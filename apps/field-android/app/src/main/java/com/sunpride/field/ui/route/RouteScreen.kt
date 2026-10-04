package com.sunpride.field.ui.route

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.sunpride.field.ui.IconTile
import com.sunpride.field.ui.SecondaryButton
import com.sunpride.field.ui.SunprideTokens
import com.sunpride.field.ui.TodayData
import com.sunpride.field.ui.VisitDisplay
import com.sunpride.field.ui.diagnosticvisit.VisitLocation
import com.sunpride.field.ui.diagnosticvisit.captureOrNull
import kotlinx.coroutines.launch
import org.json.JSONObject

/** A fix is only used to show straight-line distance on screen; it is never queued or sent. */
fun positionOf(fix: JSONObject?): PhonePosition? {
    fix ?: return null
    val lat = fix.optDouble("latitude", Double.NaN)
    val lng = fix.optDouble("longitude", Double.NaN)
    if (!lat.isFinite() || !lng.isFinite() || lat !in -90.0..90.0 || lng !in -180.0..180.0) return null
    return PhonePosition(lat, lng)
}

/**
 * Daily route (AND-010): today's planned outlets in MCP order from the encrypted cache, so it
 * works with no signal. Each stop shows its state, distance from the phone's current fix, a
 * Navigate action (verified pin, else address) and the customer details/visit action.
 */
@Composable
fun RouteScreen(
    data: TodayData,
    location: VisitLocation,
    onNavigate: (String) -> Boolean,
    modifier: Modifier = Modifier,
    onVisit: (VisitDisplay) -> Unit = {},
    visitEnabled: Boolean = false,
    offline: Boolean = false,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var position by remember { mutableStateOf<PhonePosition?>(null) }
    var locating by remember { mutableStateOf(false) }
    var located by remember { mutableStateOf(false) }
    var navigationError by remember { mutableStateOf(false) }
    var expanded by rememberSaveable { mutableStateOf<String?>(null) }
    fun permitted() = !location.requiresPermission ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
    suspend fun locate() {
        locating = true
        try { position = positionOf(location.captureOrNull()) ?: position; located = true }
        finally { locating = false }
    }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        scope.launch { locate() }
    }
    // Never prompt on open: distance is a convenience. Use a fix silently when already allowed.
    LaunchedEffect(Unit) { if (permitted()) locate() }
    val route = DailyRoutes.build(data.visits, position)
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState())
        .padding(horizontal = 20.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(listOfNotNull(
            if (route.stops.isEmpty()) "No stops today" else "${route.done} of ${route.stops.size} done",
            "Saved on this phone".takeIf { offline || data.stale },
        ).joinToString(" · "), style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.testTag("route-summary"))
        if (route.stops.any { it.visit.latitude != null } && position == null) Row(
            Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(if (locating) "Finding your location…" else if (located) "Location unavailable" else "Distance needs location",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f).testTag("route-location"))
            SecondaryButton("Show distance", {
                if (permitted()) scope.launch { locate() } else launcher.launch(Manifest.permission.ACCESS_FINE_LOCATION)
            }, Modifier.testTag("route-locate"), enabled = !locating)
        }
        if (navigationError) Text("No maps app on this phone", color = MaterialTheme.colorScheme.error,
            style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("route-navigation-error"))
        if (route.stops.isEmpty()) Text("Sync to download today's plan", style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.testTag("route-empty"))
        route.stops.forEach { stop ->
            val key = stop.visit.plannedVisitId ?: "${stop.number}"
            StopCard(stop, expanded == key, onToggle = { expanded = if (expanded == key) null else key },
                onNavigate = { uri -> navigationError = !onNavigate(uri) },
                onVisit = onVisit.takeIf { visitEnabled })
        }
        Spacer(Modifier.height(16.dp))
    }
}

@Composable
private fun StopCard(stop: RouteStop, expanded: Boolean, onToggle: () -> Unit, onNavigate: (String) -> Unit,
    onVisit: ((VisitDisplay) -> Unit)?) {
    val visit = stop.visit
    val emphasis = stop.state == StopState.NEXT || stop.state == StopState.IN_PROGRESS
    Surface(Modifier.fillMaxWidth().testTag("route-stop"), shape = SunprideTokens.shapes.large,
        color = MaterialTheme.colorScheme.surface, tonalElevation = 0.dp,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = if (emphasis) 0.7f else 0.28f))) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}.testTag("route-stop-summary"),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                IconTile("${stop.number}")
                Column(Modifier.weight(1f)) {
                    Text(visit.outlet, style = MaterialTheme.typography.titleSmall, maxLines = 1,
                        overflow = TextOverflow.Ellipsis)
                    Text(listOfNotNull(stop.state.label,
                        stop.distanceMeters?.let { DailyRoutes.formatDistance(it) },
                        visit.timeSpent.takeIf { stop.state == StopState.DONE }).joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall,
                        fontWeight = if (emphasis) FontWeight.SemiBold else FontWeight.Normal,
                        color = if (stop.state == StopState.REVIEW) MaterialTheme.colorScheme.error
                            else MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            visit.address?.let { Text(it, style = MaterialTheme.typography.bodySmall, maxLines = if (expanded) 4 else 1,
                overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            if (expanded) Column(Modifier.semantics(mergeDescendants = true) {}.testTag("route-customer"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Fact("Outlet code", visit.outletCode ?: "Not sent")
                visit.customerCode?.let { Fact("Customer code", it) }
                if (visit.intents.isNotEmpty()) Fact("Planned", visit.intents.joinToString(", ") {
                    it.replace('_', ' ').replaceFirstChar { c -> c.uppercase() } })
                if (stop.navigationUri == null) Fact("Location", "No pin or address yet")
                else if (visit.latitude == null) Fact("Location", "Address only, no verified pin")
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SecondaryButton("Navigate", { stop.navigationUri?.let(onNavigate) },
                    Modifier.weight(1f).testTag("route-navigate"), enabled = stop.navigationUri != null)
                SecondaryButton(if (expanded) "Hide details" else "Customer", onToggle,
                    Modifier.weight(1f).testTag("route-customer-toggle"))
            }
            if (expanded && onVisit != null) SecondaryButton(
                if (stop.state == StopState.IN_PROGRESS) "Continue visit" else "Open visit", { onVisit(visit) },
                Modifier.fillMaxWidth().testTag("route-open-visit"))
        }
    }
}

@Composable
private fun Fact(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = MaterialTheme.typography.bodySmall)
        Text(value, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
