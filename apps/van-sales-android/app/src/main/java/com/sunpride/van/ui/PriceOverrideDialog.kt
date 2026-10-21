package com.sunpride.van.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.sunpride.van.pos.*
import java.math.BigDecimal

/** F-124: proposed base price remains distinct from governed schemes and manual reductions. */
@Composable fun PriceOverrideDialog(c:VanController,onClose:()->Unit){
    val draft=c.sale?:return;val base=c.cartQuote(ignoreManual=true,ignorePrices=true)
    var amounts by remember(draft.saleId){mutableStateOf(draft.priceOverride?.unitMinor.orEmpty().mapValues{BigDecimal.valueOf(it.value,2).toPlainString()})}
    var reason by remember(draft.saleId){mutableStateOf(draft.priceOverride?.authorization?.reason.orEmpty())}
    val parsed=amounts.filterValues{it.isNotBlank()}.mapValues{VanRules.parseMoney(it.value)}
    val valid=base!=null&&parsed.values.none{it==null}
    val changes=parsed.filter{(id,v)->v!=base?.lines?.find{it.product.productId==id}?.unitPriceMinor}.mapValues{it.value?:0}
    Dialog(onDismissRequest={if(!c.busy)onClose()},properties=DialogProperties(usePlatformDefaultWidth=false)){
        Surface(Modifier.fillMaxWidth().padding(16.dp).statusBarsPadding().navigationBarsPadding().imePadding(),shape=SunprideTokens.shapes.large){Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
            Text("Price exception",style=MaterialTheme.typography.titleLarge)
            Column(Modifier.weight(1f,false).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(8.dp)){
                Text("Propose a base selling price. Schemes apply to that price, then manual reductions. The reason and exact cart follow the same role, channel and value authority as other overrides.")
                base?.lines?.forEachIndexed{i,l->LabeledField("${l.product.name} · governed ${PosMoney.format(l.unitPriceMinor,"PHP")} per ${l.product.uomCode}",amounts[l.product.productId].orEmpty(),{v->amounts=amounts+(l.product.productId to v)},"price-override-$i",enabled=!c.busy,maxLength=14,keyboardType=KeyboardType.Decimal)}
                LabeledField("Reason for the price exception",reason,{reason=it},"price-override-reason",enabled=!c.busy,maxLength=300)
                if(!valid)Text("Sync governed prices and enter valid nonnegative peso amounts.",color=MaterialTheme.colorScheme.error)
                Text("Above your limit, another person must approve before this phone can save. A changed cart retires earlier approvals.")
            }
            PrimaryBottomButton("Apply proposed prices",{c.setSalePrices(if(changes.isEmpty())null else SalePriceOverride(changes,FinancialOverride(reason=reason)));onClose()},enabled=!c.busy&&valid&&(changes.isEmpty()||reason.trim().isNotEmpty()),tag="apply-price-override")
            SecondaryButton("Use governed prices",{c.setSalePrices(null);onClose()},enabled=!c.busy)
            SecondaryButton("Cancel",onClose,enabled=!c.busy)
        }}
    }
}
@Composable fun FinancialApprovalCard(c:VanController,kind:String){
    val input=if(kind=="price")c.sale?.priceOverride?.authorization else c.sale?.creditOverride
    var code by remember(c.sale?.saleId,kind,input?.requestId){mutableStateOf("")}
    SectionCard(if(kind=="price")"Price authority"else"Local credit ceiling exception"){
        if(kind=="credit"){
            Text("This can relax only the app’s conservative ceiling while fresh SAP availability still covers the whole invoice. It never raises SAP’s limit, approves stale credit, or replaces SAP confirmation on sync.")
            LabeledField("Reason for this exact credit invoice",input?.reason.orEmpty(),c::setCreditExceptionReason,"credit-exception-reason",enabled=!c.busy,maxLength=300)
        }else Text("Request for the complete proposed cart. Above your value limit, a different authorized person must approve.")
        c.financialMessage?.let{Text(it)}
        SecondaryButton("Request / record reason",{c.requestCartOverride(kind)},enabled=!c.busy&&input?.reason?.trim()?.isNotEmpty()==true)
        SecondaryButton("Check approval",{c.checkCartOverride(kind)},enabled=!c.busy&&input!=null)
        LabeledField("Office approval code (optional)",code,{code=it},"$kind-exception-code",enabled=!c.busy,maxLength=6000)
        SecondaryButton("Check pasted approval",{c.acceptCartOverride(kind,code)},enabled=!c.busy&&input!=null&&code.isNotBlank())
    }
}
