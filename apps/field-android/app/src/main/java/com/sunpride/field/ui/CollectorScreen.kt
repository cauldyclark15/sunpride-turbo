package com.sunpride.field.ui

import android.graphics.Bitmap
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.math.BigDecimal
import java.io.ByteArrayOutputStream
import java.util.UUID

/** F-613 canonical minor units; neither a bank clearance nor a local AR posting. */
object CollectorDraft {
 fun minor(text:String):Long {
  val n=try{BigDecimal(text.trim()).movePointRight(2).longValueExact()}catch(_:Exception){throw IllegalArgumentException("Enter a positive peso amount with at most two decimal places")}
  require(n in 1..99_999_999_999L){"Enter an amount within the supported range"};return n
 }
 fun payload(action:String,day:String,code:String,note:String)=JSONObject().put("action",action).put("serviceDate",day).put("customerCode",code).put("note",note.trim())
 fun photo(bitmap:Bitmap):JSONObject {
  val scale=minOf(1.0,640.0/maxOf(bitmap.width,bitmap.height))
  val reduced=Bitmap.createScaledBitmap(bitmap,maxOf(32,(bitmap.width*scale).toInt()),maxOf(32,(bitmap.height*scale).toInt()),true)
  try{for(quality in listOf(75,55,35)){
   val out=ByteArrayOutputStream();check(reduced.compress(Bitmap.CompressFormat.JPEG,quality,out));val bytes=out.toByteArray()
   if(bytes.size<=64*1024)return JSONObject().put("mimeType","image/jpeg").put("bytesBase64",android.util.Base64.encodeToString(bytes,android.util.Base64.NO_WRAP)).put("sha256",com.sunpride.field.device.RequestSigner.bodyDigest(bytes))
  }}finally{if(reduced!==bitmap)reduced.recycle()}
  error("Retake a simpler, clear cheque photo; the bounded offline capture is too large")
 }
}

