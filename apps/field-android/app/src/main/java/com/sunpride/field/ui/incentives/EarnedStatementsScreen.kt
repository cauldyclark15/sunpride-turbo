package com.sunpride.field.ui.incentives

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.sunpride.field.ui.FieldBackend
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Online-only personal financial view. Nothing persists to disk, saved-state or an offline cache. */
@Composable
fun EarnedStatementsScreen(backend: FieldBackend?, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var resumed by remember { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
    var refresh by remember { mutableIntStateOf(0) }
    var rows by remember { mutableStateOf<List<EarnedStatement>>(emptyList()) }
    var message by remember { mutableStateOf("Connect to view your current earned statements.") }
    val epoch = backend?.authorizationEpoch
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) resumed = true
            if (event == Lifecycle.Event.ON_PAUSE) { resumed = false; rows = emptyList() }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(backend, epoch, resumed, refresh) {
        rows = emptyList()
        if (!resumed || backend == null) return@LaunchedEffect
        message = "Loading your current statements…"
        val result = withContext(Dispatchers.IO) { runCatching { backend.earnedStatements() } }
        if (backend.authorizationEpoch != epoch || !backend.isSignedIn) {
            message = "Your access changed. Sign in and refresh."
            return@LaunchedEffect
        }
        rows = result.getOrDefault(emptyList())
        message = if (result.isFailure) "Connect and refresh. If access was removed, ask your manager."
            else if (rows.isEmpty()) "No earned statements yet." else ""
    }
    Column(modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Your results", style = MaterialTheme.typography.titleMedium, modifier = Modifier.testTag("earned-statements"))
        Text("Your own results only. Calculated or approved earnings are not proof of payment; SAP remains the payout authority.")
        if (message.isNotEmpty()) Text(message)
        rows.forEach { row ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(row.name, style = MaterialTheme.typography.titleMedium)
                    Text(row.period + " · " + row.status + if (row.sample) " · Sample plan" else "")
                    Text(EarnedStatements.money(row.amountMinor), style = MaterialTheme.typography.headlineSmall)
                    row.metrics.forEach { line ->
                        Text(line.name + ": " + if (line.excluded) "Excluded by plan" else
                            "${line.actual} / ${line.target} → ${EarnedStatements.money(line.amountMinor)}")
                    }
                }
            }
        }
        OutlinedButton(onClick = { refresh++ }, modifier = Modifier.fillMaxWidth().testTag("earned-refresh")) { Text("Refresh online") }
        Spacer(Modifier.height(16.dp))
    }
}
