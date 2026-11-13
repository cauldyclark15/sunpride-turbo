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
    scanner: com.sunpride.van.scanning.ScannerInput,
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
    run {
        if (camera) {
            CameraScanScreen(
                onCode = { scanner.inputs.cameraCode(it); camera = false },
                onClose = { camera = false },
                modifier = modifier,
            )
        } else Scaffold(modifier = modifier, containerColor = androidx.compose.ui.graphics.Color.Transparent, contentWindowInsets = WindowInsets.systemBars) { padding ->
            Column(
                Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                // POS v2: the same cards, pills and sentence-case copy as the rest of the app; the screen's tags are unchanged.
                com.sunpride.van.ui.SectionCard("Printer") {
                    Text("Connection: ${state.displayText()}", Modifier.testTag("printer-connection"), style = MaterialTheme.typography.titleSmall)
                    Text("Paper: ${paper?.let(PrinterWords::paper) ?: "Checking…"}", Modifier.testTag("printer-paper"))
                    Text("Last receipt: ${lastPrint ?: "None printed yet"}", Modifier.testTag("printer-last"))
                    details.forEachIndexed { index, line -> Text(line, Modifier.testTag("printer-detail-$index"), style = MaterialTheme.typography.bodyMedium) }
                    Text("${printer.capabilities.paperWidthMm} mm paper · ${printer.capabilities.charactersPerLine} characters a line" +
                        if (printer.capabilities.cutter) "" else " · tear the paper by hand", style = MaterialTheme.typography.bodyMedium)
                }
                com.sunpride.van.ui.PillButton(if (checking) "Checking…" else "Check printer", { scope.launch { check() } }, Modifier.testTag("check-printer"), enabled = !busy && !checking, filled = false)
                if (printer is SelectablePrinter) {
                    BluetoothPrinterSetup(printer, enabled = !busy && !checking, onChanged = { scope.launch { check() } })
                }
                com.sunpride.van.ui.PillButton(if (busy) "Printing…" else "Print test receipt",
                    {
                        scope.launch {
                            busy = true
                            try {
                                state = printer.connect()
                                val version = (state as? PrinterStatus.Ready)?.serviceVersion ?: "unavailable"
                                val outcome = if (state is PrinterStatus.Ready) printer.print(TestReceipts.build(deviceModel, version))
                                    else PrintResult.Error(state)
                                result = PrinterWords.testResult(outcome)
                                val d = printer.diagnostics(); state = d.status; paper = d.paper; details = d.details
                            } finally { busy = false }
                        }
                    }, Modifier.testTag("print-test"), enabled = !busy && !checking)
                result?.let { Text(it, style = MaterialTheme.typography.bodyLarge) }
                Text("Delivery receipt only. Not a BIR official receipt.", style = MaterialTheme.typography.bodyMedium)
                com.sunpride.van.ui.SectionCard("Scanner") {
                    Text("Last scanned code", style = MaterialTheme.typography.bodyMedium)
                    Text(scan?.code ?: "No scan yet", style = MaterialTheme.typography.titleSmall)
                    scan?.let { Text("Source: ${it.source.name.lowercase()}", style = MaterialTheme.typography.bodyMedium) }
                    WedgeScanField(scanner.inputs)
                }
                com.sunpride.van.ui.PillButton("Scan with camera", { camera = true }, filled = false)
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
