package com.sunpride.van.ui

import androidx.compose.runtime.*
import androidx.compose.material3.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import com.sunpride.van.pos.*
import kotlinx.coroutines.delay

/** F-112: unknown/stale exposure is not a zero balance or an approval. */
@Composable fun SaleCreditPanel(c:VanController,onExpiry:()->Unit){
    val customer=c.sale?.customer?:return
    var now by remember{mutableLongStateOf(System.currentTimeMillis())}
    val context=c.saleContext(now);val v=CreditExposure.view(customer,context)
    LaunchedEffect(v?.checkedAt,v?.expiresAt){
        var expired=false
        while(true){
            now=System.currentTimeMillis()
            val expiry=v?.expiresAt
            if(!expired&&expiry!=null&&now>=expiry){expired=true;onExpiry()}
            delay(if(expiry!=null&&expiry>now)minOf(60_000L,expiry-now+1) else 60_000L)
        }
    }
    fun money(value:Long?)=value?.let{PosMoney.format(it,"PHP")}?:"Unknown"
    val label=when{v==null->"Credit details need a fresh sync";v.status=="unknown"->"SAP credit not confirmed";!v.fresh(now)->"Expired SAP snapshot";v.status=="over"->"SAP refused the last checked amount";v.status=="no_limit"->"SAP account has no credit limit";else->"Cached SAP allowance"}
    Text((if(v?.source=="sample")"SAMPLE · " else "")+label,style=MaterialTheme.typography.titleMedium,modifier=Modifier.testTag("credit-status"))
    Text(v?.checkedAt?.let{"Last checked ${maxOf(0L,(now-it)/60_000)} min ago · ${v.freshness}"}?:"No SAP check is cached")
    Text("Account limit: ${if(v?.status=="no_limit")"No SAP limit" else money(v?.limitMinor)}")
    Text("SAP exposure: ${money(v?.exposureMinor)}")
    Text("Available estimate on this phone: ${money(CheckoutRules.creditLeft(customer,context))}",modifier=Modifier.testTag("credit-available"))
    val pending=context.creditUsedMinor[customer.outletId]?:0L
    Text("Phone awaiting acknowledgement: ${money(pending)}. These intents may already appear in SAP; this phone reserves them conservatively.")
    SecondaryButton("Check credit online",c::checkSaleCredit,Modifier.testTag("credit-check"),enabled=!c.busy&&!v?.customerCode.isNullOrBlank()&&c.cartQuote()!=null)
    Text("A cached check is not SAP confirmation of this sale. The office receives it for a fresh SAP decision on sync.",style=MaterialTheme.typography.bodyMedium)
}
