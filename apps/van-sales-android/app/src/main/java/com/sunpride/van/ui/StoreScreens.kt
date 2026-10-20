package com.sunpride.van.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag

/** F-R01: shared APK and shared inset-safe shell; no route/load/trip actions in Store mode. */
@Composable fun StoreHomeScreen(c: VanController) {
    val state=c.storePos
    val config=state.config
    ScreenFrame("Store POS",action=if(state.shift==null)"Open cashier session" else "Close cashier session",
        actionTag="store-shift",onAction={c.open(Page.STORE_SHIFT)},enabled=!c.busy && !c.onHold,
        message=c.message,footer="${state.queued} waiting to sync · ${state.review} for review") {
        SectionCard(config?.storeName ?: "Store") {
            Text(config?.registerName ?: "Register",style=MaterialTheme.typography.titleLarge)
            Text("Terminal · ${config?.terminalCode ?: "Not assigned"}")
            Text(if(state.shift==null)"No cashier session open" else "Cashier session open",Modifier.testTag("store-session-status"))
        }
        SectionCard("Store checkout is not enabled yet") {
            Text("Cashier sessions are available. Store sales, refunds and statutory reads still need the shared checkout integration. No sale can be taken here yet.")
        }
        ListRow("Sync now","Send cashier sessions and check office configuration","store-sync",onClick=c::syncNow,enabled=!c.busy)
        ListRow("POS mode","Store · set by the office","open-pos-mode",onClick={c.open(Page.POS_MODE)})
        ListRow("Printer & scanner","Check the handheld without printing","store-printer",onClick={c.open(Page.PRINTER)})
        ListRow("Sync & posting","Saved work and acknowledgements","open-sync",onClick={c.open(Page.SYNC)})
        ListRow("Account","Password and sign out","open-account",onClick={c.open(Page.ACCOUNT)})
    }
}
/** F-R01: count entry has no expected cash or variance hint, even after an offline reopen. */
@Composable fun StoreShiftScreen(c: VanController) {
    val closing=c.storePos.shift!=null
    var amount by remember(closing) {mutableStateOf("")}
    val minor=VanRules.parseMoney(amount)?.takeIf {it<=com.sunpride.van.storepos.StorePosStore.MAX_MONEY}
    ScreenFrame(if(closing)"Blind cash count" else "Opening float",c::back,
        action=if(closing)"Submit blind count" else "Open session",actionTag="save-store-shift",
        enabled=minor!=null && !c.busy && c.storeMode && !c.onHold,
        onAction={if(closing)c.closeStoreShift(checkNotNull(minor)) else c.openStoreShift(checkNotNull(minor))},message=c.message) {
        Text(c.storePos.config?.storeName ?: "Store",style=MaterialTheme.typography.titleLarge)
        Text(if(closing)"Count the cash physically in the drawer. Do not include e-wallet or card receipts. Your declaration is final; any difference is reviewed by a second person."
            else "Enter the cash placed in the drawer before the session starts. It is an opening float, not a sale.")
        LabeledField(if(closing)"Cash counted (₱)" else "Opening float (₱)",amount,{amount=it},"store-cash-amount",numeric=true,maxLength=16)
        Text("Saved securely on this phone, even without a network. Sync when connected.")
    }
}
@Composable fun PosModeScreen(c: VanController) {
    ScreenFrame("POS mode",c::back,action="Sync configuration",onAction=c::syncNow,enabled=!c.busy,message=c.message) {
        SectionCard("This handheld") {
            Text(if(c.storeMode)"Store" else "Van",style=MaterialTheme.typography.headlineMedium,modifier=Modifier.testTag("pos-mode-value"))
            c.storePos.config?.storeName?.let {Text(it)}
        }
        Text("An administrator changes the mode in Setup → Phones. Close the cashier session or settle the van trip before switching.")
        Text("Manager PIN switching is not available in this release. There is no unlocked local switch.")
    }
}
