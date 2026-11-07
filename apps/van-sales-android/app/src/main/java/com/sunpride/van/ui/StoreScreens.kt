package com.sunpride.van.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.sp
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextButton
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

/**
 * POS v2: the Till tab. F-R01: shared APK and shared inset-safe shell; no route/load/trip actions in Store mode. IP-P0: open and end session
 * are separate. The sync strip is a small badge in the title bar, not a box over the list.
 */
@Composable fun StoreHomeScreen(c: VanController) {
    val state=c.storePos
    val config=state.config
    val sessionOpen=state.shift!=null
    val blocked=StoreNewSale.blockedReason(sessionOpen,c.onHold,config?.details?.optBoolean("transactionsEnabled")==true,
        config?.details?.optJSONArray("catalogue")?.length()?.let {it>0}==true)
    val x=if(sessionOpen&&config!=null) StoreXPreview.of(StoreTransactions.receipts(config,state.rows).filter {it.optString("_status")!="voided"}.map {it.getString("totalMinor").toLong()}) else null
    ScreenFrame("Till",message=c.message,trailing={SyncPill(c)}) {
        Surface(Modifier.fillMaxWidth(),shape=RoundedCornerShape(Look.cardRadius),color=Look.card,border=BorderStroke(1.dp,Look.hairline)) {
            Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(10.dp)) {
                    Column(Modifier.weight(1f)) {
                        Text(config?.storeName ?: "Store",style=MaterialTheme.typography.titleLarge,maxLines=2,overflow=TextOverflow.Ellipsis)
                        Text("${config?.registerName ?: "Register"} · ${config?.terminalCode ?: "Not assigned"}",style=MaterialTheme.typography.bodyMedium,color=Look.muted)
                    }
                    Surface(shape=CircleShape,color=if(sessionOpen) SunprideTokens.stockGreen else Look.hairline) {
                        Text(if(sessionOpen)"Open" else "Closed",Modifier.padding(horizontal=12.dp,vertical=6.dp).testTag("store-session-status"),color=if(sessionOpen) Color.White else Look.ink,fontSize=14.sp,fontWeight=FontWeight.ExtraBold)
                    }
                }
                if(x!=null) Row(Modifier.fillMaxWidth().testTag("till-x-preview"),verticalAlignment=Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Sales this session",style=MaterialTheme.typography.bodyMedium,color=Look.muted)
                        FitText(PosMoney.format(x.salesMinor,"PHP"),32.sp,minSize=20.sp,color=Look.ink)
                    }
                    Text("${x.receipts} ${if(x.receipts==1)"receipt" else "receipts"}",style=MaterialTheme.typography.titleMedium)
                }
                if(sessionOpen) PillButton("Go to Sell",{c.open(Page.STORE_SALE)},Modifier.testTag("store-new-sale"),enabled=blocked==null&&!c.busy,height=56.dp)
                else PillButton("Open the till",c::beginOpenSession,Modifier.testTag("store-open-session"),enabled=!c.busy&&!c.onHold,height=56.dp)
                blocked?.takeIf{sessionOpen}?.let {Text(it,style=MaterialTheme.typography.bodyMedium,color=MaterialTheme.colorScheme.error,modifier=Modifier.testTag("store-new-sale-reason"))}
                if(!sessionOpen) Text("Count the cash in the drawer to open. Then you can sell.",style=MaterialTheme.typography.bodyMedium,color=Look.muted)
            }
        }
        if(state.review>0) SectionCard("Saved work needs office review") { Text("Do not recapture a refused sale. Reconcile it with the office first.") }
        ListRow("Cash drawer & X/Z reports","Cash drop, paid out, X reading and Z reading (supervisor PIN)","store-reports",onClick={c.open(Page.STORE_READS)},glyph=GlyphKind.WALLET)
        ListRow("Cash deposit","Slip photo · bank · Z-read matching","store-deposit",onClick={c.open(Page.STORE_DEPOSIT)},glyph=GlyphKind.RECEIPT)
        // Secondary row, last in the list: never the main button, and it asks first.
        if(sessionOpen) SecondaryButton("Close the till",c::requestEndSession,Modifier.testTag("store-end-session"),enabled=!c.busy && !c.onHold)
    }
    if(c.endSessionSheet) EndSessionSheet(c)
}
/** Confirmation with the X reading so far (sales only; expected cash stays hidden so the count is blind). */
@Composable private fun EndSessionSheet(c: VanController) {
    val config=c.storePos.config
    val receipts=if(config==null) emptyList() else StoreTransactions.receipts(config,c.storePos.rows)
    val x=StoreXPreview.of(receipts.filter {it.optString("_status")!="voided"}.map {it.getString("totalMinor").toLong()})
    // IP-HOLD: parked carts stop the till closing; the cashier finishes them or throws them away.
    LaunchedEffect(Unit){c.refreshHeld()}
    val held=c.heldOf(com.sunpride.van.pos.HeldCartRules.SURFACE_STORE)
    var confirmDiscard by remember{mutableStateOf(false)}
    Dialog(onDismissRequest=c::cancelEndSession,properties=DialogProperties(usePlatformDefaultWidth=false)) {
        Surface(Modifier.fillMaxWidth().padding(16.dp).navigationBarsPadding().statusBarsPadding(),shape=SunprideTokens.shapes.large) {
            Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
                Text("Close the till?",style=MaterialTheme.typography.titleLarge,modifier=Modifier.testTag("end-session-title"))
                Text("X reading so far",style=MaterialTheme.typography.labelLarge)
                Text("${x.receipts} receipts · ${PosMoney.format(x.salesMinor,"PHP")}",style=MaterialTheme.typography.titleMedium,modifier=Modifier.testTag("end-session-x"))
                Text("Next you count the cash in the drawer. You will not see the expected cash. The count is final.")
                if(held.isNotEmpty()) {
                    Text(com.sunpride.van.pos.HeldCartRules.closeBlock(held.size)!!,color=MaterialTheme.colorScheme.error,modifier=Modifier.testTag("end-session-held"))
                    DangerButton("Discard held ${if(held.size==1)"cart" else "carts"}",{confirmDiscard=true},Modifier.testTag("store-end-discard-held"),enabled=!c.busy)
                }
                PrimaryBottomButton("Count the cash",c::confirmEndSession,enabled=!c.busy&&held.isEmpty(),tag="store-end-continue")
                SecondaryButton("Keep selling",c::cancelEndSession,Modifier.testTag("store-end-cancel"))
            }
        }
    }
    if(confirmDiscard) AlertDialog(onDismissRequest={confirmDiscard=false},title={Text("Discard ${held.size} held ${if(held.size==1)"cart" else "carts"}?")},
        text={Text("They are thrown away. They cannot be brought back.")},
        confirmButton={TextButton({c.discardAllHeld(com.sunpride.van.pos.HeldCartRules.SURFACE_STORE);confirmDiscard=false},Modifier.heightIn(min=48.dp).testTag("store-end-discard-confirm")){Text("Discard",color=SunprideTokens.emptyRed,fontWeight=FontWeight.ExtraBold)}},
        dismissButton={TextButton({confirmDiscard=false},Modifier.heightIn(min=48.dp).testTag("store-end-discard-cancel")){Text("Keep them")}})
}
/** Open only: take the float and open the session. It cannot turn into a count. */
@Composable fun OpenSessionScreen(c: VanController) {
    var amount by remember {mutableStateOf("")}
    val typed=VanRules.parseMoney(amount)?.takeIf {it<=StorePosStore.MAX_MONEY}
    val floatProblem=typed?.let(StorePosStore::floatProblem)
    val minor=typed?.takeIf {floatProblem==null}
    // A session that is already open sends the cashier home; the form is never reused for counting.
    LaunchedEffect(c.storePos.shift) {if(c.storePos.shift!=null) c.open(Page.HOME)}
    ScreenFrame("Open the till",c::back,action="Open till",actionTag="save-store-open",
        enabled=minor!=null && !c.busy && c.storeMode && !c.onHold && c.storePos.shift==null,
        onAction={c.openStoreShift(checkNotNull(minor))},message=c.message) {
        Text(c.storePos.config?.storeName ?: "Store",style=MaterialTheme.typography.titleLarge)
        Text("Enter the cash placed in the drawer before the session starts. It is an opening float, not a sale.")
        LabeledField("Opening float (₱)",amount,{amount=it},"store-float-amount",numeric=true,maxLength=16)
        floatProblem?.let {Text(it,color=MaterialTheme.colorScheme.error,modifier=Modifier.testTag("store-float-problem"))}
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
