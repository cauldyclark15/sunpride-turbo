package com.sunpride.van.ui

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import com.sunpride.van.evidence.*
import kotlinx.coroutines.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.sunpride.van.data.*

@Composable fun TruckStockScreen(c: VanController) {
    var damageProduct by remember { mutableStateOf<Product?>(null) }
    ScreenFrame("Truck stock",c::back,action = "Sync now",actionTag = "stock-sync",onAction = c::syncNow,enabled = !c.busy,message = c.message) {
        Text("Available stock includes saved changes on this phone.",style = MaterialTheme.typography.bodyMedium)
        if (c.sync.queued+c.sync.sending > 0) Text("Waiting for sync",Modifier.testTag("stock-pending"))
        if (c.sync.review > 0) Text("Some changes need review. Ask your supervisor.")
        if (c.products.isEmpty()) Text("No truck stock available. Sync and check with your supervisor.")
        c.products.forEachIndexed { index,product ->
            val stock = c.stock.firstOrNull { it.productId == product.productId } ?: TruckStock(product.productId,0,0)
            SectionCard(product.code) {
                Text(product.name,style = MaterialTheme.typography.titleMedium)
                Text("Available: ${product.displayQuantity(stock.availableBase)} ${product.uomCode}",style = MaterialTheme.typography.titleLarge,modifier = Modifier.testTag("available-$index"))
                Text("Damaged: ${product.displayQuantity(stock.damagedBase)} ${product.uomCode}")
                SecondaryButton("Record damage",{ damageProduct = product },Modifier.testTag("damage-$index"),!c.busy)
            }
        }
        SectionCard("This trip's damage records") {
            if (c.damageRecords.isEmpty()) Text("No damage records synced yet.")
            c.damageRecords.forEachIndexed { index,record ->
                val product = c.products.firstOrNull { it.productId == record.productId }
                Text(product?.name ?: "Product",style = MaterialTheme.typography.titleMedium)
                // The unit frozen on the record, not the product's current unit.
                Text("${record.quantityLabel} · ${VanRules.reasonLabel(record.reason)}",Modifier.testTag("damage-quantity-$index"))
                Text(record.statusLabel,Modifier.testTag("damage-status-$index"))
                record.decisionNote?.takeIf { it.isNotBlank() }?.let { Text(it,Modifier.testTag("damage-decision-$index")) }
            }
        }
    }
    damageProduct?.let { product -> DamageDialog(c,product) { damageProduct = null } }
}
@Composable private fun DamageDialog(c: VanController, product: Product, onClose: () -> Unit) {
    var quantity by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf<String?>(null) }
    var note by remember { mutableStateOf("") }
    var photo by remember { mutableStateOf<DamagePhoto?>(null) }
    var camera by remember { mutableStateOf(false) }
    var processing by remember { mutableStateOf(false) }
    var photoMessage by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val base = VanRules.parseQuantity(quantity,product.quantityScale)
    val rules = DamageRules.requirements(c.policy?.damagePolicy,base ?: 0,product.quantityScale,reason)
    val thumbnail by produceState<android.graphics.Bitmap?>(null,photo) {
        value = photo?.let { withContext(Dispatchers.IO) { BitmapFactory.decodeFile(it.file.path) } }
    }
    DisposableEffect(photo) { val old = photo; onDispose { old?.let { c.discardDamagePhoto(it.sha256) } } }
    fun captured(capture: DamageCapture) {
        camera = false; processing = true; photoMessage = null
        scope.launch {
            try { photo = c.repository.saveDamagePhoto(capture) }
            catch (e: CancellationException) { throw e }
            catch (_: Exception) { photoMessage = "Could not save photo. Retake and try again." }
            finally { processing = false }
        }
    }
    Dialog(onDismissRequest = { if (!c.busy && !processing) { if (camera) camera = false else onClose() } },
        properties = DialogProperties(usePlatformDefaultWidth = false,decorFitsSystemWindows = false)) {
        if (camera) Surface(Modifier.fillMaxSize()) { DamageCameraScreen(::captured,{ camera = false }) }
        else Surface(Modifier.fillMaxWidth().safeDrawingPadding().padding(16.dp).imePadding().heightIn(max = 560.dp),shape = SunprideTokens.shapes.large) {
            Column(Modifier.padding(16.dp),verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Record damage",style = MaterialTheme.typography.titleLarge)
                Column(Modifier.weight(1f,false).verticalScroll(rememberScrollState()),verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(product.name,style = MaterialTheme.typography.titleMedium)
                    c.message?.let { Text(it,Modifier.testTag("damage-message")) }
                    LabeledField("Quantity ${product.uomCode}",quantity,{ quantity = it },"damage-quantity",numeric = true,maxLength = 24)
                    ReasonPicker(c.policy?.damageReasons ?: emptyList(),reason,{ reason = it },"damage-reason")
                    LabeledField("Note (optional)",note,{ note = it },"damage-note")
                    if (rules.needsApproval) Text("${c.policy!!.damagePolicy!!.approvalFromUnits} units or more: a supervisor must approve this damage — photo required",Modifier.testTag("damage-photo-required"))
                    else if (rules.needsPhoto) Text("A photo is required for this reason",Modifier.testTag("damage-photo-required"))
                    if (!rules.needsApproval) Text("No supervisor approval needed for this damage.",Modifier.testTag("damage-approval"))
                    thumbnail?.let { Image(it.asImageBitmap(),"Damage photo",Modifier.fillMaxWidth().height(112.dp).testTag("damage-thumbnail"),contentScale = ContentScale.Fit) }
                    photoMessage?.let { Text(it) }
                    if (processing) Text("Preparing photo…")
                    SecondaryButton(if (photo == null) "Take photo" else "Retake",{
                        if (c.damagePhotoSource == null) camera = true else {
                            processing = true
                            scope.launch {
                                try { captured(c.damagePhotoSource.invoke()) }
                                catch (e: CancellationException) { throw e }
                                catch (_: Exception) { processing = false; photoMessage = "Could not take photo. Try again." }
                            }
                        }
                    },Modifier.testTag("damage-photo"),!c.busy && !processing)
                    if (c.trip?.status != "active" && c.trip?.startPending != true) Text("Start the trip before recording damage.")
                }
                PrimaryBottomButton("Save damage",{ c.damage(product,base!!,reason!!,note,photo?.sha256,onClose) },
                    !c.busy && !processing && (!rules.needsPhoto || photo != null) && base != null && base > 0 && reason in (c.policy?.damageReasons ?: emptyList()) && (c.trip?.status == "active" || c.trip?.startPending == true),"save-damage")
                SecondaryButton("Cancel",onClose,Modifier.testTag("cancel-damage"),!c.busy && !processing)
            }
        }
    }
}
@Composable fun CustomersScreen(c: VanController) {
    var query by remember { mutableStateOf("") }
    val filtered = c.customers.filter { query.isBlank() || it.name.contains(query,true) || it.code.contains(query,true) }
    ScreenFrame("Customers",c::back,action = "Add walk-in customer",actionTag = "add-walk-in",
        enabled = !c.busy && c.policy?.walkInAllowed == true,onAction = { c.open(Page.WALK_IN) },message = c.message) {
        LabeledField("Search customers",query,{ query = it },"customer-search",maxLength = 150)
        if (c.policy?.walkInAllowed != true) Text("Ask your supervisor to allow walk-in customers.")
        listOf("route" to "Today's route","unplanned" to "Other stores in your area","walk_in" to "Walk-in").forEach { (source,label) ->
            val group = filtered.filter { it.source == source }.let { if (source == "route") it.sortedBy { it.sequence ?: Int.MAX_VALUE } else it }
            Text(label,style = MaterialTheme.typography.titleMedium)
            if (group.isEmpty()) Text(if (query.isBlank()) "No customers here yet" else "No matching customers",style = MaterialTheme.typography.bodyMedium)
            group.forEachIndexed { index,customer ->
                ListRow((if (source == "route") "${customer.sequence ?: index+1}. " else "")+customer.name,
                    listOfNotNull(customer.code.takeIf { it.isNotBlank() },VanRules.sourceLabel(customer.source)).joinToString(" · "),"customer-$source-$index",onClick = { c.select(customer) })
            }
        }
    }
}
@Composable fun WalkInScreen(c: VanController) {
    var name by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf("") }
    ScreenFrame("Add walk-in",c::back,action = "Save customer",actionTag = "save-walk-in",enabled = !c.busy && c.policy?.walkInAllowed == true && name.isNotBlank() && reason.isNotBlank(),
        onAction = { c.walkIn(name,reason) },message = c.message) {
        Text("For a customer who is not on your list. Give a reason for adding them.")
        LabeledField("Customer name",name,{ name = it },"walk-in-name",maxLength = 150)
        LabeledField("Reason (required)",reason,{ reason = it },"walk-in-reason")
        Text("This customer is saved on this phone for this trip.",style = MaterialTheme.typography.bodyMedium)
    }
}
@Composable fun CustomerDetailScreen(c: VanController) {
    val customer = c.selectedCustomer
    val continuing = customer != null && c.sale?.customer?.outletId == customer.outletId
    ScreenFrame("Customer",c::back,action = if (continuing) "Continue sale" else "Start sale",actionTag = "start-sale",
        enabled = !c.busy && customer != null && VanRules.canSell(c.trip),onAction = { customer?.let(c::startSale) },message = c.message) {
        customer?.let {
            SectionCard(VanRules.sourceLabel(it.source)) {
                Text(it.name,style = MaterialTheme.typography.titleLarge)
                if (it.code.isNotBlank()) Text(it.code)
                it.address?.let { address -> Text(address) }
                it.reason?.let { reason -> Text("Reason: $reason") }
            }
        }
        // VAN-019: returns are taken from the customer, like a sale.
        if (customer != null) SecondaryButton(if (c.returnDraft?.customer?.outletId == customer.outletId) "Continue return" else "Record return",
            { c.startReturn(customer) },Modifier.testTag("start-return"),!c.busy && VanRules.canSell(c.trip))
        if (!VanRules.canSell(c.trip)) Text("Start the trip before selling.",style = MaterialTheme.typography.titleMedium)
        else if (c.sale != null && !continuing) Text("Starting a sale here replaces the unfinished sale for ${c.sale!!.customer.name}.",style = MaterialTheme.typography.bodyMedium)
    }
}
