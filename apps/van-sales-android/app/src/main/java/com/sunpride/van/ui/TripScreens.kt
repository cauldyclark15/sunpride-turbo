package com.sunpride.van.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.sunpride.van.data.*
import com.sunpride.van.pos.OpeningFloat
import com.sunpride.van.scanning.*
import com.sunpride.van.vanday.*
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Composable fun HomeScreen(c: VanController) {
    val last = c.sync.lastSyncTime?.let { Instant.ofEpochMilli(it).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("MMM d, h:mm a")) } ?: "Not yet"
    // VAN-025: phone, office and SAP stay on separate lines; details on the Sync & posting screen.
    val status = com.sunpride.van.sync.SyncHealth.footer(c.sync,last)
    // IP-HH2: Today shows ONE next step (accept the load, start the trip, next store, load-in, settle) and the main button does it.
    LaunchedEffect(c.trip?.tripId,c.sync.phoneOnly,c.sync.queued) { c.refreshSavedSales(); c.refreshAcceptWaiting() }
    val routeStores = c.customers.filter { it.sequence != null && !it.localOnly }.sortedBy { it.sequence }
    val served = c.savedSales.filter { !it.isCollection && it.void == null }.map { it.receipt.customerName }.toSet()
    val storesLeft = routeStores.filter { it.name !in served }
    val step = VanDaySteps.next(DayFacts(c.trip != null,c.trip?.status,c.trip?.startPending == true,c.load?.status,c.load?.confirmPending == true,c.vanDay,c.tripClosed,c.cashCounted,c.stockCounted,
        c.policy?.operationsVersion == 1,c.sync.items.any { it.kind == "unload.record" },storesLeft.firstOrNull()?.name,storesLeft.size,c.onHold,c.acceptWaiting,c.policy?.handheld?.supervisorName,c.setupProblem))
    val go: () -> Unit = {
        when (step.target) {
            StepTarget.SYNC -> c.syncNow(); StepTarget.ACCEPT_LOAD -> c.open(Page.ACCEPT_LOAD); StepTarget.LOAD -> c.open(Page.LOAD); StepTarget.START -> c.open(Page.START)
            StepTarget.CUSTOMERS -> c.open(Page.CUSTOMERS); StepTarget.ROUTE_OPS -> c.open(Page.ROUTE_OPS); StepTarget.CASH -> c.open(Page.CASH)
            StepTarget.STOCK_COUNT -> c.open(Page.STOCK_COUNT); StepTarget.CLOSE_TRIP -> c.open(Page.CLOSE_TRIP); StepTarget.NONE -> {}
        }
    }
    ScreenFrame("Today",message = c.message,trailing = { SyncPill(c) }) {
        val trip = c.trip
        if (!c.onHold || trip != null) NextStepCard(step,!c.busy,go)
        PhoneCrewCard(c)
        if (trip == null && c.onHold) {
            Text(com.sunpride.van.vanday.VanDaySteps.holdText(c.setupProblem),
                style = MaterialTheme.typography.titleLarge,modifier = Modifier.testTag("on-hold"))
            PillButton(if (c.busy) "Syncing…" else "Sync now",c::syncNow,Modifier.testTag("on-hold-sync"),enabled = !c.busy)
        } else if (trip == null) {
            NoTripPanel(c,"No trip","no-trip")
        } else {
            SectionCard("Your trip") {
                Text(if (c.tripClosed) "Closed on this phone" else VanRules.status(trip,c.load),style = MaterialTheme.typography.titleLarge,modifier = Modifier.testTag("trip-status"))
                Text(trip.tripNumber,style = MaterialTheme.typography.bodyMedium,color = Look.muted,modifier = Modifier.testTag("trip-number"))
                Text(trip.vehicle?.let { "Truck ${it.vehicleCode} · ${it.plateNumber}" } ?: "Truck not assigned")
                Text(trip.route?.let { "Route · ${it.name}" } ?: "Route not assigned")
                Text(listOfNotNull(c.seller?.name?.let { "Seller: $it" },trip.driverName?.let { "Driver: $it" },trip.helperName?.let { "Helper: $it" }).joinToString("\n"),style = MaterialTheme.typography.bodyMedium)
            }
            // SP-0137: visible while the trip is on the road.
            LocationSharingRow(c)
            val selling = VanRules.canSell(trip) && !c.cashCounted && !c.stockCounted && !c.tripClosed
            // The Sell tab is the home of selling; this row is the quick way in from Today.
            if (c.sale != null && selling) ListRow("Continue sale",c.sale!!.customer.name,"new-sale",enabled = !c.busy,onClick = c::continueSale,glyph = GlyphKind.CART)
            else ListRow("New sale",when { c.tripClosed -> "Trip closed — no more sales on this trip"; c.cashCounted -> "Cash counted — no more sales on this trip"; c.stockCounted -> "Stock counted — no more sales on this trip"; selling -> "Choose the customer, then add products"; else -> "Start the trip to sell" },
                "new-sale",enabled = selling && !c.busy,onClick = { c.open(Page.CUSTOMERS) },glyph = GlyphKind.CART)
            if (c.policy?.operationsVersion==1) ListRow("Route controls","Temperature, batches, containers, reload and unload","open-route-ops",onClick = { c.open(Page.ROUTE_OPS) },glyph = GlyphKind.FLAG)
            // VAN-022: end of trip. Open once the trip is on the road; after saving it shows the count.
            val countable = c.cashCounted || VanRules.canCountCash(trip) && !c.tripClosed
            // The end-of-trip jobs only appear once the trip is on the road (they are noise while the truck is still being loaded).
            if (countable || c.stockCounted || c.tripClosed) Text("End of trip",style = MaterialTheme.typography.titleMedium,modifier = Modifier.padding(top = 4.dp))
            if (countable || c.stockCounted || c.tripClosed) ListRow("Count cash",if (c.cashCounted) "Counted — see the result" else if (countable) "Count the cash you collected" else "Start the trip first",
                "open-cash",enabled = countable && !c.busy,onClick = { c.open(Page.CASH) },glyph = GlyphKind.WALLET)
            val stockCountable = c.stockCounted || VanRules.canCountStock(trip) && !c.tripClosed
            if (countable || c.stockCounted || c.tripClosed) ListRow("Count stock",if (c.stockCounted) "Counted — see the result" else if (stockCountable) "Compare truck stock with the physical count" else "Start the trip first",
                "open-stock-count",enabled = stockCountable && !c.busy,onClick = { c.open(Page.STOCK_COUNT) },glyph = GlyphKind.BOX)
            // VAN-024: last step of the day. Opens once the trip is on the road; after closing it shows the close.
            val closable = c.tripClosed || VanRules.canCountCash(trip)
            if (countable || c.stockCounted || c.tripClosed) ListRow("Close trip",when { c.tripClosed -> "Closed — see the close"; closable -> "Check everything, then close"; else -> "Start the trip first" },
                "open-close-trip",enabled = closable && !c.busy,onClick = { c.open(Page.CLOSE_TRIP) },glyph = GlyphKind.TRUCK)
        }
        // VAN-025: phone, office and SAP stay on separate lines (details on Sync & posting).
        Text(status,style = MaterialTheme.typography.bodyMedium,color = Look.muted,modifier = Modifier.padding(top = 4.dp).testTag("sync-line"))
    }
}
private data class LoadDraft(val quantity: String, val reason: String?)
@Composable fun CheckLoadScreen(c: VanController) {
    val load = c.load
    val lines = load?.lines ?: emptyList()
    val drafts = remember(load?.loadId) { mutableStateMapOf<Int,LoadDraft>() }
    lines.forEach { line -> if (line.lineNumber !in drafts) drafts[line.lineNumber] = LoadDraft(VanRules.quantity(line.pendingActualBase ?: line.actualBase ?: line.expectedBase,line.quantityScale),line.pendingReason ?: line.discrepancyReason) }
    val editable = VanRules.canConfirm(c.trip,load) && !c.busy
    val valid = lines.isNotEmpty() && lines.all { line ->
        val draft = drafts[line.lineNumber]!!; val actual = VanRules.parseQuantity(draft.quantity,line.quantityScale)
        actual != null && (!VanRules.reasonRequired(line.expectedBase,actual) || draft.reason in (c.policy?.loadDiscrepancyReasons ?: emptyList()))
    }
    val scanner = checkNotNull(com.sunpride.van.scanning.LocalScannerInput.current)
    var scanMessage by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(scanner,editable,lines,c.products) {
        scanner.scans.collect { scan ->
            if (editable) {
                // VAN-009: resolve the barcode to product AND unit; a case barcode adds a case, never one piece.
                val matches = com.sunpride.van.pos.BarcodeLookup(c.products).resolve(scan.code)
                    .filter { candidate -> lines.any { it.productId == candidate.product.productId } }
                val candidate = matches.singleOrNull()
                val line = candidate?.let { found -> lines.firstOrNull { it.productId == found.product.productId } }
                val step = candidate?.unit?.baseQuantity?.takeIf { candidate.unit.quantityKnown && line?.quantityScale == candidate.product.quantityScale }
                scanMessage = when {
                    matches.size > 1 -> "Barcode ${scan.code} is on more than one load item. Count it by hand and tell the office."
                    line == null -> "No load item has barcode ${scan.code}. Count it by hand or search the product."
                    step == null -> "${candidate!!.unitLabel()}: ${line.productName}. Count it by hand."
                    else -> {
                        val draft = drafts[line.lineNumber]!!
                        val old = VanRules.parseQuantity(draft.quantity,line.quantityScale) ?: line.expectedBase
                        if (old <= VanRules.MAX_BASE-step) {
                            drafts[line.lineNumber] = draft.copy(quantity = VanRules.quantity(old+step,line.quantityScale))
                            "Added ${VanRules.quantity(step,line.quantityScale)} ${line.uomCode} (1 ${candidate!!.unit.uomCode}): ${line.productName}. Check the reason below."
                        } else "Count too large for ${line.productName}."
                    }
                }
            }
        }
    }
    val sent = when {
        load?.confirmPending == true -> "Sent — waiting for sync"
        load?.status == "discrepancy" -> UserMessages.loadDifferenceSent(c.policy?.handheld?.supervisorName)
        load?.status == "posted" -> "Loaded"
        else -> null
    }
    ScreenFrame("Check the load",c::back,action = if (editable) "Confirm load" else "Sync now",actionTag = "confirm-load",
        enabled = if (editable) valid else !c.busy,
        onAction = { if (editable) c.confirmLoad(lines.map { line -> val draft = drafts[line.lineNumber]!!; LoadActual(line.lineNumber,VanRules.parseQuantity(draft.quantity,line.quantityScale)!!,draft.reason.takeIf { VanRules.reasonRequired(line.expectedBase,VanRules.parseQuantity(draft.quantity,line.quantityScale)) }) }) else c.syncNow() },
        message = sent ?: c.message) {
        if (load?.status == "planned" && load.confirmRequestId != null && !load.confirmPending)
            Text(UserMessages.recountAsked(load.rejectionNote),style = MaterialTheme.typography.bodyLarge,fontWeight = FontWeight.SemiBold,modifier = Modifier.testTag("recount-asked"))
        Text("Count what is on the truck. Give a reason for any difference.",style = MaterialTheme.typography.bodyMedium)
        if (lines.isEmpty() && c.onHold) Text(com.sunpride.van.vanday.VanDaySteps.holdText(c.setupProblem),modifier = Modifier.testTag("on-hold"))
        else if (lines.isEmpty()) NoTripPanel(c,"No load sheet","no-load-sheet")
        lines.forEach { line ->
            val draft = drafts[line.lineNumber]!!
            val actual = VanRules.parseQuantity(draft.quantity,line.quantityScale)
            SectionCard(line.productCode) {
                Text(line.productName,style = MaterialTheme.typography.titleMedium)
                line.lotNumber?.let { Text("Lot $it",style = MaterialTheme.typography.bodyMedium) }
                Text("Expected: ${VanRules.quantity(line.expectedBase,line.quantityScale)} ${line.uomCode}")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp),verticalAlignment = Alignment.CenterVertically) {
                    OutlinedButton({ if (actual != null) drafts[line.lineNumber] = draft.copy(quantity = VanRules.quantity(maxOf(0,actual-line.quantityScale),line.quantityScale)) },Modifier.size(56.dp).testTag("minus-${line.lineNumber}"),enabled = editable && actual != null && actual > 0,contentPadding = PaddingValues(0.dp)) { Text("−",style = MaterialTheme.typography.titleLarge) }
                    Box(Modifier.weight(1f)) { LabeledField("Actual ${line.uomCode}",draft.quantity,{ drafts[line.lineNumber] = draft.copy(quantity = it) },"actual-${line.lineNumber}",numeric = true,enabled = editable,maxLength = 24) }
                    OutlinedButton({ if (actual != null && actual <= VanRules.MAX_BASE-line.quantityScale) drafts[line.lineNumber] = draft.copy(quantity = VanRules.quantity(actual+line.quantityScale,line.quantityScale)) },Modifier.size(56.dp).testTag("plus-${line.lineNumber}"),enabled = editable && actual != null && actual <= VanRules.MAX_BASE-line.quantityScale,contentPadding = PaddingValues(0.dp)) { Text("+",style = MaterialTheme.typography.titleLarge) }
                }
                if (actual == null) Text("Enter a valid quantity.")
                if (VanRules.reasonRequired(line.expectedBase,actual)) {
                    Text("Reason required",modifier = Modifier.testTag("reason-required-${line.lineNumber}"))
                    if (editable) ReasonPicker(c.policy?.loadDiscrepancyReasons ?: emptyList(),draft.reason,{ drafts[line.lineNumber] = draft.copy(reason = it) },"load-reason-${line.lineNumber}")
                    else Text(draft.reason?.let(VanRules::reasonLabel) ?: "Ask your supervisor")
                }
            }
        }
        if (editable) SectionCard("Barcode scan") {
            Text("A matching scan adds one to the actual count.",style = MaterialTheme.typography.bodyMedium)
            WedgeScanField(scanner.inputs)
            scanMessage?.let { Text(it) }
        }
    }
}
@Composable fun StartTripScreen(c: VanController) {
    val trip = c.trip
    var truck by remember(trip?.tripId) { mutableStateOf(false) }
    var route by remember(trip?.tripId) { mutableStateOf(false) }
    var driver by remember(trip?.tripId) { mutableStateOf(trip?.driverName ?: "") }
    var helper by remember(trip?.tripId) { mutableStateOf(trip?.helperName ?: "") }
    var odometer by remember(trip?.tripId) { mutableStateOf("") }
    var note by remember(trip?.tripId) { mutableStateOf("") }
    val km = odometer.takeIf { it.isNotBlank() }?.toDoubleOrNull()
    val required=c.policy?.operationsVersion==1
    val validKm = (!required && odometer.isBlank()) || km != null && km.isFinite() && km in 0.0..10_000_000.0
    // IP-P0 (SPEC 6.7): the cash the seller starts with, typed on a big pad. Never prefilled: type 0 if there is none.
    var floatPesos by remember(trip?.tripId) { mutableStateOf("") }
    val floatCentavos = OpeningFloat.centavos(floatPesos)
    ScreenFrame("Start trip",c::back,action = "Start trip",actionTag = "start-trip",
        enabled = !c.busy && VanRules.canStart(trip,truck,route) && validKm && OpeningFloat.valid(floatCentavos),
        onAction = { c.startTrip(truck,route,driver,helper,km,note,checkNotNull(floatCentavos)) },message = c.message) {
        if (trip?.status != "loaded") Text("Confirm the load first",Modifier.testTag("start-blocked"))
        if (trip?.startPending == true) Text("Starting… waiting for sync")
        Confirmation(trip?.vehicle?.let { "This is truck ${it.vehicleCode} · ${it.plateNumber}" } ?: "Truck not assigned",truck,{ truck = it },"confirm-truck")
        Confirmation(trip?.route?.let { "This is the ${it.name} route" } ?: "Route not assigned",route,{ route = it },"confirm-route")
        SectionCard("Opening float") {
            Text("How much cash are you starting with? Type 0 if none.",style = MaterialTheme.typography.bodyLarge)
            MoneyPad(floatPesos,"Usual: ${OpeningFloat.display(OpeningFloat.HINT_PESOS.toString())}",{ floatPesos = it },"float",enabled = !c.busy)
        }
        LabeledField("Driver",driver,{ driver = it },"driver",maxLength = 80)
        LabeledField("Helper (optional)",helper,{ helper = it },"helper",maxLength = 80)
        LabeledField(if(required) "Opening odometer km (required)" else "Odometer km (optional)",odometer,{ odometer = it },"odometer",numeric = true,maxLength = 20)
        if(required) SecondaryButton("Record load-out temperature",{c.open(Page.ROUTE_OPS)},Modifier.testTag("start-cold-chain"))
        if (!validKm) Text("Enter an odometer reading between 0 and 10,000,000 km.")
        LabeledField("Note (optional)",note,{ note = it },"start-note")
        // SP-0137: say it before the trip starts, not after.
        if (c.locationSharing.enabled) Text("Starting the trip shares the truck's location with your supervisors until you close the trip.",
            style = MaterialTheme.typography.bodyMedium,modifier = Modifier.testTag("start-location-note"))
    }
}
