package com.sunpride.van.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.sunpride.van.data.*
import com.sunpride.van.scanning.*
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Composable fun HomeScreen(c: VanController) {
    val next = VanRules.nextAction(c.trip,c.load)
    val last = c.sync.lastSyncTime?.let { Instant.ofEpochMilli(it).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("MMM d, h:mm a")) } ?: "Not yet"
    // VAN-025: phone, office and SAP stay on separate lines; details on the Sync & posting screen.
    val status = com.sunpride.van.sync.SyncHealth.footer(c.sync,last)
    ScreenFrame("Today",action = if (c.trip == null) "Sync now" else next.label,actionTag = "home-primary",
        enabled = !c.busy,onAction = { if (c.trip == null) c.syncNow() else c.open(next.page) },footer = status,message = c.message) {
        val trip = c.trip
        if (trip == null) {
            Text("No trip assigned for today. Ask your supervisor.",style = MaterialTheme.typography.titleLarge,modifier = Modifier.testTag("no-trip"))
        } else {
            SectionCard("Your trip") {
                Text(trip.tripNumber,style = MaterialTheme.typography.titleMedium,modifier = Modifier.testTag("trip-number"))
                Text(if (c.tripClosed) "Closed on this phone" else VanRules.status(trip,c.load),style = MaterialTheme.typography.titleLarge,modifier = Modifier.testTag("trip-status"))
                Text(trip.vehicle?.let { "Truck ${it.vehicleCode} · ${it.plateNumber}" } ?: "Truck not assigned")
                Text(trip.route?.let { "Route · ${it.name}" } ?: "Route not assigned")
                Text(listOfNotNull(c.seller?.name,trip.driverName?.let { "Driver: $it" },trip.helperName?.let { "Helper: $it" }).joinToString("\n"),style = MaterialTheme.typography.bodyMedium)
            }
            ListRow("Find product","Search or scan · stock and price","open-products",onClick = { c.open(Page.PRODUCTS) })
            ListRow("Truck stock","Available and damaged","open-stock",onClick = { c.open(Page.STOCK) })
            ListRow("Customers","Your route and nearby stores","open-customers",onClick = { c.open(Page.CUSTOMERS) })
            ListRow("Receipts","Print or reprint a receipt from this trip","open-receipts",onClick = { c.open(Page.RECEIPTS) })
            ListRow("Printer & scanner","Check the printer and paper","open-printer",onClick = { c.open(Page.PRINTER) })
            ListRow("Sync now","Send saved work and check for changes","sync-now",onClick = c::syncNow,enabled = !c.busy)
            val selling = VanRules.canSell(trip) && !c.cashCounted && !c.stockCounted && !c.tripClosed
            if (c.sale != null && selling) ListRow("Continue sale",c.sale!!.customer.name,"new-sale",enabled = !c.busy,onClick = c::continueSale)
            else ListRow("New sale",when { c.tripClosed -> "Trip closed — no more sales on this trip"; c.cashCounted -> "Cash counted — no more sales on this trip"; c.stockCounted -> "Stock counted — no more sales on this trip"; selling -> "Choose the customer, then add products"; else -> "Start the trip to sell" },
                "new-sale",enabled = selling && !c.busy,onClick = { c.open(Page.CUSTOMERS) })
            // VAN-022: end of trip. Open once the trip is on the road; after saving it shows the count.
            val countable = c.cashCounted || VanRules.canCountCash(trip) && !c.tripClosed
            ListRow("Count cash",if (c.cashCounted) "Counted — see the result" else if (countable) "End of trip: count the cash you collected" else "Start the trip first",
                "open-cash",enabled = countable && !c.busy,onClick = { c.open(Page.CASH) })
            val stockCountable = c.stockCounted || VanRules.canCountStock(trip) && !c.tripClosed
            ListRow("Count stock",if (c.stockCounted) "Stock counted — see the result" else if (stockCountable) "End of trip: compare truck stock with the physical count" else "Start the trip first",
                "open-stock-count",enabled = stockCountable && !c.busy,onClick = { c.open(Page.STOCK_COUNT) })
            // VAN-024: last step of the day. Opens once the trip is on the road; after closing it shows the close.
            val closable = c.tripClosed || VanRules.canCountCash(trip)
            ListRow("Close trip",when { c.tripClosed -> "Closed — see the close"; closable -> "End of trip: check everything, then close"; else -> "Start the trip first" },
                "open-close-trip",enabled = closable && !c.busy,onClick = { c.open(Page.CLOSE_TRIP) })
        }
        ListRow("Sync & posting","What is on this phone, with the office and in SAP","open-sync",onClick = { c.open(Page.SYNC) })
        val context = LocalContext.current
        c.features.reportIssueUrl?.let { url -> ListRow("Report an issue","Tell the Sunpride team what went wrong","report-issue",onClick = { openLink(context,url) }) }
        SecondaryButton("Sign out",c::signOut,Modifier.testTag("sign-out"),!c.busy)
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
    val context = LocalContext.current
    val scanner = remember { SenraiseScanner(context) }
    var scanMessage by remember { mutableStateOf<String?>(null) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(scanner,lifecycle,editable) {
        val observer = LifecycleEventObserver { _,event -> if (event == Lifecycle.Event.ON_START && editable) scanner.start() else if (event == Lifecycle.Event.ON_STOP) scanner.stop() }
        lifecycle.addObserver(observer)
        if (editable && lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) scanner.start()
        onDispose { lifecycle.removeObserver(observer); scanner.stop() }
    }
    DisposableEffect(scanner) { onDispose { scanner.close() } }
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
        load?.status == "discrepancy" -> "Waiting for supervisor approval"
        load?.status == "posted" -> "Loaded"
        else -> null
    }
    ScreenFrame("Check the load",c::back,action = if (editable) "Confirm load" else "Sync now",actionTag = "confirm-load",
        enabled = if (editable) valid else !c.busy,
        onAction = { if (editable) c.confirmLoad(lines.map { line -> val draft = drafts[line.lineNumber]!!; LoadActual(line.lineNumber,VanRules.parseQuantity(draft.quantity,line.quantityScale)!!,draft.reason.takeIf { VanRules.reasonRequired(line.expectedBase,VanRules.parseQuantity(draft.quantity,line.quantityScale)) }) }) else c.syncNow() },
        message = sent ?: c.message) {
        Text("Count what is on the truck. Give a reason for any difference.",style = MaterialTheme.typography.bodyMedium)
        if (lines.isEmpty()) Text("No load sheet available. Sync and ask your supervisor.")
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
    val validKm = odometer.isBlank() || km != null && km.isFinite() && km in 0.0..10_000_000.0
    ScreenFrame("Start trip",c::back,action = "Start trip",actionTag = "start-trip",
        enabled = !c.busy && VanRules.canStart(trip,truck,route) && validKm,
        onAction = { c.startTrip(truck,route,driver,helper,km,note) },message = c.message) {
        if (trip?.status != "loaded") Text("Confirm the load first",Modifier.testTag("start-blocked"))
        if (trip?.startPending == true) Text("Starting… waiting for sync")
        Confirmation(trip?.vehicle?.let { "This is truck ${it.vehicleCode} · ${it.plateNumber}" } ?: "Truck not assigned",truck,{ truck = it },"confirm-truck")
        Confirmation(trip?.route?.let { "This is the ${it.name} route" } ?: "Route not assigned",route,{ route = it },"confirm-route")
        LabeledField("Driver",driver,{ driver = it },"driver",maxLength = 80)
        LabeledField("Helper (optional)",helper,{ helper = it },"helper",maxLength = 80)
        LabeledField("Odometer km (optional)",odometer,{ odometer = it },"odometer",numeric = true,maxLength = 20)
        if (!validKm) Text("Enter an odometer reading between 0 and 10,000,000 km.")
        LabeledField("Note (optional)",note,{ note = it },"start-note")
    }
}
