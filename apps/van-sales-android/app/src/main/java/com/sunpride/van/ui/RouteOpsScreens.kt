package com.sunpride.van.ui

import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import com.sunpride.van.ledger.BatchPosition
import com.sunpride.van.sync.VanBootstrapCodec
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONObject

/** F-104/F-114/F-115/F-116/F-121 adapters, not a second call-flow engine. All saves are local. */
@Composable fun RouteOpsScreen(c: VanController) {
    val scope=rememberCoroutineScope()
    var saved by remember { mutableStateOf(emptyList<JSONObject>()) }
    var batches by remember { mutableStateOf(emptyList<BatchPosition>()) }
    var snapshot by remember { mutableStateOf<JSONObject?>(null) }
    var scorecard by remember { mutableStateOf<JSONObject?>(null) }
    var containers by remember { mutableStateOf(emptyList<JSONObject>()) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var temperature by remember { mutableStateOf("") }
    var checkpoint by remember { mutableStateOf(if(c.trip?.status in setOf("active","reconciling","review_required")) "delivery" else "load_out") }
    var customer by remember { mutableStateOf(c.selectedCustomer?.outletId?:c.customers.firstOrNull()?.outletId?:"") }
    var type by remember { mutableStateOf("crate") }
    var action by remember { mutableStateOf("issue") }
    var quantity by remember { mutableStateOf("") }
    var product by remember { mutableStateOf(c.products.firstOrNull()?.productId?:"") }
    var reloadQuantity by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("") }
    suspend fun refresh() { snapshot=c.repository.routeSnapshot(); saved=c.repository.routeObservations(); batches=c.repository.batchPositions();scorecard=c.repository.routeScorecard();containers=c.repository.routeContainerPosition() }
    fun save(block: suspend ()->Unit) { if(busy) return; scope.launch {
        busy=true; message=null
        try { block(); refresh(); message="Saved on this phone. Pending sync." }
        catch(e: CancellationException) { throw e }
        catch(_: Exception) { message="Not saved. Check the reading, selected store, quantities and final stock count." }
        finally { busy=false }
    } }
    LaunchedEffect(c.trip?.tripId) { refresh() }
    ScreenFrame("Route controls",c::back,message=message) {
        Text("Saved offline on this phone. Warehouse receipt and supervisor sign-off follow after sync.")
        val state=snapshot?.optString("settlementState")?.takeIf { it!="null" && it.isNotEmpty() }
        if(c.tripClosed) Text(when(state) { "pending_supervisor"->"Pending supervisor";"rejected"->"Returned for correction · office follow-up needed";"posted"->"Posted";"approved_pending_sap"->"Approved · waiting for SAP";else->"Locally completed · pending sync" },Modifier.testTag("local-settlement-state"))
        scorecard?.let {card->SectionCard("Daily scorecard") {
            Text("Sales before returns · ${routeMoney(card.optString("salesCentavos"))}",Modifier.testTag("route-scorecard-sales"))
            Text("Calls · ${card.optInt("calls")} of ${card.optInt("plannedCalls")} planned stores")
            Text("Strike rate · ${if(card.isNull("strikeRateBasisPoints")) "Needs actual stop facts" else "${card.getInt("strikeRateBasisPoints")/100.0}%"}")
            Text("Drop size · ${routeMoney(card.optString("dropSizeCentavos"))}")
            Text("Returns · ${card.optInt("returnDocuments")} documents · refunded ${routeMoney(card.optString("refundsCentavos"))}")
            Text("Collected · ${routeMoney(card.optString("collectedCentavos"))}")
            Text("Cash variance · ${routeMoney(card.optString("cashVarianceCentavos"))} · stock differences ${if(card.isNull("stockVarianceLines")) "Not counted" else card.getInt("stockVarianceLines")}")
            Text("Monthly sales · ${routeMoney(card.optString("monthSalesCentavos"))} / target ${routeMoney(card.optString("monthTargetCentavos"))}")
            card.optJSONObject("prior")?.let {prior->Text("Previous trip ${prior.optString("date")} · ${routeMoney(prior.optString("salesCentavos"))}")}
            Text(if(card.optBoolean("localProjection")) "Includes work saved here and not yet reflected by the office." else "From the last authorized office snapshot.",style=MaterialTheme.typography.bodySmall)
        } }
        SectionCard("Actual stop times") {
            Choice("Stop store",customer,c.customers.map {it.outletId to it.name}) {customer=it}
            SecondaryButton("Record arrival",{save {c.repository.recordStop(customer,"arrival")}},enabled=!busy && !c.tripClosed && customer.isNotBlank())
            SecondaryButton("Record departure",{save {c.repository.recordStop(customer,"departure")}},enabled=!busy && !c.tripClosed && customer.isNotBlank())
            saved.filter {it.getString("kind")=="stop"}.takeLast(8).forEach {o->val f=o.getJSONObject("facts");Text("${f.getString("phase")} · ${o.optString("outletName").takeIf {it.isNotBlank() && it!="null"}?:c.customers.firstOrNull {it.outletId==f.optString("outletId")}?.name?:"Store"}")}
        }
        SectionCard("Cold chain") {
            val interval=snapshot?.getJSONObject("policies")?.getJSONObject("cold_chain")?.getInt("intervalMinutes")
            Text("Record at load-out, every ${interval?:60} minutes and each delivery. Out-of-band readings go to office review.")
            Choice("Checkpoint",checkpoint,listOf("load_out" to "Load-out","interval" to "Interval","delivery" to "Delivery")) { checkpoint=it }
            if(checkpoint=="delivery") Choice("Delivery store",customer,c.customers.map { it.outletId to it.name }) { customer=it }
            LabeledField("Temperature (°C)",temperature,{temperature=it},"route-temperature",maxLength=8)
            val deci=runCatching { java.math.BigDecimal(temperature).movePointRight(1).intValueExact() }.getOrNull()
            PrimaryBottomButton("Save temperature",{save { c.repository.recordTemperature(checkNotNull(deci),checkpoint,customer.takeIf { checkpoint=="delivery" }); temperature="" }},!busy && !c.tripClosed && deci in -1000..600,"save-temperature")
            saved.filter { it.getString("kind")=="temperature" }.takeLast(8).reversed().forEach {
                val f=it.getJSONObject("facts")
                Text("${f.getInt("deciC")/10.0} °C · ${f.getString("checkpoint").replace('_',' ')} · ${if(f.optBoolean("excursion") || f.optBoolean("lateFromPrior")) "Needs quality review" else "Recorded"}")
            }
        }
        SectionCard("Crates and trays") {
            Choice("Store",customer,listOf("" to "On the van · physical count")+c.customers.map { it.outletId to it.name }) { customer=it }
            val types=snapshot?.getJSONObject("policies")?.getJSONObject("returnables")?.getJSONArray("items")?.let(VanBootstrapCodec::objects)?.map { it.getString("code") to it.getString("label") }?:emptyList()
            Choice("Container",type,types) {type=it}
            Choice("Movement",action,listOf("issue" to "Issue to store","receive" to "Receive from store","count" to "Count at store")) {action=it}
            LabeledField("Number of containers",quantity,{quantity=it},"route-containers",numeric=true,maxLength=8)
            PrimaryBottomButton("Save container movement",{save {c.repository.recordReturnable(customer.takeIf {it.isNotBlank()},type,action,checkNotNull(quantity.toLongOrNull()));quantity=""}},!busy && !c.tripClosed && (customer.isNotBlank() || action=="count") && quantity.toLongOrNull()?.let {it>=0}==true,"save-containers")
            containers.forEach {row->Text("${row.optString("label",row.getString("typeCode"))} on van · ${if(row.isNull("quantity")) "Count first" else row.getString("quantity")}")}
        }
        SectionCard("Batch stock · earliest expiry first") {
            if(batches.isEmpty()) Text("No batch-tracked stock in this snapshot.")
            batches.sortedBy {it.expiresAt?:Long.MAX_VALUE}.forEach { b->
                val p=c.products.firstOrNull {it.productId==b.productId}
                Text("${p?.name?:"Product"} · ${b.batch} · ${p?.displayQuantity(b.quantityBase)?:b.quantityBase} ${p?.uomCode?:"base units"}")
                Text("${b.expiresAt?.let {java.time.Instant.ofEpochMilli(it).atZone(java.time.ZoneId.of("Asia/Manila")).toLocalDate()}?:"No expiry"} · ${b.qualityStatus} · ${b.status}",style=MaterialTheme.typography.bodySmall)
            }
        }
        SectionCard("Request a reload") {
            Choice("Product",product,c.products.map {it.productId to it.name}) {product=it}
            LabeledField("Pieces to request",reloadQuantity,{reloadQuantity=it},"reload-quantity",numeric=true)
            LabeledField("Reason",note,{note=it},"reload-note")
            PrimaryBottomButton("Save reload request",{save {val p=c.products.single {it.productId==product};c.repository.requestReload(product,checkNotNull(VanRules.parseQuantity(reloadQuantity,p.quantityScale)),note)}},!busy && !c.tripClosed && note.isNotBlank() && reloadQuantity.toLongOrNull()?.let {it>0}==true,"save-reload")
            Text("A request does not add stock. Office approval and a physical receipt are required.")
            snapshot?.optJSONArray("reloads")?.let(VanBootstrapCodec::objects)?.forEach {reload->
                val events=VanBootstrapCodec.objects(reload.getJSONArray("events"))
                val dispatched=events.firstOrNull {it.getString("kind")=="dispatched"}
                Text(if(events.any {it.getString("kind")=="received"}) "Reload received" else if(dispatched!=null) "Reload dispatched · still in transit" else "Reload awaits office approval / dispatch")
                if(dispatched!=null && events.none {it.getString("kind")=="received"}) SecondaryButton("Confirm exact dispatched quantities received",{save {c.repository.receiveReload(reload.getString("id"))}},enabled=!busy && !c.tripClosed)
            }
        }
        SectionCard("Unload and complete locally") {
            Text("Count cash and final stock first. Save the unload manifest, then open Close trip. The warehouse independently checks the received stock.")
            Text("Keep unlinked or unapproved pickup bags separate. They travel on the custody manifest, not in owned or sellable stock; the office checks each bag before financial credit.")
            PrimaryBottomButton("Save unload manifest",{save {c.repository.recordUnload()}},!busy && !c.tripClosed && c.stockCounted,"save-unload")
            SecondaryButton("Close trip locally",{c.open(Page.CLOSE_TRIP)},enabled=!busy && c.stockCounted && c.cashCounted)
        }
    }
}
private fun routeMoney(value: String?): String = value?.toLongOrNull()?.let {java.text.NumberFormat.getCurrencyInstance(java.util.Locale.forLanguageTag("en-PH")).format(java.math.BigDecimal.valueOf(it,2))}?:"Not available"
@Composable private fun Choice(label: String,value: String,items: List<Pair<String,String>>,onChange:(String)->Unit) {
    var expanded by remember {mutableStateOf(false)}
    Text(label,style=MaterialTheme.typography.labelMedium)
    androidx.compose.foundation.layout.Box {
        SecondaryButton(items.firstOrNull {it.first==value}?.second?:"Choose",{expanded=true})
        DropdownMenu(expanded,{expanded=false}) {items.forEach { item->DropdownMenuItem({Text(item.second)},{onChange(item.first);expanded=false})}}
    }
}