/** Own dated collector route. Captures use the existing Money writers and encrypted domain outbox. */
@Composable fun CollectorScreen(c:FieldController,modifier:Modifier=Modifier){
 val life=c.sapMasterLifetime();val scope=rememberCoroutineScope()
 var data by remember(life){mutableStateOf<JSONObject?>(null)};var refresh by remember{mutableStateOf(1)}
 var loading by remember{mutableStateOf(false)};var selected by remember(life){mutableStateOf<String?>(null)}
 var amount by remember(life,selected){mutableStateOf("")};var note by remember(life,selected){mutableStateOf("")}
 var date by remember(life,selected){mutableStateOf("")};var bank by remember(life,selected){mutableStateOf("")};var number by remember(life,selected){mutableStateOf("")}
 var item by remember(life,selected){mutableStateOf<String?>(null)};var replacement by remember(life,selected){mutableStateOf<String?>(null)}
 var photo by remember(life,selected){mutableStateOf<JSONObject?>(null)};var message by remember(life,selected){mutableStateOf<String?>(null)}
 var cameraTicket by remember{mutableStateOf<Triple<String?,String?,Long>?>(null)}
 var now by remember{mutableStateOf(System.currentTimeMillis())};var page by remember(life){mutableStateOf(0)}
 LaunchedEffect(Unit){while(true){kotlinx.coroutines.delay(1000);now=System.currentTimeMillis()}}
 LaunchedEffect(life,refresh,c.today.lastSynced){loading=true;val before=life;val next=try{withContext(Dispatchers.IO){c.domainForms("collections",true)}}catch(e:Exception){if(e is kotlinx.coroutines.CancellationException)throw e;null};if(before==c.sapMasterLifetime())data=next;loading=false}
 val camera=rememberLauncherForActivityResult(ActivityResultContracts.TakePicturePreview()){bitmap->
  val ticket=cameraTicket;cameraTicket=null
  if(bitmap!=null&&ticket!=null)scope.launch{
   try{val value=withContext(Dispatchers.IO){CollectorDraft.photo(bitmap)};if(ticket.first==c.sapMasterLifetime()&&ticket.second==selected&&com.sunpride.field.sync.DomainOutbox.current(ticket.third))photo=value}
   catch(e:Exception){if(e is kotlinx.coroutines.CancellationException)throw e;message="Retake a clear, smaller photo."}
   finally{bitmap.recycle()}
  }
 }
 fun rows(a:JSONArray?)=a?.let{(0 until it.length()).map(it::getJSONObject)}.orEmpty()
 fun send(payload:JSONObject){scope.launch{c.queueDomain("collections.capture",payload,UUID.randomUUID().toString()).join();message=if(c.error==null)"Saved on this phone, awaiting office acknowledgement."else c.error;data=withContext(Dispatchers.IO){c.domainForms("collections",false)}}}
 fun attempt(block:()->Unit){try{message=null;block()}catch(e:IllegalArgumentException){message=e.message}catch(e:IllegalStateException){message=e.message}}
 Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp).testTag("collector-agenda"),verticalArrangement=Arrangement.spacedBy(10.dp)){
  NoticeCard("Your assigned collection stops. Promises and cheque evidence do not reduce SAP AR or certify bank clearance.")
  FieldButton({refresh++},Modifier.fillMaxWidth(),enabled=!loading&&!c.busy){Text(if(loading)"Refreshing…"else"Refresh")}
  c.error?.let{NoticeCard(it,tone=Look.Tone.BAD)};message?.let{NoticeCard(it)}
  val d=data?.takeIf{it.optLong("authorizationExpiresAt")>now}
  if(d==null){NoticeCard("Connect to verify today's collector assignment. Held or expired data cannot record.",tone=Look.Tone.WARN,glyph=GlyphKind.LOCK);return@Column}
  Text(d.getString("warning"),style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
  val stops=rows(d.optJSONArray("stops"));val local=rows(d.optJSONArray("localOperations"))
  Text("${stops.size} stops · ${local.count{it.getString("state") in setOf("pending","sending")}} queued · ${local.count{it.getString("state") in setOf("review","held")}} need reconciliation",style=MaterialTheme.typography.titleSmall)
  val shown=page.coerceIn(0,maxOf(0,(stops.size-1)/6))
  for(s in stops.drop(shown*6).take(6)){
   ChoiceRow("${s.getInt("sequence")}. ${s.getString("name")} · ${s.getString("reason").replace('_',' ')}",selected==s.getString("customerCode"),{selected=s.getString("customerCode")},enabled=!c.busy)
   val index=stops.indexOf(s)
   if(index>0)TextButton({val order=stops.map{it.getString("customerCode")}.toMutableList();java.util.Collections.swap(order,index,index-1);send(JSONObject().put("action","route.order").put("serviceDate",d.getString("serviceDate")).put("customerCodes",JSONArray(order)))},enabled=!c.busy&&local.none{it.getString("state") in setOf("pending","sending")}){Text("Visit before previous stop")}
  }
  if(stops.size>6)Row{FieldButton({page=shown-1},enabled=shown>0){Text("Previous stops")};FieldButton({page=shown+1},enabled=(shown+1)*6<stops.size){Text("Next stops")}}
  if(stops.isEmpty())EmptyState("No stops today","No collection route assigned for today. The office plans it in Money.",GlyphKind.ROUTE)
  val s=stops.firstOrNull{it.getString("customerCode")==selected}?:return@Column
  val code=s.getString("customerCode");val day=d.getString("serviceDate")
  HorizontalDivider(color=Look.hairline)
  Text(s.getString("name"),style=MaterialTheme.typography.titleLarge)
  val ar=s.optJSONObject("ar")
  Text(ar?.getString("source")?:"AR unknown: no current replicated open item. This does not mean paid.",style=MaterialTheme.typography.bodyMedium)
  if(ar!=null)Text("${ar.getString("freshness")} · source day ${ar.getString("asOfDate")}",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
  Text("Promise to pay",style=MaterialTheme.typography.titleMedium)
  for(i in rows(ar?.optJSONArray("items")))ChoiceRow(i.optString("documentNumber","Open item")+" · due "+i.getString("dueDate")+" · ₱"+BigDecimal.valueOf(i.getLong("remainingMinor"),2).toPlainString(),item==i.getString("ref"),{item=i.getString("ref")})
  @Composable fun field(label:String,value:String,edit:(String)->Unit){FieldTextField(value,edit,label={Text(label)},modifier=Modifier.fillMaxWidth())}
  field("Amount · pesos",amount,{amount=it});field("Promise / cheque day · YYYY-MM-DD",date,{date=it})
  field("Capture / bank-notice evidence note",note,{note=it})
  FieldButton({attempt{java.time.LocalDate.parse(date);require(note.trim().isNotEmpty()){ "Write the promise evidence note" };val p=CollectorDraft.payload("promise",day,code,note).put("amountMinor",CollectorDraft.minor(amount)).put("promisedOn",date).put("openItemRef",checkNotNull(item)).put("sourceHash",checkNotNull(ar).getString("sourceHash"));send(p)}},enabled=!c.busy&&item!=null&&ar!=null,primary=true){Text("Save promise")}
  HorizontalDivider(color=Look.hairline)
  Text("Cheque custody & bank-notice tracking",style=MaterialTheme.typography.titleMedium)
  field("Bank",bank,{bank=it});field("Cheque number",number,{number=it})
  FieldButton({attempt{cameraTicket=Triple(c.sapMasterLifetime(),selected,com.sunpride.field.sync.DomainOutbox.ticket());camera.launch(null)}},enabled=!c.busy){Text(if(photo==null)"Take photo"else"Retake photo")}
  if(photo!=null)NoticeCard("Bounded JPEG retained with the encrypted form. It is sent only when this capture is saved.",tone=Look.Tone.GOOD,glyph=GlyphKind.CHECK)
  for(q in rows(s.optJSONArray("cheques")).filter{it.getString("status")=="bounced"})ChoiceRow("Replace bounced ${q.getString("bank")} ${q.getString("chequeNumber")}",replacement==q.getString("id"),{replacement=q.getString("id")})
  if(replacement!=null)TextButton({replacement=null}){Text("Do not link a replacement")}
  FieldButton({attempt{java.time.LocalDate.parse(date);require(note.trim().isNotEmpty()&&bank.trim().isNotEmpty()&&number.trim().isNotEmpty()){ "Write bank, cheque number and capture note" };val p=CollectorDraft.payload("cheque.receive",day,code,note).put("amountMinor",CollectorDraft.minor(amount)).put("chequeDate",date).put("bank",bank.trim()).put("chequeNumber",number.trim()).put("replacesId",replacement).put("photo",photo);send(p)}},enabled=!c.busy,primary=true){Text("Save cheque")}
  for(q in rows(s.optJSONArray("cheques"))){
   Text("${q.getString("bank")} ${q.getString("chequeNumber")} · ${q.getString("chequeDate")} · ${q.getString("status")}")
   if(q.getString("status")=="deposited")FieldButton({attempt{require(note.trim().isNotEmpty()){ "Write the bank's bounce reason" };send(CollectorDraft.payload("cheque.bounced",day,code,note).put("chequeId",q.getString("id")).put("photo",photo))}},enabled=!c.busy){Text("Save bounced cheque")}
  }
  for(p in rows(s.optJSONArray("promises")))Text("Promise due ${p.getString("promisedOn")} · ₱${BigDecimal.valueOf(p.getLong("amountMinor"),2).toPlainString()} · ${p.getString("note")}")
  FieldButton(c::syncNow,enabled=!c.busy){Text("Sync")}
  Text("A queued or review capture is not an acknowledged collection. Reconcile it before recapturing. Only the office marks deposits/clearance and SAP owns the balance.",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
  Spacer(Modifier.height(24.dp))
 }
}
