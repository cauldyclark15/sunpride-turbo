package com.sunpride.field.ui.diagnosticvisit

import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.sunpride.field.storage.RetailCaptureQueue
import com.sunpride.field.ui.LabeledField
import com.sunpride.field.ui.SecondaryButton
import com.sunpride.field.ui.SectionCard
import org.json.JSONArray
import org.json.JSONObject
import java.math.BigDecimal

/** F-310 F-311 F-313 F-315 F-317 F-318 F-320 F-321: steps inside the existing visit screen. */
@Composable
fun RetailAuditPanel(snapshot: JSONObject, busy: Boolean, photoCount: Int, call: String,
    onQueue: (String,JSONObject,()->Unit)->Unit) {
    val labels=linkedMapOf("planogram" to "Planogram", "posm" to "POSM audit", "freezer" to "Freezer audit",
        "expiry" to "Expiry audit", "promotion" to "Campaign compliance", "competitor" to "Competitor", "issue_log" to "Issue log")
    // FLD-102: the chosen kind and typed fields outlive a trip to the photo screen (see RetailDrafts).
    var kind by remember(call) { mutableStateOf(RetailDrafts.kind(call)) }
    SectionCard("Retail execution") {
        Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(10.dp)) {
            Text("Save on this phone, then sync. The latest photo from this call is attached. Photos available: $photoCount.")
            labels.forEach { (key,label) -> ChoiceRow(label,kind==key,{kind=key;RetailDrafts.setKind(call,key)},Modifier.testTag("retail-kind-$key"),!busy) }
            key(call,kind) { RetailFields(kind,snapshot,busy,call,onQueue) }
        }
    }
}

