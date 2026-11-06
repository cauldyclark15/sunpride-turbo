package com.sunpride.van.ui

import android.content.Intent
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.core.net.toUri
import java.time.ZoneId

/** IP-P0: the sentence plus Call (opens the dialer) and Sync now. [what] is "No trip" or "No load sheet". */
@Composable fun NoTripPanel(c: VanController, what: String, tag: String) {
    val sentence = NoTripMessage.sentence(what,c.policy?.handheld,c.sync.lastSyncTime,System.currentTimeMillis(),ZoneId.systemDefault())
    Text(sentence,style = MaterialTheme.typography.titleLarge,modifier = Modifier.testTag(tag))
    CallSupervisorButton(c,"$tag-call")
    SecondaryButton(if (c.busy) "Syncing…" else "Sync now",c::syncNow,Modifier.testTag("$tag-sync"),enabled = !c.busy)
}

/** Opens the dialer on the supervisor's number (never calls by itself); disabled while the number is not on the handheld. */
@Composable fun CallSupervisorButton(c: VanController, tag: String) {
    val dial = NoTripMessage.dialUri(c.policy?.handheld?.supervisorPhone)
    val context = LocalContext.current
    SecondaryButton(if (dial != null) "Call supervisor" else "Call supervisor (number not on this handheld yet)",
        { runCatching { context.startActivity(Intent(Intent.ACTION_DIAL,dial!!.toUri()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } },
        Modifier.testTag(tag),enabled = dial != null)
}
