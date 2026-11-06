package com.sunpride.van.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.foundation.layout.*
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.sunpride.van.pos.PosMoney
import com.sunpride.van.storepos.StorePosStore
import com.sunpride.van.storepos.StoreTransactions
import com.sunpride.van.storepos.StoreXPreview

/** F-R01: shared APK and shared inset-safe shell; no route/load/trip actions in Store mode. IP-P0: open and end session are separate. */
@Composable fun StoreHomeScreen(c: VanController) {
    val state=c.storePos
    val config=state.config
    val sessionOpen=state.shift!=null
    val blocked=StoreNewSale.blockedReason(sessionOpen,c.onHold,config?.details?.optBoolean("transactionsEnabled")==true,
        config?.details?.optJSONArray("catalogue")?.length()?.let {it>0}==true)
    // Home = status card + one next-step button: Open session until a session is open, then New sale.
    ScreenFrame("Store POS",action=if(sessionOpen)null else "Open cashier session",
        actionTag="store-open-session",onAction=c::beginOpenSession,enabled=!c.busy && !c.onHold,
        message=c.message,footer="${state.queued} waiting to sync · ${state.review} for review") {
        SectionCard(config?.storeName ?: "Store") {
            Text(config?.registerName ?: "Register",style=MaterialTheme.typography.titleLarge)
            Text("Terminal · ${config?.terminalCode ?: "Not assigned"}")
            Text(if(sessionOpen)"Cashier session open" else "No cashier session open",Modifier.testTag("store-session-status"))
        }
        if(state.review>0) SectionCard("Saved work needs office review") { Text("Do not recapture a refused sale. Reconcile it with the office first.") }
        ListRow("New sale","Scan or search · shared prices · split tenders","store-new-sale",onClick={c.open(Page.STORE_SALE)},enabled=blocked==null&&!c.busy)
        blocked?.let {Text(it,style=MaterialTheme.typography.bodyMedium,color=MaterialTheme.colorScheme.error,modifier=Modifier.testTag("store-new-sale-reason"))}
        ListRow("Receipts, voids & refunds","Frozen receipts and supervisor approval","store-receipts",onClick={c.open(Page.STORE_RECEIPTS)})
        ListRow("X / Z reports","Mid-shift read and end-of-day closing","store-reports",onClick={c.open(Page.STORE_READS)})
        ListRow("Receiving & counts","Warehouse/van transfer or PO · blind count","store-stock",onClick={c.open(Page.STORE_STOCK)})
        ListRow("Cash deposit","Slip photo · bank · Z-read matching","store-deposit",onClick={c.open(Page.STORE_DEPOSIT)})
        ListRow("Customers & points","Phone lookup · optional loyalty","store-customers",onClick={c.open(Page.STORE_CUSTOMERS)})
        ListRow("Sync now","Send cashier sessions and check office configuration","store-sync",onClick=c::syncNow,enabled=!c.busy)
        ListRow("POS mode","Store · set by the office","open-pos-mode",onClick={c.open(Page.POS_MODE)})
        ListRow("Printer & scanner","Check the handheld without printing","store-printer",onClick={c.open(Page.PRINTER)})
        ListRow("Sync & posting","Saved work and acknowledgements","open-sync",onClick={c.open(Page.SYNC)})
        ListRow("Account","Password and sign out","open-account",onClick={c.open(Page.ACCOUNT)})
        // Secondary row, last in the list: never the main button, and it asks first.
        if(sessionOpen) SecondaryButton("End session",c::requestEndSession,Modifier.testTag("store-end-session"),enabled=!c.busy && !c.onHold)
    }
    if(c.endSessionSheet) EndSessionSheet(c)
}
/** Confirmation with the X reading so far (sales only; expected cash stays hidden so the count is blind). */
@Composable private fun EndSessionSheet(c: VanController) {
    val config=c.storePos.config
    val receipts=if(config==null) emptyList() else StoreTransactions.receipts(config,c.storePos.rows)
    val x=StoreXPreview.of(receipts.filter {it.optString("_status")!="voided"}.map {it.getString("totalMinor").toLong()})
    Dialog(onDismissRequest=c::cancelEndSession,properties=DialogProperties(usePlatformDefaultWidth=false)) {
        Surface(Modifier.fillMaxWidth().padding(16.dp).navigationBarsPadding().statusBarsPadding(),shape=SunprideTokens.shapes.large) {
            Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
                Text("End this cashier session?",style=MaterialTheme.typography.titleLarge,modifier=Modifier.testTag("end-session-title"))
                Text("X reading so far",style=MaterialTheme.typography.labelLarge)
                Text("${x.receipts} receipts · ${PosMoney.format(x.salesMinor,"PHP")}",style=MaterialTheme.typography.titleMedium,modifier=Modifier.testTag("end-session-x"))
                Text("Next you count the cash in the drawer. You will not see the expected cash. The count is final.")
                PrimaryBottomButton("Continue to cash count",c::confirmEndSession,enabled=!c.busy,tag="store-end-continue")
                SecondaryButton("Keep selling",c::cancelEndSession,Modifier.testTag("store-end-cancel"))
            }
        }
    }
}
/** Open only: take the float and open the session. It cannot turn into a count. */
@Composable fun OpenSessionScreen(c: VanController) {
    var amount by remember {mutableStateOf("")}
    val minor=VanRules.parseMoney(amount)?.takeIf {it<=StorePosStore.MAX_MONEY}
    // A session that is already open sends the cashier home; the form is never reused for counting.
    LaunchedEffect(c.storePos.shift) {if(c.storePos.shift!=null) c.open(Page.HOME)}
    ScreenFrame("Open cashier session",c::back,action="Open session",actionTag="save-store-open",
        enabled=minor!=null && !c.busy && c.storeMode && !c.onHold && c.storePos.shift==null,
        onAction={c.openStoreShift(checkNotNull(minor))},message=c.message) {
        Text(c.storePos.config?.storeName ?: "Store",style=MaterialTheme.typography.titleLarge)
        Text("Enter the cash placed in the drawer before the session starts. It is an opening float, not a sale.")
        LabeledField("Opening float (₱)",amount,{amount=it},"store-float-amount",numeric=true,maxLength=16)
        Text("Saved securely on this phone, even without a network. Sync when connected.")
    }
}
/** Close only, and only reached through the End session confirmation. F-R01: no expected cash or variance hint. */
@Composable fun CloseSessionScreen(c: VanController) {
    var amount by remember {mutableStateOf("")}
    val minor=VanRules.parseMoney(amount)?.takeIf {it<=StorePosStore.MAX_MONEY}
    LaunchedEffect(c.countUnlocked) {if(!c.countUnlocked) c.open(Page.HOME)}
    ScreenFrame("Blind cash count",c::back,action="Submit blind count",actionTag="save-store-close",
        enabled=minor!=null && !c.busy && c.storeMode && !c.onHold && c.countUnlocked,
        onAction={c.closeStoreShift(checkNotNull(minor))},message=c.message) {
        Text(c.storePos.config?.storeName ?: "Store",style=MaterialTheme.typography.titleLarge)
        Text("Count the cash physically in the drawer. Do not include e-wallet or card receipts. Your declaration is final; any difference is reviewed by a second person.")
        LabeledField("Cash counted (₱)",amount,{amount=it},"store-count-amount",numeric=true,maxLength=16)
        Text("Saved securely on this phone, even without a network. Sync when connected.")
    }
}
@Composable fun PosModeScreen(c: VanController) {
    var pin by remember {mutableStateOf("")}
    ScreenFrame("POS mode",c::back,action="Sync configuration",onAction=c::syncNow,enabled=!c.busy,message=c.message) {
        SectionCard("This handheld") {
            Text(if(c.storeMode)"Store" else "Van",style=MaterialTheme.typography.headlineMedium,modifier=Modifier.testTag("pos-mode-value"))
            c.storePos.config?.storeName?.let {Text(it)}
        }
        Text("An administrator changes the mode in Setup → Phones. Close the cashier session or settle the van trip before switching.")
        if(c.storePos.config?.details?.optBoolean("allowLocalSwitch")==true){
            Text("Manager switching is enabled by the office. Sync all work first. A connection is required to change mode.")
            LabeledField("Manager PIN",pin,{pin=it},"pos-mode-pin",password=true,maxLength=12)
            SecondaryButton(if(c.storeMode)"Switch to Van" else "Switch to Store",{c.switchStoreMode(pin);pin=""},enabled=pin.length>=6&&!c.busy)
        }else Text("Local mode switching is disabled by the office.")
    }
}
