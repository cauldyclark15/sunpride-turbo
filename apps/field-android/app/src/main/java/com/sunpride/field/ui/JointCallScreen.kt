package com.sunpride.field.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** F-223 complete canonical form payload, independent of Compose and transport. */
object JointCallDraft {
 fun create(day:String,detail:JSONObject?):JSONObject {
  val s=detail?.getJSONObject("session")
  val a=JSONObject().put("serviceDate",s?.optString("serviceDate")?:day).put("objective",s?.optString("objective")?:"training").put("mode",s?.optString("mode")?:"booking")
   .put("truckReference",s?.optString("truckReference").orEmpty()).put("rodeWithTruck",s?.optBoolean("rodeWithTruck")?:false)
   .put("traineeProfileId",s?.optString("traineeProfileId").orEmpty()).put("observations",s?.optJSONArray("observations")?:JSONArray())
   .put("trainingLog",s?.optJSONObject("trainingLog")?:JSONObject().put("topics","").put("tradeDevelopment","").put("discussedWithTrainee",false))
   .put("preCall",s?.optJSONObject("preCall")?:JSONObject().put("documents",JSONArray()).put("remarks",""))
   .put("postCall",s?.optJSONObject("postCall")?:JSONObject().put("strengths","").put("weaknesses","").put("opportunities","").put("threats",""))
   .put("reviews",JSONArray())
  if(s!=null)a.put("sessionId",s.getString("id")).put("expectedRevision",detail.getString("revision"))
  val actions=detail?.optJSONObject("jointCall")?.optJSONArray("agreed")?:JSONArray()
  if((0 until actions.length()).all{actions.getJSONObject(it).optString("status","open")=="open"})a.put("actions",actions)
  return JSONObject(a.toString())
 }
 fun payload(draft:JSONObject,complete:Boolean):JSONObject=JSONObject(draft.toString()).put("complete",complete)
}

