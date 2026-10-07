package com.sunpride.van.printing

import android.os.Build
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.sunpride.van.scanning.CameraScanScreen
import com.sunpride.van.scanning.ScanEvent
import com.sunpride.van.scanning.SenraiseScanner
import com.sunpride.van.scanning.WedgeScanField
import kotlinx.coroutines.launch

private val PrinterMonochrome = lightColorScheme(
    primary = Color.Black, onPrimary = Color.White, primaryContainer = Color(0xffeeeeee), onPrimaryContainer = Color.Black,
    secondary = Color.DarkGray, onSecondary = Color.White, secondaryContainer = Color.LightGray, onSecondaryContainer = Color.Black,
    tertiary = Color.Gray, onTertiary = Color.White, tertiaryContainer = Color.LightGray, onTertiaryContainer = Color.Black,
    background = Color.White, onBackground = Color.Black, surface = Color.White, onSurface = Color.Black,
    surfaceVariant = Color(0xffeeeeee), onSurfaceVariant = Color.DarkGray, surfaceTint = Color.Transparent,
    inverseSurface = Color.DarkGray, inverseOnSurface = Color.White, inversePrimary = Color.White,
    error = Color.DarkGray, onError = Color.White, errorContainer = Color.LightGray, onErrorContainer = Color.Black,
    outline = Color.Gray, outlineVariant = Color.LightGray, scrim = Color.Black,
    surfaceBright = Color.White, surfaceDim = Color.LightGray, surfaceContainer = Color(0xffeeeeee),
    surfaceContainerHigh = Color(0xffdddddd), surfaceContainerHighest = Color.LightGray,
    surfaceContainerLow = Color(0xfff5f5f5), surfaceContainerLowest = Color.White,
)

/** Standalone settings screen; navigation owner supplies and closes the printer/scanner.
 * This screen starts/stops the broadcast receiver with lifecycle and routes all scan modes to
 * the same deduplicating input bus. It creates no sale. Camera navigation is internal only.
 */
@Composable
fun PrinterTestScreen(
    printer: ReceiptPrinter,
    scanner: SenraiseScanner,
    modifier: Modifier = Modifier,
    deviceModel: String = Build.MODEL,
    /** VAN-017: the latest sale-receipt print result in this session, if any. */
    lastPrint: String? = null,
) {
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var state by remember(printer) { mutableStateOf<PrinterStatus>(PrinterStatus.Disconnected) }
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf<String?>(null) }
    var scan by remember { mutableStateOf<ScanEvent?>(null) }
    var camera by remember { mutableStateOf(false) }
    var paper by remember(printer) { mutableStateOf<PaperState?>(null) }
    var checking by remember { mutableStateOf(false) }
    var details by remember(printer) { mutableStateOf<List<String>>(emptyList()) }
    suspend fun check() {
        checking = true
        try { val d = printer.diagnostics(); state = d.status; paper = d.paper; details = d.details } finally { checking = false }
    }
    LaunchedEffect(printer) { check() }
    LaunchedEffect(scanner) { scanner.scans.collect { scan = it } }
    DisposableEffect(scanner, lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> scanner.start()
                Lifecycle.Event.ON_STOP -> scanner.stop()
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) scanner.start()
        onDispose { lifecycle.removeObserver(observer); scanner.stop() }
    }
    MaterialTheme(colorScheme = PrinterMonochrome) {
        if (camera) {
            CameraScanScreen(
                onCode = { scanner.inputs.cameraCode(it); camera = false },
                onClose = { camera = false },
                modifier = modifier,
            )
        } else Scaffold(modifier = modifier, contentWindowInsets = WindowInsets.systemBars) { padding ->
            Column(
                Modifier.fillMaxSize().padding(padding).padding(20.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                Text("Printer & scanner", style = MaterialTheme.typography.headlineSmall)
                Text("Printer check", style = MaterialTheme.typography.titleMedium)
                Text("Connection: ${state.displayText()}", Modifier.testTag("printer-connection"))
                Text("Paper: ${paper?.let(PrinterWords::paper) ?: "Checking…"}", Modifier.testTag("printer-paper"))
                Text("Last receipt: ${lastPrint ?: "None printed yet"}", Modifier.testTag("printer-last"))
                details.forEachIndexed { index, line -> Text(line, Modifier.testTag("printer-detail-$index")) }
                Text("${printer.capabilities.paperWidthMm} mm paper · ${printer.capabilities.charactersPerLine} characters a line" +
                    if (printer.capabilities.cutter) "" else " · tear the paper by hand")
                Button(
                    onClick = { scope.launch { check() } },
                    enabled = !busy && !checking,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("check-printer"),
                ) { Text(if (checking) "Checking…" else "Check printer") }
                if (printer is SelectablePrinter) {
                    BluetoothPrinterSetup(printer, enabled = !busy && !checking, onChanged = { scope.launch { check() } })
                }
                Button(
                    onClick = {
                        scope.launch {
                            busy = true
                            try {
                                state = printer.connect()
                                val version = (state as? PrinterStatus.Ready)?.serviceVersion ?: "unavailable"
                                val outcome = if (state is PrinterStatus.Ready) printer.print(TestReceipts.build(deviceModel, version))
                                    else PrintResult.Error(state)
                                result = when (outcome) {
                                    PrintResult.Success -> "Test receipt sent. Check the paper output."
                                    is PrintResult.Unsupported -> outcome.feature
                                    is PrintResult.Error -> "Print failed: ${outcome.status.displayText()}" +
                                        if (outcome.mayHavePrinted) " (may have partly printed; check paper)" else ""
                                }
                                val d = printer.diagnostics(); state = d.status; paper = d.paper; details = d.details
                            } finally { busy = false }
                        }
                    },
                    enabled = !busy && !checking,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("print-test"),
                ) { Text(if (busy) "Printing…" else "Print test receipt") }
                result?.let { Text(it) }
                Text("Delivery receipt only. Not a BIR official receipt.")
                Text("Last scanned code", style = MaterialTheme.typography.titleMedium)
                Text(scan?.code ?: "No scan yet")
                scan?.let { Text("Source: ${it.source.name.lowercase()}") }
                WedgeScanField(scanner.inputs)
                Button(onClick = { camera = true }, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
                    Text("Scan with camera")
                }
            }
        }
    }
}

private fun PrinterStatus.displayText(): String = when (this) {
    is PrinterStatus.Ready -> "Connected · service $serviceVersion"
    PrinterStatus.Unavailable -> "No printer available"
    PrinterStatus.ServiceMissing -> "Senraise printer service missing"
    PrinterStatus.Disconnected -> "Disconnected"
    PrinterStatus.Timeout -> "Connection timed out"
    PrinterStatus.PaperOut -> "Out of paper"
    is PrinterStatus.Failed -> message
    is PrinterStatus.NeedsSetup -> PrinterWords.setup(reason).replaceFirstChar { it.uppercase() }
}
