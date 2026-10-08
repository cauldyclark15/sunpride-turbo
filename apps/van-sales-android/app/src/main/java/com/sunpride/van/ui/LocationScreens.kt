package com.sunpride.van.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import com.sunpride.van.location.LocationConsentText
import com.sunpride.van.location.SharingRules
import com.sunpride.van.location.SharingState
import com.sunpride.van.location.locationSettingsIntent

/**
 * SP-0137: the one-time location consent (Data Privacy Act, RA 10173): what is collected, when, who sees it and
 * for how long. Shown before the first Start trip and from Today's "Location sharing" row. Agreeing asks Android
 * for the location permission; "Not now" still starts the trip, without sharing.
 */
@Composable fun LocationConsentScreen(c: VanController) {
    val context = LocalContext.current
    val permissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { c.finishLocationConsent() }
    val agree = {
        c.acceptLocationSharing()
        val missing = c.locationSharing.missingPermissions()
        if (missing.isEmpty()) c.finishLocationConsent() else permissions.launch(missing.toTypedArray())
    }
    val on = c.locationConsented
    ScreenFrame(LocationConsentText.TITLE,c::back,action = if (on && c.sharing != SharingState.NEEDS_PERMISSION) "Done" else "Turn on location sharing",
        actionTag = "location-agree",enabled = !c.busy,onAction = { if (on && c.sharing != SharingState.NEEDS_PERMISSION) c.finishLocationConsent() else agree() },message = c.message) {
        Text("Sunpride Van shares where the truck is during your trip, so your supervisor can see it on the live map.",
            style = MaterialTheme.typography.titleMedium,modifier = Modifier.testTag("location-consent-intro"))
        SectionCard("What you are agreeing to") {
            LocationConsentText.POINTS.forEachIndexed { i,point -> Text(point,style = MaterialTheme.typography.bodyLarge,modifier = Modifier.testTag("location-point-$i")) }
        }
        if (c.sharing != SharingState.NOT_ON_TRIP) SectionCard("Right now") {
            Text(SharingRules.label(c.sharing),style = MaterialTheme.typography.titleMedium,modifier = Modifier.testTag("location-state"))
            Text(SharingRules.detail(c.sharing),style = MaterialTheme.typography.bodyMedium)
        }
        if (on && c.sharing == SharingState.NEEDS_PERMISSION) ListRow("Open settings","Allow location for Sunpride Van, or turn location on","location-settings",
            onClick = { runCatching { context.startActivity(locationSettingsIntent(context,c.locationSharing.missingPermissions().isNotEmpty())) } })
        if (on) SecondaryButton("Turn off location sharing",c::withdrawLocationSharing,Modifier.testTag("location-withdraw"),!c.busy)
        else SecondaryButton("Not now",c::finishLocationConsent,Modifier.testTag("location-not-now"),!c.busy)
    }
}

/** Today's indicator while the trip is on the road: "Location sharing on" / "off" with what to do. */
@Composable fun LocationSharingRow(c: VanController) {
    if (!c.locationSharing.enabled || c.sharing == SharingState.NOT_ON_TRIP) return
    val waiting = if (c.pendingPings > 0 && c.sharing == SharingState.ON) " · ${c.pendingPings} waiting to send" else ""
    ListRow(SharingRules.label(c.sharing),SharingRules.detail(c.sharing)+waiting,"location-sharing",onClick = c::openLocationSharing)
}