/** Same supervisor model and encrypted queue; server completion checks are never replaced by checkboxes. */
@Composable fun JointCallScreen(c:FieldController,modifier:Modifier=Modifier){
 val life=c.sapMasterLifetime();val scope=rememberCoroutineScope()
 var data by remember(life){mutableStateOf<JSONObject?>(null)};var refresh by remember{mutableStateOf(1)}
 var loading by remember{mutableStateOf(false)};var selection by remember(life){mutableStateOf<String?>(null)}
 var now by remember{mutableStateOf(System.currentTimeMillis())}
 LaunchedEffect(Unit){while(true){kotlinx.coroutines.delay(1000);now=System.currentTimeMillis()}}
 LaunchedEffect(life,refresh,c.today.lastSynced){val before=life;loading=true;val next=try{withContext(Dispatchers.IO){c.domainForms("jointcall",refresh>0)}}catch(e:Exception){if(e is kotlinx.coroutines.CancellationException)throw e;null};if(before==c.sapMasterLifetime())data=next;loading=false}
 fun rows(a:JSONArray?)=a?.let{(0 until it.length()).map(it::getJSONObject)}.orEmpty()
 Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp).testTag("joint-call-form"),verticalArrangement=Arrangement.spacedBy(10.dp)){
  NoticeCard("Save on this phone while offline. Upload uses the office's existing session, observation and follow-up rules.")
  FieldButton({refresh++},Modifier.fillMaxWidth(),enabled=!loading&&!c.busy){Text(if(loading)"Refreshing…"else"Refresh authorized forms")}
  c.error?.let{NoticeCard(it,tone=Look.Tone.BAD)}
  val d=data?.takeIf{it.optLong("authorizationExpiresAt")>now}
  if(d==null){NoticeCard("Connect to verify today's supervisor assignment before recording. Held or expired forms cannot be edited.",tone=Look.Tone.WARN,glyph=GlyphKind.LOCK);return@Column}
  val sessions=rows(d.optJSONArray("sessions"));val locals=rows(d.optJSONArray("localOperations"))
  for(x in sessions)ChoiceRow("${x.getString("traineeName")} · ${x.getJSONObject("session").getString("serviceDate")}",selection==x.getJSONObject("session").getString("id"),{selection=x.getJSONObject("session").getString("id")})
  if(d.getBoolean("canStart"))FieldButton({selection="new"},Modifier.fillMaxWidth()){Text("New joint call")}
  Text("${locals.count{it.getString("state") in setOf("pending","sending")}} queued · ${locals.count{it.getString("state") in setOf("review","held")}} need reconciliation",style=MaterialTheme.typography.titleSmall)
  val latestLocal=locals.groupBy{it.getString("aggregateId")}.mapNotNull{(_,items)->items.lastOrNull()}.filter{it.getString("state") in setOf("pending","sending")&&!it.getJSONObject("payload").optBoolean("complete")}
  for(row in latestLocal)ChoiceRow("Continue retained draft · "+row.getJSONObject("payload").getString("serviceDate"),selection=="local:"+row.getString("requestId"),{selection="local:"+row.getString("requestId")})
  val chosen=selection?:return@Column
  val retained=latestLocal.firstOrNull{"local:"+it.getString("requestId")==chosen}
  val detail=sessions.firstOrNull{it.getJSONObject("session").getString("id")==chosen}
  if(chosen!="new"&&detail==null&&retained==null){Text("Refresh before reopening this session.");return@Column}
  if(chosen!="new"&&locals.any{it.getString("aggregateId")==chosen&&it.getString("state") in setOf("pending","sending")}){Text("This form is retained on the phone. Sync before editing again to avoid overwriting it.");return@Column}
  var text by remember(life,chosen,detail?.optString("revision")){mutableStateOf(retained?.getJSONObject("payload")?.toString()?:JointCallDraft.create(d.getString("serviceDate"),detail).toString())}
  val a=JSONObject(text)
  fun change(block:(JSONObject)->Unit){val copy=JSONObject(text);block(copy);text=copy.toString()}
  @Composable fun field(label:String,value:String,edit:(String)->Unit){FieldTextField(value,edit,label={Text(label)},modifier=Modifier.fillMaxWidth(),minLines=2)}
  if(detail==null&&retained==null){Text("Choose trainee");for(p in rows(d.optJSONArray("trainees")))ChoiceRow(p.getString("name"),a.optString("traineeProfileId")==p.getString("id"),{change{it.put("traineeProfileId",p.getString("id"))}})}else Text(detail?.getString("traineeName")?:rows(d.optJSONArray("trainees")).firstOrNull{it.getString("id")==a.getString("traineeProfileId")}?.getString("name")?:"Retained trainee",style=MaterialTheme.typography.titleMedium)
  Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){for(value in listOf("training","sales_validation"))FieldButton({change{it.put("objective",value)}},enabled=detail==null&&retained==null){Text((if(a.getString("objective")==value)"✓ "else"")+if(value=="training")"Training"else"Sales validation")}}
  Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){for(value in listOf("booking","truck"))FieldButton({change{it.put("mode",value)}},enabled=detail==null&&retained==null){Text((if(a.getString("mode")==value)"✓ "else"")+value)}}
  if(a.getString("mode")=="truck"){field("Truck reference",a.optString("truckReference")){v->change{it.put("truckReference",v)}};Row{Checkbox(a.getBoolean("rodeWithTruck"),{v->change{it.put("rodeWithTruck",v)}});Text("I rode the named truck")}}
  HorizontalDivider(color=Look.hairline)
  Text("Observed call procedure & selling",style=MaterialTheme.typography.titleMedium)
  for((i,o) in rows(a.getJSONArray("observations")).withIndex()){
   Text(if(o.getString("area")=="bcp")"Basic Call Procedure"else"Persuasive Selling Format")
   field("Observed item",o.optString("item")){v->change{it.getJSONArray("observations").getJSONObject(i).put("item",v)}}
   Row(horizontalArrangement=Arrangement.spacedBy(6.dp)){for(value in listOf("met","partial","not_met"))FieldButton({change{it.getJSONArray("observations").getJSONObject(i).put("rating",value)}}){Text((if(o.optString("rating")==value)"✓ "else"")+value.replace('_',' '))}}
   field("Observation remark",o.optString("remark")){v->change{it.getJSONArray("observations").getJSONObject(i).put("remark",v)}}
   TextButton({change{it.getJSONArray("observations").remove(i)}}){Text("Remove observation")}
  }
  Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){for(area in listOf("bcp","psf"))FieldButton({change{it.getJSONArray("observations").put(JSONObject().put("area",area).put("item","").put("rating","").put("remark",""))}},enabled=a.getJSONArray("observations").length()<40){Text("Add ${area.uppercase()}")}}
  val log=a.getJSONObject("trainingLog")
  field("Training topics",log.optString("topics")){v->change{it.getJSONObject("trainingLog").put("topics",v)}}
  field("Trade development",log.optString("tradeDevelopment")){v->change{it.getJSONObject("trainingLog").put("tradeDevelopment",v)}}
  Row{Checkbox(log.optBoolean("discussedWithTrainee"),{v->change{it.getJSONObject("trainingLog").put("discussedWithTrainee",v)}});Text("Discussed with the trainee")}
  HorizontalDivider(color=Look.hairline)
  Text("Pre-call review",style=MaterialTheme.typography.titleMedium)
  for(doc in listOf("distribution","productivity","daily_productive_sales_report","call_sheet")){
   val checked=(0 until a.getJSONObject("preCall").getJSONArray("documents").length()).map{a.getJSONObject("preCall").getJSONArray("documents").getString(it)}
   Row{Checkbox(doc in checked,{v->change{it.getJSONObject("preCall").put("documents",JSONArray(if(v)checked+doc else checked-doc))}});Text(doc.replace('_',' '))}
  }
  field("Pre-call remarks",a.getJSONObject("preCall").optString("remarks")){v->change{it.getJSONObject("preCall").put("remarks",v)}}
  for(k in listOf("strengths","weaknesses","opportunities","threats"))field(k.replaceFirstChar{it.uppercase()},a.getJSONObject("postCall").optString(k)){v->change{it.getJSONObject("postCall").put(k,v)}}
  val carried=detail?.getJSONObject("jointCall")?.optJSONArray("carried")?:rows(d.optJSONArray("trainees")).firstOrNull{it.getString("id")==a.optString("traineeProfileId")}?.optJSONArray("carried")
  for(old in rows(carried).filter{it.getString("status")=="open"}){
   Text("Earlier agreement · ${old.getString("agreement")}")
   val id=old.getString("id");val review=rows(a.getJSONArray("reviews")).firstOrNull{it.getString("actionId")==id}
   fun reviewChange(block:(JSONObject)->Unit){change{root->val all=rows(root.getJSONArray("reviews")).toMutableList();val r=all.firstOrNull{it.getString("actionId")==id}?:JSONObject().put("actionId",id).put("outcome","").put("note","").also(all::add);block(r);root.put("reviews",JSONArray(all))}}
   Row{for(value in listOf("done","not_done"))FieldButton({reviewChange{it.put("outcome",value)}}){Text((if(review?.optString("outcome")==value)"✓ "else"")+value.replace('_',' '))}}
   field("Follow-up evidence",review?.optString("note").orEmpty()){v->reviewChange{it.put("note",v)}}
  }
  HorizontalDivider(color=Look.hairline)
  Text("Agreed next actions",style=MaterialTheme.typography.titleMedium)
  if(!a.has("actions"))Text("Previously reviewed actions are locked. Agree new actions in the next session.")else{
   for((i,x) in rows(a.getJSONArray("actions")).withIndex()){
    field("Agreement",x.optString("agreement")){v->change{it.getJSONArray("actions").getJSONObject(i).put("agreement",v)}}
    field("Due day · YYYY-MM-DD",x.optString("dueOn")){v->change{it.getJSONArray("actions").getJSONObject(i).put("dueOn",v)}}
    Row{for(owner in listOf("trainee","trainer"))FieldButton({change{it.getJSONArray("actions").getJSONObject(i).put("owner",owner)}}){Text((if(x.getString("owner")==owner)"✓ "else"")+owner)}}
    TextButton({change{it.getJSONArray("actions").remove(i)}}){Text("Remove agreement")}
   }
   FieldButton({change{it.getJSONArray("actions").put(JSONObject().put("agreement","").put("owner","trainee").put("dueOn",a.getString("serviceDate")))}},enabled=a.getJSONArray("actions").length()<10){Text("Add agreement")}
  }
  detail?.optJSONArray("gaps")?.let{for(g in rows(it))Text(g.getString("label"),style=MaterialTheme.typography.bodySmall)}
  Text("Completion is checked again by the office, including actual MCP execution and earlier agreements. It is not complete until acknowledged.",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
  for(complete in listOf(false,true))FieldButton({val payload=JointCallDraft.payload(a,complete);val dependencies=retained?.let{listOf(it.getString("requestId"))}.orEmpty();if(retained!=null){payload.put("previousRequestId",retained.getString("requestId")).remove("expectedRevision");if(!payload.has("sessionId")&&!payload.has("localSessionRequestId"))payload.put("localSessionRequestId",retained.getString("requestId"))};scope.launch{c.queueDomain("jointcall.capture",payload,retained?.getString("aggregateId")?:if(chosen=="new")UUID.randomUUID().toString()else chosen,dependencies).join();if(c.error==null){selection=null;text=JointCallDraft.create(d.getString("serviceDate"),null).toString()};data=withContext(Dispatchers.IO){c.domainForms("jointcall",false)}}},modifier=Modifier.fillMaxWidth(),enabled=!c.busy&&a.optString("traineeProfileId").isNotBlank(),primary=complete){Text(if(complete)"Save & request completion"else"Save draft on phone")}
  FieldButton(c::syncNow,enabled=!c.busy){Text("Sync retained forms")}
  Spacer(Modifier.height(24.dp))
 }
}
