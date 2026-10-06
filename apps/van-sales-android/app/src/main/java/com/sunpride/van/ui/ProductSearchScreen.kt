package com.sunpride.van.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.sunpride.van.pos.*
import com.sunpride.van.scanning.CameraScanScreen
import com.sunpride.van.scanning.SenraiseScanner

/** The last scan on this screen and what it resolved to (VAN-009). Empty [hits] = not found. */
private data class ScanOutcome(val code: String, val hits: List<ScanHit>)

/** A typed value submitted with Enter is treated as a scan only when it looks like a barcode. */
private val barcodeLike = Regex("^[0-9]{8,14}$")

/**
 * VAN-008 POS product search + VAN-009 scanning. One-handed: the search field and Camera/Clear sit in
 * the thumb zone at the bottom (above the navigation bar and keyboard); the best match is the first row.
 * Works fully offline from the cached product, truck-stock and price-list snapshot.
 *
 * A scan (hardware broadcast, keyboard-wedge Enter, or the camera) resolves the code to product(s)
 * and the unit the barcode stands for, and shows a clear result or "not found" card with next steps.
 */
@Composable fun ProductSearchScreen(c: VanController) {
    var query by rememberSaveable { mutableStateOf("") }
    var scan by remember { mutableStateOf<ScanOutcome?>(null) }
    var camera by rememberSaveable { mutableStateOf(false) }
    // VAN-011: opened from a sale, a tapped (or scanned) product opens the quantity dialog for the sale.
    var adding by remember { mutableStateOf<Pair<com.sunpride.van.data.Product,Long?>?>(null) }
    // Price effectivity is evaluated when the snapshot changes and at most once a minute while open.
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { kotlinx.coroutines.delay(60_000); now = System.currentTimeMillis() } }
    val index = remember(c.products,c.stock,c.prices,now) { ProductSearch(c.products,c.stock,c.prices,now) }
    val hits = remember(index,query) { index.search(query) }
    // Re-resolve against fresh stock/products while the result is shown.
    val outcome = remember(index,scan) { scan?.let { it.copy(hits = index.resolveScan(it.code)) } }
    val rows = when {
        outcome == null -> hits
        else -> outcome.hits.map { it.hit }
    }
    val listState = rememberLazyListState()
    LaunchedEffect(query,scan) { listState.scrollToItem(0) }
    val focus = LocalFocusManager.current
    val field = remember { FocusRequester() }

    // Hardware scanner broadcasts are received while this screen is visible; a scan replaces the query.
    val context = LocalContext.current
    val scanner = remember { SenraiseScanner(context) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(scanner,lifecycle) {
        val observer = LifecycleEventObserver { _,event -> if (event == Lifecycle.Event.ON_START) scanner.start() else if (event == Lifecycle.Event.ON_STOP) scanner.stop() }
        lifecycle.addObserver(observer)
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) scanner.start()
        onDispose { lifecycle.removeObserver(observer); scanner.close() }
    }
    val latestIndex by rememberUpdatedState(index)
    LaunchedEffect(scanner) {
        scanner.scans.collect { event ->
            query = event.code.take(120)
            scan = ScanOutcome(event.code,latestIndex.resolveScan(event.code))
            camera = false
            focus.clearFocus()
        }
    }

    if (camera) {
        CameraScanScreen(onCode = { scanner.inputs.cameraCode(it) },onClose = { camera = false },closeLabel = "Back to Find product")
        return
    }

    ScreenFrame(if (c.pickingForSale) "Add product" else "Find product",c::back,scroll = false,message = c.message,bottomContent = {
        Text(when {
            c.products.isEmpty() -> "No products on this phone yet. Sync first."
            outcome != null && outcome.hits.isEmpty() -> "No product with this barcode"
            outcome != null && outcome.hits.size > 1 -> "${outcome.hits.size} products share this barcode"
            query.isBlank() -> "${c.products.size} products · scan or type a name, code or barcode"
            rows.isEmpty() -> "No matching products"
            else -> "${rows.size} ${if (rows.size == 1) "match" else "matches"}"
        },style = MaterialTheme.typography.bodyMedium,color = MaterialTheme.colorScheme.onSurfaceVariant,modifier = Modifier.testTag("product-count"))
        // Bottom-aligned: the floating label adds space above the field, not below it.
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp),verticalAlignment = Alignment.Bottom) {
            OutlinedTextField(query,{ if (it.length <= 120) { query = it; scan = null } },
                Modifier.weight(1f).heightIn(min = 56.dp).focusRequester(field).testTag("product-search"),
                label = { Text("Name, code or barcode") },singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                // A keyboard-wedge scanner types the code and presses Enter: treat that as a scan.
                keyboardActions = KeyboardActions(onSearch = {
                    val code = query.trim()
                    val resolved = index.resolveScan(code)
                    if (barcodeLike.matches(code) || resolved.any { it.candidate.match != ScanMatch.PRODUCT_CODE }) scan = ScanOutcome(code,resolved)
                    focus.clearFocus()
                }),
                shape = SunprideTokens.shapes.small,textStyle = MaterialTheme.typography.bodyLarge,
                colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = MaterialTheme.colorScheme.onSurface,focusedLabelColor = MaterialTheme.colorScheme.onSurface))
            if (query.isEmpty()) BottomRowButton("Camera","product-camera") { camera = true }
            else BottomRowButton("Clear","product-clear") { query = ""; scan = null }
        }
    }) {
        outcome?.let { ScanResultCard(it,onSearchByName = { query = ""; scan = null; field.requestFocus() },onCamera = { camera = true },
            onAdd = if (c.pickingForSale) { hit -> adding = hit.candidate.product to hit.candidate.unit.baseQuantity?.takeIf { hit.candidate.unit.quantityKnown } } else null) }
        if (c.sync.queued+c.sync.sending > 0) Text("Stock includes changes waiting for sync",style = MaterialTheme.typography.bodyMedium)
        LazyColumn(Modifier.weight(1f).fillMaxWidth().testTag("product-results"),state = listState,verticalArrangement = Arrangement.spacedBy(8.dp)) {
            itemsIndexed(rows,key = { _,hit -> hit.product.productId }) { index,hit ->
                ProductHitRow(hit,index,if (c.pickingForSale) { { adding = hit.product to null } } else null)
            }
        }
    }
    adding?.let { (product,base) -> QuantityDialog(product,base,onSave = { c.addToSale(product.productId,it); adding = null },onClose = { adding = null }) }
}

