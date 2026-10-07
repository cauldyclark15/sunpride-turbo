package com.sunpride.van.printing

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.sunpride.van.printing.escpos.BluetoothPrinters
import com.sunpride.van.printing.escpos.PairedPrinter
import com.sunpride.van.printing.escpos.PrinterChoice
import kotlinx.coroutines.launch

/**
 * VAN-015: choose which printer the app uses. Pairing happens in Android's Bluetooth settings; this lists
 * the paired devices, remembers the chosen one and its paper width, and can switch back to the built-in printer.
 */
@Composable
fun BluetoothPrinterSetup(printer: SelectablePrinter, enabled: Boolean, onChanged: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var choice by remember(printer) { mutableStateOf(printer.choice) }
    var picking by remember { mutableStateOf(false) }
    var paired by remember { mutableStateOf<List<PairedPrinter>>(emptyList()) }
    var problem by remember { mutableStateOf<PrinterSetupProblem?>(null) }
    var width by remember(printer) { mutableIntStateOf(printer.choice?.paperWidthMm ?: 58) }
    fun refresh() {
        problem = BluetoothPrinters.problem(context)
        paired = BluetoothPrinters.paired(context)
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { refresh() }
    fun choose(next: PrinterChoice?) {
        scope.launch {
            printer.select(next)
            choice = next
            picking = false
            onChanged()
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Printer in use", style = MaterialTheme.typography.titleMedium)
        Text(
            choice?.let { "Bluetooth: ${it.name} · ${it.paperWidthMm} mm paper" } ?: "This handheld's built-in printer",
            Modifier.testTag("printer-in-use"),
        )
        if (!picking) {
            OutlinedButton(
                onClick = {
                    picking = true
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !BluetoothPrinters.hasConnectPermission(context)) {
                        permission.launch(Manifest.permission.BLUETOOTH_CONNECT)
                    }
                    refresh()
                },
                enabled = enabled,
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("choose-bluetooth-printer"),
            ) { Text(if (choice == null) "Use a Bluetooth printer" else "Change Bluetooth printer") }
        } else {
            Text("Paper width", style = MaterialTheme.typography.titleSmall)
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
                PrinterChoice.SUPPORTED_WIDTHS.sorted().forEach { mm ->
                    val label = "$mm mm"
                    val modifier = Modifier.weight(1f).heightIn(min = 56.dp).testTag("paper-width-$mm")
                    if (width == mm) Button(onClick = { width = mm }, modifier = modifier) { Text(label) }
                    else OutlinedButton(onClick = { width = mm }, modifier = modifier) { Text(label) }
                }
            }
            problem?.let { Text(PrinterWords.setup(it).replaceFirstChar(Char::uppercase) + ".", Modifier.testTag("bluetooth-problem")) }
            if (problem == null && paired.isEmpty()) Text("No paired devices. Pair the printer in Bluetooth settings first.")
            paired.forEach { device ->
                OutlinedButton(
                    onClick = { choose(PrinterChoice(device.address, device.name, width)) },
                    enabled = enabled,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("paired-${device.address}"),
                ) { Text(if (device.looksLikePrinter) device.name else "${device.name} (not marked as a printer)") }
            }
            OutlinedButton(
                onClick = {
                    try {
                        context.startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    } catch (_: ActivityNotFoundException) { /* no settings screen: nothing to open */ }
                },
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("bluetooth-settings"),
            ) { Text("Pair or turn on Bluetooth") }
            OutlinedButton(onClick = { refresh() }, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) { Text("Refresh list") }
            OutlinedButton(onClick = { picking = false }, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) { Text("Cancel") }
        }
        if (choice != null) {
            OutlinedButton(
                onClick = { choose(null) },
                enabled = enabled,
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("use-built-in-printer"),
            ) { Text("Use the built-in printer") }
        }
    }
}
