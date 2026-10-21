package com.sunpride.van.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.sunpride.van.data.PaymentKind
import com.sunpride.van.storage.SavedSale
import java.math.BigDecimal
import java.util.UUID

/** F-108/F-109/F-111: existing receipt screen, one local collection and frozen OR. */
@Composable fun CollectionDialog(c: VanController, saved: SavedSale, onClose: ()->Unit) {
    val id=remember(saved.receipt.saleId) {UUID.randomUUID().toString()}
    var amount by remember {mutableStateOf("")}
    var method by remember {mutableStateOf("cash")}
    var reference by remember {mutableStateOf("")}
    var attempted by remember {mutableStateOf(false)}
    val chosen=c.paymentMethods.firstOrNull {it.code==method && it.kind!=PaymentKind.CREDIT}
    val minor=runCatching { if(!Regex("[0-9]{1,10}(\\.[0-9]{1,2})?").matches(amount)) null else BigDecimal(amount).movePointRight(2).longValueExact() }.getOrNull()
    Dialog(onDismissRequest={if(!c.busy)onClose()},properties=DialogProperties(usePlatformDefaultWidth=false)) {
        Surface(Modifier.fillMaxWidth().padding(16.dp).statusBarsPadding().navigationBarsPadding().imePadding(),shape=SunprideTokens.shapes.large) {
            Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
                Text("Collect payment & issue OR",style=MaterialTheme.typography.titleLarge)
                Column(Modifier.weight(1f,false).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(8.dp)) {
                    Text(saved.receipt.customerName)
                    Text("Against invoice ${saved.receipt.receiptNumber}")
                    Text("The phone checks earlier collections before saving. A rejected upload does not erase cash received; reconcile it with the office before collecting again.",style=MaterialTheme.typography.bodySmall)
                    LabeledField("Amount received (₱)",amount,{amount=it},"collection-amount",enabled=!c.busy,maxLength=14,keyboardType=KeyboardType.Decimal)
                    c.paymentMethods.filter {it.kind!=PaymentKind.CREDIT}.forEach { option ->
                        Row {RadioButton(selected=method==option.code,onClick={method=option.code;reference=""},enabled=!c.busy);Text(option.label,Modifier.padding(top=12.dp))}
                    }
                    if(chosen?.referenceRequired==true) LabeledField(chosen.referenceLabel?:"Payment reference",reference,{reference=it},"collection-reference",enabled=!c.busy,maxLength=40)
                    Text(if(chosen?.kind==PaymentKind.CASH) "Cash received is included in your cash count. No change is given on a collection." else "Recorded evidence only. Noncash payment stays awaiting office confirmation.")
                    if(attempted) c.message?.let {Text(it,color=MaterialTheme.colorScheme.error)}
                }
                PrimaryBottomButton("Save collection & OR",{
                    attempted=true
                    minor?.let {c.recordCollection(id,saved.receipt.saleId,it,method,reference.takeIf {chosen?.referenceRequired==true},onClose)}
                },enabled=!c.busy && chosen!=null && minor!=null && minor>0 && (chosen.referenceRequired.not() || reference.isNotBlank()),tag="save-collection")
                SecondaryButton("Cancel",onClose,enabled=!c.busy)
            }
        }
    }
}
