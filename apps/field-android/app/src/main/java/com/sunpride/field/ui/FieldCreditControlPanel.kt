package com.sunpride.field.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.UUID

/** F-404 live-only own-order Finance/SAP control, with no retained financial fallback after denial. */
@Composable fun FieldCreditControlPanel(call:(String,JSONObject)->JSONObject,lifetime:()->String?){
    var open by remember{mutableStateOf(false)}
    var data by remember{mutableStateOf<JSONObject?>(null)}
    var bound by remember{mutableStateOf<String?>(null)}
    var selected by remember{mutableStateOf<String?>(null)}
    var reason by remember{mutableStateOf("")}
    var requestKey by remember{mutableStateOf(UUID.randomUUID().toString())}
    var busy by remember{mutableStateOf(false)}
    var message by remember{mutableStateOf<String?>(null)}
    var exposure by remember{mutableStateOf<JSONObject?>(null)}
    var page by remember{mutableStateOf(0)}
    val scope=rememberCoroutineScope();val epoch=remember{java.util.concurrent.atomic.AtomicLong()}
    val current=lifetime();val visible=data?.takeIf{bound==current&&current!=null}
    DisposableEffect(current,open){epoch.incrementAndGet();onDispose{epoch.incrementAndGet()}}
    fun rows(key:String)=visible?.optJSONArray(key)?.let{a->(0 until a.length()).map{a.getJSONObject(it)}}.orEmpty()
    fun money(value:Long?)=value?.let{"₱"+java.text.NumberFormat.getNumberInstance(java.util.Locale.ENGLISH).apply{minimumFractionDigits=2;maximumFractionDigits=2}.format(java.math.BigDecimal.valueOf(it,2))}?:"Unknown"
    fun network(action:String,args:JSONObject=JSONObject(),done:(JSONObject)->Unit={}){
        val ticket=epoch.incrementAndGet();val before=lifetime();busy=true;message=null
        scope.launch{try{
            val result=withContext(Dispatchers.IO){call(action,args)}
            if(ticket==epoch.get()&&before!=null&&before==lifetime()){done(result);bound=before}
        }catch(e:Exception){if(e is kotlinx.coroutines.CancellationException)throw e;if(ticket==epoch.get()){data=null;exposure=null;message="Connect with your current account to check credit. No saved financial answer is being shown."}}
        finally{if(ticket==epoch.get())busy=false}}
    }
    fun refresh(){data=null;exposure=null;network("list"){data=it}}
    LaunchedEffect(open,current){if(open&&current!=null)refresh()}
    Surface(Modifier.fillMaxWidth().testTag("field-credit-control"),shape=MaterialTheme.shapes.medium){Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(10.dp)){
        Text("Credit control",style=MaterialTheme.typography.titleMedium)
        Text("Your synced orders, exposure, Finance review and SAP decision.")
        OutlinedButton({open=!open}){Text(if(open)"Close credit control"else"Open credit control")}
        if(open){
            OutlinedButton({refresh()},enabled=!busy){Text(if(busy)"Checking…"else"Refresh credit requests")}
            message?.let{Text(it)}
            val orders=rows("orders");val shownPage=page.coerceIn(0,maxOf(0,(orders.size-1)/5))
            if(visible!=null&&orders.isEmpty())Text("No priced orders awaiting office confirmation. Sync a draft first; unknown prices are never treated as zero.")
            for(order in orders.drop(shownPage*5).take(5)){
                OutlinedButton({selected=order.getString("id");reason="";requestKey=UUID.randomUUID().toString();exposure=null},enabled=!busy){Text(order.getString("number")+" · "+money(order.getLong("amountCentavos")))}
            }
            if(orders.size>5)Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){
                OutlinedButton({page=shownPage-1},enabled=shownPage>0){Text("Previous")}
                Text("${shownPage*5+1}–${minOf((shownPage+1)*5,orders.size)} of ${orders.size}")
                OutlinedButton({page=shownPage+1},enabled=(shownPage+1)*5<orders.size){Text("Next")}
            }
            orders.firstOrNull{it.getString("id")==selected}?.let{order->
                Text(order.getString("customerName")+" · "+money(order.getLong("amountCentavos")))
                val account=JSONObject().put("customerCode",order.getString("customerCode")).put("outletId",order.opt("outletId")).put("orderId",order.getString("id"))
                OutlinedButton({network("exposure",account){exposure=it}},enabled=!busy){Text("Check exposure and ageing")}
                exposure?.let{e->
                    Text("${if(e.optString("source")=="sample")"SAMPLE · "else""}${e.optString("freshness")} · account limit ${money(if(e.isNull("limitCentavos"))null else e.getLong("limitCentavos"))} · exposure ${money(if(e.isNull("exposureCentavos"))null else e.getLong("exposureCentavos"))}")
                    val items=e.optJSONArray("openItems");if(items!=null){Text("${items.length()} SAP open items");for(i in 0 until minOf(items.length(),5)){val item=items.getJSONObject(i);Text(item.getString("documentNumber")+" · "+money(item.getLong("amountCentavos"))+" · due "+java.text.SimpleDateFormat("dd MMM yyyy",java.util.Locale.ENGLISH).apply{timeZone=java.util.TimeZone.getTimeZone("Asia/Manila")}.format(java.util.Date(item.getLong("dueAt"))))}}
                }
                OutlinedTextField(reason,{reason=it},label={Text("Why this order needs a credit exception")},modifier=Modifier.fillMaxWidth(),minLines=2,enabled=!busy)
                OutlinedButton({
                    val body=JSONObject(account.toString()).put("sourceType","order").put("sourceId",order.getString("id")).put("amountCentavos",order.getLong("amountCentavos")).put("reason",reason.trim()).put("idempotencyKey",requestKey)
                    network("request",body){requestKey=UUID.randomUUID().toString();message="Request saved. Another Finance approver and SAP must agree before the office can confirm this order.";data=null}
                },enabled=!busy&&reason.trim().length in 3..300){Text("Ask credit control")}
            }
            val requests=rows("requests")
            for(row in requests.take(5)){
                Text("${if(row.optString("source")=="sample")"SAMPLE · "else""}${money(row.getLong("amountCentavos"))} · "+when(row.optString("phase")){"approved"->"SAP exception approved";"rejected"->"Refused";"awaiting_sap"->"Finance approved · awaiting SAP";"awaiting_finance"->"Waiting for Finance";else->"Refresh with the office"})
                OutlinedButton({network("status",JSONObject().put("id",row.getString("id"))){answer->message=when(answer.optString("phase")){"approved"->"SAP approved. The office can now confirm the matching order.";"rejected"->"The request was refused. The order remains unconfirmed.";else->"Still awaiting Finance or SAP."};data=null}},enabled=!busy){Text("Check decision")}
            }
            if(requests.size>5)Text("Showing the five most recent of ${requests.size} loaded requests.")
            if(visible?.optBoolean("truncated")==true)Text("More history exists. Ask the office to review older records; this is not a complete history.")
            Text("Finance approval alone is not credit. SAP's ordinary account limit is unchanged. Requests require a connection; offline order capture stays available.",style=MaterialTheme.typography.bodySmall)
        }
    }}
}
