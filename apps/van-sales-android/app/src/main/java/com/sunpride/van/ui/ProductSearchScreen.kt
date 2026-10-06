package com.sunpride.van.ui

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
import com.sunpride.van.scanning.SenraiseScanner

/**
 * VAN-008 POS product search. One-handed: the search field and Clear sit in the thumb zone at the
 * bottom (above the navigation bar and keyboard); the best match is the first row of the list.
 * Works fully offline from the cached product, truck-stock and price-list snapshot.
 */
@Composable fun ProductSearchScreen(c: VanController) {
    var query by rememberSaveable { mutableStateOf("") }
    var scanMessage by remember { mutableStateOf<String?>(null) }
    // Price effectivity is evaluated when the snapshot changes and at most once a minute while open.
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { kotlinx.coroutines.delay(60_000); now = System.currentTimeMillis() } }
    val index = remember(c.products,c.stock,c.prices,now) { ProductSearch(c.products,c.stock,c.prices,now) }
    val hits = remember(index,query) { index.search(query) }
    val listState = rememberLazyListState()
    LaunchedEffect(query) { listState.scrollToItem(0) }
    val focus = LocalFocusManager.current

    // The H10P's hardware scanner broadcasts while this screen is visible; a scan replaces the query.
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
        scanner.scans.collect { scan ->
            query = scan.code
            scanMessage = if (latestIndex.byBarcode(scan.code) == null) "No product has barcode ${scan.code}." else null
            focus.clearFocus()
        }
    }

    ScreenFrame("Find product",c::back,scroll = false,message = c.message,bottomContent = {
        Text(when {
            c.products.isEmpty() -> "No products on this phone yet. Sync first."
            query.isBlank() -> "${c.products.size} products · scan or type a name, code or barcode"
            hits.isEmpty() -> "No matching products"
            else -> "${hits.size} ${if (hits.size == 1) "match" else "matches"}"
        },style = MaterialTheme.typography.bodyMedium,color = MaterialTheme.colorScheme.onSurfaceVariant,modifier = Modifier.testTag("product-count"))
        // Bottom-aligned: the floating label adds space above the field, not below it.
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp),verticalAlignment = Alignment.Bottom) {
            OutlinedTextField(query,{ if (it.length <= 120) { query = it; scanMessage = null } },
                Modifier.weight(1f).heightIn(min = 56.dp).testTag("product-search"),
                label = { Text("Name, code or barcode") },singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { focus.clearFocus() }),
                shape = SunprideTokens.shapes.small,textStyle = MaterialTheme.typography.bodyLarge,
                colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = MaterialTheme.colorScheme.onSurface,focusedLabelColor = MaterialTheme.colorScheme.onSurface))
            OutlinedButton({ query = ""; scanMessage = null },Modifier.heightIn(min = 56.dp).testTag("product-clear"),enabled = query.isNotEmpty(),
                shape = SunprideTokens.shapes.small,colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface)) { Text("Clear",style = MaterialTheme.typography.titleMedium) }
        }
    }) {
        scanMessage?.let { Text(it,style = MaterialTheme.typography.bodyLarge,modifier = Modifier.testTag("scan-message")) }
        if (c.sync.queued+c.sync.sending > 0) Text("Stock includes changes waiting for sync",style = MaterialTheme.typography.bodyMedium)
        LazyColumn(Modifier.weight(1f).fillMaxWidth().testTag("product-results"),state = listState,verticalArrangement = Arrangement.spacedBy(8.dp)) {
            itemsIndexed(hits,key = { _,hit -> hit.product.productId }) { index,hit -> ProductHitRow(hit,index) }
        }
    }
}

@Composable private fun ProductHitRow(hit: PosProductHit, index: Int) {
    Surface(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}.testTag("product-$index"),color = MaterialTheme.colorScheme.surface,
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