@Composable
private fun RetailFields(kind: String, snapshot: JSONObject, busy: Boolean, call: String, onQueue: (String,JSONObject,()->Unit)->Unit) {
    val masters=RetailCaptureQueue.objects(snapshot.optJSONArray("masters"))
    val choices=when(kind) {
        "freezer"->RetailCaptureQueue.objects(snapshot.optJSONArray("equipment"))
        "posm"->RetailCaptureQueue.objects(snapshot.optJSONArray("deployments"))+RetailCaptureQueue.objects(snapshot.optJSONArray("issuedPosm"))
        "promotion"->RetailCaptureQueue.objects(snapshot.optJSONArray("campaigns"))
        "expiry"->masters.filter { it.getString("kind")=="expiry_policy" }
        "issue_log"->masters.filter { it.getString("kind")=="incident_category" }
        else->emptyList()
    }
    val plan=snapshot.optJSONObject("planogram")
    val targets=plan?.optJSONObject("data")?.optJSONArray("lines")?.let(RetailCaptureQueue::objects).orEmpty()
    var draft by remember { mutableStateOf(RetailDrafts.get(call,kind).let { d ->
        d.copy(facings=targets.indices.map { d.facings.getOrElse(it) { "" } }, positions=targets.indices.map { d.positions.getOrElse(it) { "" } }) }) }
    fun edit(change: (RetailDraft)->RetailDraft) { draft=change(draft); RetailDrafts.put(call,kind,draft) }
    val selected=draft.selected; val first=draft.first; val second=draft.second; val third=draft.third; val fourth=draft.fourth
    val note=draft.note; val none=draft.none; val condition=draft.condition; val type=draft.type; val passed=draft.passed
    val facings=draft.facings; val positions=draft.positions
    var error by remember { mutableStateOf<String?>(null) }
    var saved by remember { mutableStateOf(false) }
    var scanning by remember { mutableStateOf(false) }
    fun field(label: String,value: String,tag: String,change:(String)->Unit): @Composable ()->Unit = {
        LabeledField(label,value,{change(it);saved=false},Modifier.fillMaxWidth().testTag(tag))
    }
    Text(RetailFormCheck.help(kind),Modifier.testTag("retail-help"))
    if(kind in setOf("freezer","posm","promotion","expiry","issue_log") && choices.isEmpty()) Text("No assigned setup is available in this offline snapshot. Sync or ask the office.")
    choices.forEachIndexed { index,m -> ChoiceRow(m.optString("label",m.optString("name",m.optString("unit_code","Item"))),selected==index,{edit { it.copy(selected=index) }},Modifier.testTag("retail-select-$index"),!busy) }
    when(kind) {
        "freezer" -> {
            choices.getOrNull(selected)?.getJSONObject("data")?.let { Text("Model: ${it.getString("model")} · SAP asset: ${it.getString("sapFixedAssetId")}") }
            field("Scanned serial",first,"retail-serial"){v->edit { it.copy(first=v) }}()
            SecondaryButton("Scan equipment label",{scanning=true},Modifier.fillMaxWidth().testTag("retail-scan"),enabled=!busy)
            if(scanning) com.sunpride.field.retail.EquipmentSerialScanner({v->edit { it.copy(first=v) };scanning=false},{scanning=false})
            field("Temperature °C",second,"retail-temperature"){v->edit { it.copy(second=v) }}()
            field("Own-product share %",third,"retail-share"){v->edit { it.copy(third=v) }}()
        }
        "expiry" -> {
            field("Batch number",first,"retail-batch"){v->edit { it.copy(first=v) }}()
            field("Expiry date · YYYY-MM-DD",second,"retail-expiry"){v->edit { it.copy(second=v) }}()
            field("Shelf quantity · pieces",third,"retail-quantity"){v->edit { it.copy(third=v) }}()
        }
        "planogram" -> {
            if(plan==null) Text("No planogram assigned. Ask the office to set a class target.")
            targets.forEachIndexed { index,line ->
                Text("${line.optString("productName","Product ${index+1}")} · target ${line.getInt("facings")} facings at ${line.getString("position")}")
                field("Actual facings",facings[index],"retail-facing-$index"){v->edit { it.copy(facings=it.facings.toMutableList().also { values->values[index]=v }) }}()
                field("Actual position",positions[index],"retail-position-$index"){v->edit { it.copy(positions=it.positions.toMutableList().also { values->values[index]=v }) }}()
            }
            field("Total shelf facings · all brands",first,"retail-total-facings"){v->edit { it.copy(first=v) }}()
        }
        "posm" -> listOf("good" to "Present, good condition","damaged" to "Present, damaged","missing" to "Missing").forEach { (key,label)->ChoiceRow(label,condition==key,{edit { it.copy(condition=key) }},enabled=!busy) }
        "promotion" -> {
            listOf("display" to "Display present","price" to "Price correct","posm" to "POSM up","stock" to "Stock sufficient").forEach { (key,label)->ChoiceRow(label,key in passed,{edit { it.copy(passed=if(key in it.passed) it.passed-key else it.passed+key) }},enabled=!busy) }
            choices.getOrNull(selected)?.optJSONArray("checklist")?.let { items -> (0 until items.length()).forEach { i ->
                val key="extra-$i";ChoiceRow(items.getString(i),key in passed,{edit { it.copy(passed=if(key in it.passed) it.passed-key else it.passed+key) }},enabled=!busy)
            } }
            Text("Selected checks pass; unselected checks fail. Every check is recorded.")
        }
        "competitor" -> {
            ChoiceRow("No competitor activity observed",none,{edit { it.copy(none=!it.none) }},Modifier.testTag("retail-none"),!busy)
            if(!none) {
                listOf("price" to "Price","promotion" to "Promotion","new_sku" to "Product launch","display" to "Display","shelf_share" to "Share of shelf").forEach { (key,label)->ChoiceRow(label,type==key,{edit { it.copy(type=key) }},enabled=!busy) }
                field("Brand",first,"retail-brand"){v->edit { it.copy(first=v) }}();field("Competitor SKU",second,"retail-sku"){v->edit { it.copy(second=v) }}()
                if(type=="price") field("Observed price · ₱",third,"retail-price"){v->edit { it.copy(third=v) }}()
                if(type=="shelf_share") field("Share of shelf %",third,"retail-competitor-share"){v->edit { it.copy(third=v) }}()
                if(type in setOf("promotion","display")) field("Display or promotion detail",fourth,"retail-description"){v->edit { it.copy(fourth=v) }}()
                field("Observation",note,"retail-competitor-note"){v->edit { it.copy(note=v) }}()
            }
        }
        "issue_log" -> {
            ChoiceRow("No incident observed",none,{edit { it.copy(none=!it.none) }},Modifier.testTag("retail-none"),!busy)
            if(!none) field("Incident details",note,"retail-incident-note"){v->edit { it.copy(note=v) }}()
        }
    }
    error?.let { Text(it,Modifier.testTag("retail-form-error")) }
    if(saved) Text("Audit saved on this phone. Sync uploads the photo and observation.",Modifier.testTag("retail-saved"))
    val choiceLabel=when(kind) { "freezer"->"freezer or cooler"; "posm"->"display material"; "promotion"->"campaign"
        "expiry"->"expiry setup"; "issue_log"->if(none) null else "incident category"; else->null }
    SecondaryButton("Save",save@{
        // FLD-102: name the field that stops Save instead of a generic "check the fields".
        RetailFormCheck.missing(kind,draft,choiceLabel,choices.isNotEmpty(),targets.mapIndexed { i,l -> l.optString("productName","Product ${i+1}") })
            ?.let { error=it;saved=false;return@save }
        try {
            val at=System.currentTimeMillis();val d=JSONObject();val m=choices.getOrNull(selected)
            when(kind) {
                "freezer"->d.put("equipmentVersionId",checkNotNull(m).getString("id")).put("scannedSerial",first.trim())
                    .put("temperatureDeciC",BigDecimal(second).movePointRight(1).longValueExact()).put("ownSharePercent",third.toLong()).put("measuredAt",at)
                "expiry"->d.put("lines",JSONArray().put(JSONObject().put("productId",checkNotNull(m).getJSONObject("data").getString("productId")).put("batch",first.trim()).put("expiryDate",second.trim()).put("quantityBase",third.toLong())))
                "planogram"->{val lines=JSONArray();targets.forEachIndexed { i,l->lines.put(JSONObject().put("productId",l.getString("productId")).put("facings",facings[i].toLong()).put("position",positions[i].trim())) };d.put("masterVersionId",checkNotNull(plan).getString("id")).put("lines",lines).put("ownFacings",facings.sumOf { it.toLong() }).put("totalFacings",first.toLong())}
                "posm"->d.put("unitCode",checkNotNull(m).getString("unit_code")).put("action",if(m.optString("kind")=="issue") "deploy" else "audit").put("present",condition!="missing").put("condition",condition)
                "promotion"->{d.put("campaignVersionId",checkNotNull(m).getString("id"));listOf("display","price","posm","stock").forEach { d.put(it,it in passed) };val checks=JSONArray();val items=m.getJSONArray("checklist");for(i in 0 until items.length()) checks.put(JSONObject().put("label",items.getString(i)).put("passed","extra-$i" in passed));d.put("checklist",checks)}
                "competitor"-> {d.put("noneObserved",none);if(!none) {d.put("type",type).put("brand",first.trim()).put("sku",second.trim()).put("note",note.trim());if(type=="price") d.put("priceCentavos",BigDecimal(third).movePointRight(2).longValueExact());if(type=="shelf_share") d.put("sharePercent",third.toLong());if(type in setOf("display","promotion")) d.put("description",fourth.trim())}}
                "issue_log"->{d.put("noneObserved",none);if(!none) d.put("categoryVersionId",checkNotNull(m).getString("id")).put("note",note.trim())}
            }
            // Incident geo comes from the existing visit-location provider in the parent, never a typed coordinate.
            if(kind!="issue_log" || none) RetailCaptureQueue.validateData(kind,d,snapshot,at)
            error=null;saved=false;onQueue(kind,d){saved=true;RetailDrafts.clear(call,kind)}
        } catch(e: Exception) {
            // A named rule from the shared validator ("Scan the serial on this store's equipment") beats the fallback.
            error=e.message?.takeIf { it.isNotBlank() && it!="Failed requirement." && it.first().isUpperCase() && ' ' in it }
                ?: "Check the fields and downloaded setup before saving.";saved=false}
    },Modifier.fillMaxWidth().testTag("retail-save"),enabled=!busy && (kind !in setOf("freezer","posm","promotion","expiry") || choices.isNotEmpty()) && (kind!="planogram" || plan!=null))
}
