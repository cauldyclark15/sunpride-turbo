package com.sunpride.field.ui

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.sunpride.callflow.CallFlowEngine
import com.sunpride.field.ui.diagnosticvisit.VisitLocation
import com.sunpride.field.ui.diagnosticvisit.captureOrUnavailable
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** F-407 partner mode of this APK: the same call-flow engine and canonical capture adapters. */
@Composable fun DsrScreen(controller:FieldController,location:VisitLocation,modifier:Modifier=Modifier){
 val data=controller.today.partner;val scope=rememberCoroutineScope()
 fun objects(a:JSONArray?)=a?.let{(0 until it.length()).map(it::getJSONObject)}.orEmpty()
 val lifetime=controller.sapMasterLifetime();var selected by remember(lifetime){mutableStateOf<String?>(null)}
 var fix by remember(lifetime,selected){mutableStateOf<JSONObject?>(null)}
 var note by remember(lifetime,selected){mutableStateOf("")};var reason by remember(lifetime,selected){mutableStateOf("")}
 var short by remember(lifetime,selected){mutableStateOf("")};var zero by remember(lifetime,selected){mutableStateOf<String?>(null)}
 var message by remember(lifetime,selected){mutableStateOf<String?>(null)};var locating by remember{mutableStateOf(false)}
 var answers by remember(lifetime,selected){mutableStateOf<Map<String,String>>(emptyMap())}
 var cart by remember(lifetime,selected){mutableStateOf<Map<String,Int>>(emptyMap())}
 var page by remember(lifetime){mutableStateOf(0)}
 var productPage by remember(lifetime,selected){mutableStateOf(0)}
 var mslPage by remember(lifetime,selected){mutableStateOf(0)}
 fun capture(){val before=selected;val life=lifetime;scope.launch{locating=true;try{val value=location.captureOrUnavailable().wire;if(before==selected&&life==controller.sapMasterLifetime())fix=value}finally{locating=false}}}
 val permission=rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()){result->if(result.values.any{it})capture()else message="Location is needed to start and end the call; this does not enable tracking."}
 fun attempt(block:()->Unit){message=null;CollectorDraft.guarded(block).onFailure{message=it.message?:"Check the fields"}}
 Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp).testTag("distributor-field-mode"),verticalArrangement=Arrangement.spacedBy(12.dp)){
  Text(data?.optString("distributorName")?:"Distributor field work",style=MaterialTheme.typography.headlineSmall)
  NoticeCard("Shared outlet universe · partner-scoped PJP, MSL and calls. No employee office access.")
  FieldButton(controller::syncNow,Modifier.fillMaxWidth(),enabled=!controller.busy){Text(if(controller.busy)"Syncing…"else"Sync")}
  controller.error?.let{NoticeCard(it,tone=Look.Tone.BAD)};controller.today.warning?.let{NoticeCard(it,tone=Look.Tone.WARN)}
  if(data==null){NoticeCard("Connect to verify the current distributor assignment before recording.",tone=Look.Tone.WARN,glyph=GlyphKind.LOCK);return@Column}
  Text(data.optString("pjpSource"),style=MaterialTheme.typography.bodySmall)
  val outlets=objects(data.optJSONArray("outlets"));val agenda=objects(data.optJSONArray("agenda")).filter{it.getString("serviceDate")==data.getString("serviceDate")}
  val ordered=outlets.sortedWith(compareBy<JSONObject>({agenda.firstOrNull{a->a.getString("outletId")==it.getString("id")}?.optInt("sequence")?:Int.MAX_VALUE},{it.getString("name")}))
  Text("${agenda.size} planned calls today · ${outlets.size} granted customers")
  val shown=page.coerceIn(0,maxOf(0,(ordered.size-1)/6))
  for(o in ordered.drop(shown*6).take(6))FieldButton({selected=o.getString("id")},enabled=!controller.busy){Text(o.getString("name")+if(agenda.any{it.getString("outletId")==o.getString("id")})" · planned beat"else" · reasoned extra call")}
  if(ordered.size>6)Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){FieldButton({page=shown-1},enabled=shown>0){Text("Previous")};Text("${shown+1}");FieldButton({page=shown+1},enabled=(shown+1)*6<ordered.size){Text("Next")}}
  val outlet=outlets.firstOrNull{it.getString("id")==selected}?:return@Column
  val id=outlet.getString("id");Text(outlet.getString("name"),style=MaterialTheme.typography.titleLarge)
  val local=objects(data.optJSONArray("localOperations")).filter{it.getString("kind").startsWith("dsr.")}
  val accepted=local.filter{it.getString("state") !in setOf("review","held")}
  val closed=accepted.filter{it.getString("kind")=="dsr.visit.checkOut"}.map{it.getString("aggregateId")}.toSet()
  val start=accepted.lastOrNull{it.getString("kind")=="dsr.visit.checkIn"&&it.getJSONObject("payload").getString("outletId")==id&&it.getString("aggregateId") !in closed}
  val remote=objects(data.optJSONArray("visits")).lastOrNull{it.getString("outlet_id")==id&&it.getString("state") in setOf("checked-in","in-progress","arrived")&&it.getString("client_visit_id") !in closed}
  val aggregate=start?.getString("aggregateId")?:remote?.getString("client_visit_id")
  val serverCall=objects(data.optJSONArray("calls")).lastOrNull{it.getString("outlet_id")==id&&it.getString("state")=="open"}
  val config=start?.getJSONObject("payload")?.optJSONObject("callFlowSnapshot")?:serverCall?.optJSONObject("policy_snapshot")?:data.getJSONObject("configuration").getJSONObject("configurations").optJSONObject(id)
  if(config==null){Text("Ask the office to publish this channel's call and location policy.");return@Column}
  val now=System.currentTimeMillis();val open=aggregate!=null
  val own=accepted.filter{it.getString("aggregateId")==aggregate}
  val done=serverCall?.optJSONArray("completed")?.let{(0 until it.length()).map(it::getString).toSet()}.orEmpty().toMutableSet()
  for(row in own){val adapter=when(row.getString("kind")){"dsr.visit.checkIn"->"check_in";"dsr.availability.record"->"availability";"dsr.visit.activity"->CallFlowEngine.fieldAdapter(row.getJSONObject("payload").getJSONObject("activity").getString("kind"));else->null};adapter?.let{CallFlowEngine.keyFor(config,it)}?.let(done::add)}
  val hasOrder=own.any{it.getString("kind")=="dsr.visit.activity"&&it.getJSONObject("payload").getJSONObject("activity").getString("kind")=="order_intent"}||CallFlowEngine.keyFor(config,"order_build") in done
  fun send(kind:String,payload:JSONObject){
   payload.put("distributorId",data.getString("distributorId"))
   val dependencies=own.lastOrNull()?.let{listOf(it.getString("requestId"))}.orEmpty()
   if(start!=null&&start.isNull("ackId"))payload.put("localVisitRequestId",start.getString("requestId"))else payload.put("visitId",start?.optString("ackId")?:remote?.getString("id"))
   controller.queueDomain(kind,payload,checkNotNull(aggregate),dependencies)
  }
  FieldButton({if(location.requiresPermission)permission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION,Manifest.permission.ACCESS_COARSE_LOCATION))else capture()},enabled=!locating&&!controller.busy){Text(if(locating)"Getting location…"else"Get location")}
  if(fix!=null)Text("Location captured. The shared accuracy, age, mock and radius checks still apply.",style=MaterialTheme.typography.bodySmall)
  if(!open){
   FieldTextField(reason,{reason=it},label={Text("Extra-call reason, if outside today's beat")},modifier=Modifier.fillMaxWidth())
   FieldButton({attempt{
    require(accepted.none{it.getString("kind")=="dsr.visit.checkIn"&&it.getString("aggregateId") !in closed}&&objects(data.optJSONArray("visits")).none{it.getString("state") in setOf("checked-in","in-progress","arrived")&&it.getString("client_visit_id") !in closed}){"Finish the open call before starting another customer."}
    CallFlowEngine.location(config,fix,now);CallFlowEngine.advance(config,emptySet(),"check_in",false);val client=UUID.randomUUID().toString();val planned=agenda.any{it.getString("outletId")==id};require(planned||reason.isNotBlank()){ "Give a reason for an extra call." };controller.queueDomain("dsr.visit.checkIn",JSONObject().put("distributorId",data.getString("distributorId")).put("clientVisitId",client).put("outletId",id).put("serviceDate",data.getString("serviceDate")).put("intents",JSONArray()).put("flowDefinitionId",config.getJSONObject("definition").getString("id")).put("callFlowSnapshot",config).put("unplannedReason",if(planned)"Configured partner beat call (not employee MCP)"else reason.trim()).put("location",fix),client)}},enabled=!controller.busy){Text("Start call")}
  }else{
   Text("Call in progress · immutable work is saved on this phone before upload.")
   val catalog=objects(data.optJSONArray("products"));val productIndex=productPage.coerceIn(0,maxOf(0,(catalog.size-1)/6))
   if(catalog.size>6)Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){FieldButton({productPage=productIndex-1},enabled=productIndex>0){Text("Previous products")};Text("${productIndex*6+1}–${minOf((productIndex+1)*6,catalog.size)} of ${catalog.size}");FieldButton({productPage=productIndex+1},enabled=(productIndex+1)*6<catalog.size){Text("Next products")}}
   if(CallFlowEngine.keyFor(config,"stock_check")!=null){Text("Stock observations",style=MaterialTheme.typography.titleMedium);for(p in catalog.drop(productIndex*6).take(6)){Text(p.optString("name",p.optString("code","Product")));Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){for(finding in listOf("present","absent"))FieldButton({attempt{CallFlowEngine.advance(config,done,"stock_check",hasOrder);send("dsr.visit.activity",JSONObject().put("activity",JSONObject().put("kind","inventory_check").put("productId",p.getString("productId")).put("icoFinding",finding))) }},enabled=!controller.busy){Text(if(finding=="present")"In stock"else"Out of stock")}}}}
   val msl=data.getJSONObject("availability").optJSONObject(id)
   val required=objects(msl?.optJSONArray("lines")).filter{it.optBoolean("required")}
   if(msl==null||msl.isNull("msl"))Text("MSL setup is needed from the office; no empty audit is certified.")else{
    Text("MSL availability",style=MaterialTheme.typography.titleMedium)
    val mslIndex=mslPage.coerceIn(0,maxOf(0,(required.size-1)/6))
    if(required.size>6)Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){FieldButton({mslPage=mslIndex-1},enabled=mslIndex>0){Text("Previous MSL")};Text("${answers.size} of ${required.size} answered");FieldButton({mslPage=mslIndex+1},enabled=(mslIndex+1)*6<required.size){Text("Next MSL")}}
    for(line in required.drop(mslIndex*6).take(6)){val product=line.getString("productId");Text(line.getString("name"));Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){FieldButton({answers=answers+(product to "present")}){Text(if(answers[product]=="present")"Present ✓"else"Present")};FieldButton({answers=answers+(product to "absent")}){Text(if(answers[product]=="absent")"Absent ✓"else"Absent")}}}
    FieldButton({attempt{CallFlowEngine.keyFor(config,"availability")?.let{CallFlowEngine.advance(config,done,"availability",hasOrder)};val rows=JSONArray();for(l in required)rows.put(JSONObject().put("productId",l.getString("productId")).put("state",checkNotNull(answers[l.getString("productId")])).put("method","tap"));send("dsr.availability.record",JSONObject().put("checkId",UUID.randomUUID().toString()).put("snapshotId",msl.getString("snapshotId")).put("callKey",aggregate).put("complete",true).put("lines",rows))}},enabled=!controller.busy&&required.isNotEmpty()&&required.all{answers[it.getString("productId")]!=null}){Text("Save availability")}
   }
   if(CallFlowEngine.keyFor(config,"order_build")!=null){
    Text("Distributor order request",style=MaterialTheme.typography.titleMedium);Text("Quantity intent only. This does not issue a Sunpride invoice or approve price/credit.")
    for(p in catalog.drop(productIndex*6).take(6)){val product=p.getString("productId");FieldTextField((cart[product]?:0).takeIf{it>0}?.toString().orEmpty(),{value->if(value.isBlank())cart=cart-product else value.toIntOrNull()?.takeIf{it in 1..99999}?.let{cart=cart+(product to it)}},label={Text(p.optString("name",p.optString("code","Product"))+" · "+p.getString("uom"))},modifier=Modifier.fillMaxWidth())}
    FieldButton({attempt{CallFlowEngine.advance(config,done,"order_build",true);val rows=JSONArray();for((product,quantity) in cart){val p=objects(data.getJSONArray("products")).first{it.getString("productId")==product};rows.put(JSONObject().put("productId",product).put("uom",p.getString("uom")).put("quantity",quantity))};send("dsr.visit.activity",JSONObject().put("activity",JSONObject().put("kind","order_intent").put("clientOrderId",UUID.randomUUID().toString()).put("lines",rows)))}},enabled=cart.isNotEmpty()&&!controller.busy){Text("Save order")}
   }
   FieldTextField(note,{note=it},label={Text("Call note")},modifier=Modifier.fillMaxWidth(),minLines=2)
   if(CallFlowEngine.keyFor(config,"note")!=null)FieldButton({attempt{CallFlowEngine.advance(config,done,"note",hasOrder);send("dsr.visit.activity",JSONObject().put("activity",JSONObject().put("kind","note").put("text",note.trim()))) }},enabled=note.trim().length in 1..2000&&!controller.busy){Text("Save note")}
   for(r in objects(config.getJSONArray("reasons")))FieldButton({zero=r.getString("code")}){Text((if(zero==r.getString("code"))"✓ "else"")+r.getString("label"))}
   FieldTextField(short,{short=it},label={Text("Short-call reason, if needed")},modifier=Modifier.fillMaxWidth())
   FieldButton({attempt{val p=JSONObject().put("deviceTime",now).put("location",fix).put("outcome","completed").put("zeroSaleReason",zero).put("shortCallReason",short.trim());CallFlowEngine.location(config,fix,now);val started=start?.getJSONObject("payload")?.getLong("deviceTime")?:java.time.Instant.parse(remote!!.getString("started_at")).toEpochMilli();CallFlowEngine.close(config,done,hasOrder,started,p);send("dsr.visit.checkOut",p)}},enabled=!controller.busy){Text("End call")}
  }
  message?.let{Text(it)}
  if(local.any{it.getString("state")=="review"})Text("Some retained work needs office reconciliation; it is not synced or safe to recapture blindly.")
  Spacer(Modifier.height(24.dp))
 }
}
