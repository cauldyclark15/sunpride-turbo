package com.sunpride.van.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.sunpride.van.storage.SavedSale
import com.sunpride.van.printing.*

/** F-109: the same 32-column formatter drives the 58mm preview and the real printer.
 * Preview never sends printer commands and never claims paper was printed. */
@Composable fun FiscalPreviewButtons(saved: SavedSale) {
    var preview by remember { mutableStateOf<Boolean?>(null) }
    if(saved.receipt.fiscalJson == null) return
    SecondaryButton("Invoice preview",{preview=false},Modifier.testTag("fiscal-preview"))
    SecondaryButton("Reprint preview",{preview=true},Modifier.testTag("fiscal-reprint-preview"))
    preview?.let { reprint ->
        val r=saved.receipt
        val attempt=PrintAttempt("preview",r.saleId,if(reprint) PrintKind.REPRINT else PrintKind.ORIGINAL,if(reprint) 1 else 0,
            if(reprint) "customer_copy" else null,PrintOutcome.NOT_PRINTED,r.createdAt)
        val lines=ReceiptLayoutFormatter().format(SaleReceiptDocuments.build(r,ReceiptHeader(null,null,null),attempt,r.createdAt))
            .filterIsInstance<ReceiptCommand.Line>().joinToString("\n") { it.text }
        Dialog(onDismissRequest={preview=null},properties=DialogProperties(usePlatformDefaultWidth=false)) {
            Surface(Modifier.fillMaxWidth().padding(12.dp).statusBarsPadding().navigationBarsPadding(),shape=SunprideTokens.shapes.large) {
                Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
                    Text(if(reprint) "REPRINT preview" else "Sales Invoice preview",style=MaterialTheme.typography.titleLarge)
                    Text("Preview only. No paper printed.",style=MaterialTheme.typography.bodyMedium)
                    Text(lines,fontFamily=FontFamily.Monospace,style=MaterialTheme.typography.bodySmall,
                        modifier=Modifier.weight(1f,false).verticalScroll(rememberScrollState()).testTag("fiscal-preview-text"))
                    SecondaryButton("Close preview",{preview=null},Modifier.testTag("close-fiscal-preview"))
                }
            }
        }
    }
}
