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
import com.sunpride.van.pos.ManualDiscountInput
import com.sunpride.van.pos.ManualDiscounts
import com.sunpride.van.pos.PosMoney
import java.math.BigDecimal

/** F-110: line then basket amounts; exact allocation is shown before any authority is requested. */
@Composable fun DiscountDialog(c:VanController,onClose:()->Unit){
    val draft=c.sale?:return
    val base=c.cartQuote(ignoreManual=true)
    var amounts by remember(draft.saleId){mutableStateOf(draft.manualDiscount?.lineMinor.orEmpty().mapValues{BigDecimal.valueOf(it.value,2).toPlainString()})}
    var basket by remember(draft.saleId){mutableStateOf(draft.manualDiscount?.basketMinor?.takeIf{it>0}?.let{BigDecimal.valueOf(it,2).toPlainString()}?:"")}
    var reason by remember(draft.saleId){mutableStateOf(draft.manualDiscount?.reason.orEmpty())}
    fun minor(text:String)=if(text.isBlank())0L else VanRules.parseMoney(text)
    val lineAmounts=amounts.mapValues{minor(it.value)}
    val basketMinor=minor(basket)
    val input=if(basketMinor!=null&&lineAmounts.values.none{it==null})ManualDiscountInput(lineAmounts.mapValues{checkNotNull(it.value)},basketMinor,reason)else null
    val adjusted=runCatching{ManualDiscounts.apply(checkNotNull(base).lines,checkNotNull(input))}.getOrNull()
    val manual=adjusted?.sumOf{it.manualDiscountMinor}
    Dialog(onDismissRequest={if(!c.busy)onClose()},properties=DialogProperties(usePlatformDefaultWidth=false)){
        Surface(Modifier.fillMaxWidth().padding(16.dp).statusBarsPadding().navigationBarsPadding().imePadding(),shape=SunprideTokens.shapes.large){
            Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
                Text("Line & basket discounts",style=MaterialTheme.typography.titleLarge)
                Column(Modifier.weight(1f,false).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(8.dp)){
                    Text("Approved schemes apply first. Enter additional peso reductions, not a replacement selling price. Changing this cart retires its earlier approval.")
                    base?.lines?.filter{it.totalMinor>0}?.forEachIndexed{index,line->
                        LabeledField("${line.product.name} · up to ${PosMoney.format(line.totalMinor,base.currency)}",amounts[line.product.productId].orEmpty(),{value->amounts=amounts+(line.product.productId to value)},"discount-line-$index",enabled=!c.busy,maxLength=14,keyboardType=KeyboardType.Decimal)
                    }
                    LabeledField("Basket reduction (₱), after line reductions",basket,{basket=it},"discount-basket",enabled=!c.busy,maxLength=14,keyboardType=KeyboardType.Decimal)
                    LabeledField("Reason for the manual discount",reason,{reason=it},"discount-reason",enabled=!c.busy,maxLength=300)
                    if(adjusted==null)Text("An amount is invalid or exceeds its line/basket.",color=MaterialTheme.colorScheme.error)
                    else Text("Additional reduction ${PosMoney.format(manual?:0,"PHP")} · New total ${PosMoney.format(adjusted.sumOf{it.totalMinor},"PHP")}")
                    Text("Your role, channel and amount determine the limit. Above it, another person must approve before this phone can save the sale.",style=MaterialTheme.typography.bodySmall)
                }
                PrimaryBottomButton("Apply to cart",{c.setSaleDiscounts(input);onClose()},enabled=!c.busy&&adjusted!=null&&input!=null&&(manual==0L||reason.trim().isNotEmpty()),tag="apply-discounts")
                SecondaryButton("Remove manual discounts",{c.setSaleDiscounts(null);onClose()},enabled=!c.busy)
                SecondaryButton("Cancel",onClose,enabled=!c.busy)
            }
        }
    }
}

@Composable fun DiscountApprovalCard(c:VanController,quote:com.sunpride.van.pos.CheckoutQuote){
    var code by remember(c.sale?.saleId){mutableStateOf("")}
    SectionCard("Discount authority"){
        Text("Total reductions ${PosMoney.format(ManualDiscounts.amount(quote.lines),quote.currency)}")
        Text("Request and check while connected. A signed offline approval is bound to this exact cart and expires; the server checks the approver and policy again on upload.",style=MaterialTheme.typography.bodySmall)
        c.discountMessage?.let{Text(it)}
        SecondaryButton("Request approval / record reason",c::requestDiscountApproval,enabled=!c.busy)
        SecondaryButton("Check approval",c::checkDiscountApproval,enabled=!c.busy)
        LabeledField("Paste an office approval code (optional)",code,{code=it},"discount-approval-code",enabled=!c.busy,maxLength=6000)
        SecondaryButton("Check pasted code",{c.pasteDiscountApproval(code)},enabled=!c.busy&&code.isNotBlank())
    }
}