@Composable private fun BottomRowButton(label: String, tag: String, onClick: () -> Unit) {
    OutlinedButton(onClick,Modifier.heightIn(min = 56.dp).widthIn(min = 88.dp).testTag(tag),
        shape = SunprideTokens.shapes.small,colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
        contentPadding = PaddingValues(horizontal = 12.dp)) { Text(label,style = MaterialTheme.typography.titleMedium) }
}

/** The scan result: one product with its scanned unit, several (a data problem), or a clear "not found". */
@Composable private fun ScanResultCard(outcome: ScanOutcome, onSearchByName: () -> Unit, onCamera: () -> Unit, onAdd: ((ScanHit) -> Unit)? = null) {
    when (outcome.hits.size) {
        0 -> SectionCard("Barcode not found") {
            Column(Modifier.semantics(mergeDescendants = true) {}.testTag("scan-not-found"),verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("No product on this phone has barcode ${outcome.code}.",style = MaterialTheme.typography.bodyLarge,modifier = Modifier.testTag("scan-message"))
                Text("It may be new, not loaded for this trip, or a damaged label. Scan again, search by name, or sync if the office just added it.",
                    style = MaterialTheme.typography.bodyMedium,color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            // Stacked full-width: equal 56dp targets, no wrapped labels on the 360dp handheld.
            SecondaryButton("Search by name",onSearchByName,Modifier.fillMaxWidth().testTag("scan-search-name"))
            SecondaryButton("Use camera",onCamera,Modifier.fillMaxWidth().testTag("scan-camera"))
        }
        1 -> {
            val candidate = outcome.hits.single().candidate
            SectionCard("Scanned") {
                Column(Modifier.semantics(mergeDescendants = true) {}.testTag("scan-found"),verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(candidate.product.name,style = MaterialTheme.typography.titleMedium)
                    Text(candidate.unitLabel(),style = MaterialTheme.typography.bodyLarge,modifier = Modifier.testTag("scan-unit"))
                    if (!candidate.unit.quantityKnown)
                        Text("Count this item by hand; the office has not set how many ${candidate.product.uomCode} it holds.",
                            style = MaterialTheme.typography.bodyMedium,color = MaterialTheme.colorScheme.onSurfaceVariant,modifier = Modifier.testTag("scan-unit-warning"))
                    if (candidate.match == ScanMatch.PRODUCT_CODE)
                        Text("Matched by product code ${candidate.product.code}",style = MaterialTheme.typography.bodyMedium,color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                onAdd?.let { add -> SecondaryButton("Add to sale",{ add(outcome.hits.single()) },Modifier.fillMaxWidth().testTag("scan-add-to-sale")) }
            }
        }
        else -> SectionCard("Check the product") {
            Text("Barcode ${outcome.code} is on ${outcome.hits.size} products. Pick the right one below and tell the office.",
                style = MaterialTheme.typography.bodyLarge,modifier = Modifier.testTag("scan-ambiguous"))
        }
    }
}

@Composable private fun ProductHitRow(hit: PosProductHit, index: Int, onClick: (() -> Unit)? = null) {
    Surface(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}.then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier).testTag("product-$index"),color = MaterialTheme.colorScheme.surface,
        shape = SunprideTokens.shapes.small) {
        Row(Modifier.fillMaxWidth().heightIn(min = 72.dp).padding(horizontal = 16.dp,vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1f),verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(hit.product.name,style = MaterialTheme.typography.titleMedium,maxLines = 2,overflow = TextOverflow.Ellipsis)
                Text("${hit.product.code} · ${hit.product.uomCode}",style = MaterialTheme.typography.bodyMedium,color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(hit.price?.label() ?: "Priced by the office",style = MaterialTheme.typography.bodyLarge,
                    fontWeight = if (hit.price != null) FontWeight.SemiBold else FontWeight.Normal,
                    color = if (hit.price != null) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.testTag("product-price-$index"))
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(hit.availableLabel(),style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier.testTag("product-available-$index"))
                Text(if (hit.onTruck) "on truck" else "Not on truck",style = MaterialTheme.typography.bodyMedium,color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
