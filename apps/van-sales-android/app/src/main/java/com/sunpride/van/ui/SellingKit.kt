package com.sunpride.van.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.sunpride.van.data.Product
import com.sunpride.van.pos.CartLine
import com.sunpride.van.pos.PosProductHit
import com.sunpride.van.pos.PosMoney
import com.sunpride.van.pos.ProductSearch
import com.sunpride.van.scanning.CameraScanScreen
import com.sunpride.van.scanning.LocalScannerInput
import com.sunpride.van.selling.*
import kotlinx.coroutines.delay

/**
 * IP-HH1: the selling kit shared by the van sale and the store sale. One scanner, a product grid, a search palette that
 * stays open, a cart bar on every selling screen, steppers, a quantity keypad, and the Payment and Complete steps.
 * Hosts (SaleScreen, StoreSaleScreen) only supply data and what "charge" means.
 */

/** One priced cart line as the cart sheet shows it. [totalLabel] is the line total or why it has none. */
data class CartRowUi(val productId: String, val product: Product?, val baseQuantity: Long, val unitPriceLabel: String?,
    val totalLabel: String, val note: String?, val availableBase: Long)

private data class Banner(val id: Int, val text: String, val error: Boolean)

private val Touch = 48.dp

@Composable private fun StockBadge(hit: PosProductHit, modifier: Modifier = Modifier) {
    val empty = hit.availableBase <= 0
    Surface(modifier.testTag("stock-badge-${hit.product.code}"), shape = RoundedCornerShape(8.dp),
        color = if (empty) SunprideTokens.emptyRed else SunprideTokens.stockGreen) {
        Text(if (empty) "EMPTY" else hit.product.displayQuantity(hit.availableBase), Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
            color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 16.sp, maxLines = 1)
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable private fun ProductCard(hit: PosProductHit, inCart: Long, highlighted: Boolean, onTap: () -> Unit, onLong: () -> Unit) {
    val empty = hit.availableBase <= 0
    Surface(Modifier.fillMaxWidth().heightIn(min = 124.dp).combinedClickable(onClick = onTap, onLongClick = onLong).testTag("grid-${hit.product.code}"),
        shape = SunprideTokens.shapes.large, color = if (empty) MaterialTheme.colorScheme.surfaceVariant else MaterialTheme.colorScheme.surface,
        border = BorderStroke(if (highlighted) 4.dp else 2.dp, if (highlighted) SunprideTokens.stockGreen else MaterialTheme.colorScheme.outline)) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Top) {
                if (inCart > 0) Surface(shape = CircleShape, color = SunprideTokens.barInk) {
                    Text("×" + hit.product.displayQuantity(inCart), Modifier.padding(horizontal = 10.dp, vertical = 4.dp).testTag("grid-incart-${hit.product.code}"), color = SunprideTokens.barYellow,
                        fontWeight = FontWeight.ExtraBold, fontSize = 16.sp)
                } else Spacer(Modifier.width(1.dp))
                StockBadge(hit)
            }
            Text(hit.product.name, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurface)
            Text(hit.price?.let { PosMoney.format(it.unitPriceMinor, it.currency) } ?: "Office price", fontSize = 22.sp, fontWeight = FontWeight.ExtraBold,
                color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.testTag("grid-price-${hit.product.code}"))
        }
    }
}

@Composable private fun CategoryChips(categories: List<Pair<String, Int>>, selected: String, onSelect: (String) -> Unit) {
    LazyRow(Modifier.fillMaxWidth().testTag("category-chips"), horizontalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(horizontal = 16.dp)) {
        items(categories) { (name, count) ->
            val on = name == selected
            Surface(Modifier.heightIn(min = Touch).clickable { onSelect(name) }.testTag("chip-$name"), shape = RoundedCornerShape(24.dp),
                color = if (on) SunprideTokens.barInk else MaterialTheme.colorScheme.surface,
                border = BorderStroke(2.dp, if (on) SunprideTokens.barInk else MaterialTheme.colorScheme.outline)) {
                Row(Modifier.padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(name, fontWeight = FontWeight.Bold, fontSize = 16.sp, color = if (on) Color.White else MaterialTheme.colorScheme.onSurface)
                    Text("$count", fontWeight = FontWeight.Bold, fontSize = 16.sp, color = if (on) SunprideTokens.barYellow else MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

/** The bar that is on every selling screen: "n items · View cart" and the total, with Charge one tap away. */
@Composable fun CartBar(itemCount: Int, totalLabel: String, chargeEnabled: Boolean, onOpen: () -> Unit, onCharge: () -> Unit, modifier: Modifier = Modifier) {
    Surface(modifier.fillMaxWidth(), color = SunprideTokens.barInk) {
        Row(Modifier.navigationBarsPadding().padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Column(Modifier.weight(1f).heightIn(min = 56.dp).clickable(onClick = onOpen).testTag("cart-bar"), verticalArrangement = Arrangement.Center) {
                Text("$itemCount ${if (itemCount == 1) "item" else "items"} · View cart", color = SunprideTokens.barText, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.testTag("cart-bar-count"))
                Text(totalLabel, color = SunprideTokens.barYellow, fontSize = 30.sp, lineHeight = 34.sp, fontWeight = FontWeight.ExtraBold, maxLines = 1, modifier = Modifier.testTag("cart-bar-total"))
            }
            Button(onCharge, Modifier.widthIn(min = 128.dp).heightIn(min = 64.dp).testTag("checkout"), enabled = chargeEnabled, shape = SunprideTokens.shapes.small,
                colors = ButtonDefaults.buttonColors(containerColor = SunprideTokens.barYellow, contentColor = Color.Black,
                    disabledContainerColor = Color(0xFF3A3A3A), disabledContentColor = Color(0xFFD0D0D0))) {
                Text("Charge", fontSize = 22.sp, fontWeight = FontWeight.ExtraBold)
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable fun SellingBrowse(
    title: String, subtitle: String?, onBack: () -> Unit, place: SellingPlace,
    search: ProductSearch, scanProducts: List<Product>,
    currentLines: () -> List<CartLine>, onSetLine: (String, Long) -> Unit,
    rows: List<CartRowUi>, totalLabel: String, chargeEnabled: Boolean, onCharge: () -> Unit,
    cartOpen: Boolean, onCartOpen: (Boolean) -> Unit,
    message: String?, busy: Boolean,
    header: (@Composable () -> Unit)? = null,
    cartExtras: @Composable ColumnScope.() -> Unit = {},
    cartTitle: String = "Cart",
) {
    val lines = currentLines()
    val all = remember(search) { search.search("", Int.MAX_VALUE).sortedBy { it.product.name.lowercase() } }
    val byId = remember(all) { all.associateBy { it.product.productId } }
    var category by rememberSaveable { mutableStateOf("All") }
    val categories = remember(all) { listOf("All" to all.size) + all.groupBy { Quantities.category(it.product) }.map { it.key to it.value.size }.sortedBy { it.first } }
    if (categories.none { it.first == category }) category = "All"
    val shown = remember(all, category) { if (category == "All") all else all.filter { Quantities.category(it.product) == category } }
    var banner by remember { mutableStateOf<Banner?>(null) }
    var bannerId by remember { mutableIntStateOf(0) }
    var touched by remember { mutableStateOf<String?>(null) }
    var keypadFor by remember { mutableStateOf<Product?>(null) }
    var paletteOpen by rememberSaveable { mutableStateOf(false) }
    var paletteQuery by rememberSaveable { mutableStateOf("") }
    var camera by remember { mutableStateOf(false) }
    val scanner = LocalScannerInput.current
    // Only this screen takes wedge bursts away from the keyboard path; screens with text fields leave them alone.
    DisposableEffect(scanner) { scanner?.wedgeCapture = true; onDispose { scanner?.wedgeCapture = false } }
    fun say(text: String, error: Boolean) { bannerId++; banner = Banner(bannerId, text, error) }
    LaunchedEffect(banner?.id) { if (banner != null) { delay(2600); banner = null } }
    LaunchedEffect(touched) { if (touched != null) { delay(1400); touched = null } }

    /** The one add path: grid tap, palette tap and scan all end here. */
    fun addUnits(product: Product, amount: Long, label: String?): Boolean {
        val available = byId[product.productId]?.availableBase ?: 0L
        return when (val outcome = SellingCart.add(currentLines(), product, amount, available)) {
            is AddOutcome.Added -> { onSetLine(product.productId, outcome.newBase); touched = product.productId
                if (label != null) say("+1 $label · ${product.name}", false); true }
            else -> { say(SellingCart.refusalText(outcome) ?: "Cannot add this.", true); false }
        }
    }
    val latestScanProducts by rememberUpdatedState(scanProducts)
    // The collector outlives recompositions: it must always call the newest add (fresh stock and cart), never the first one.
    val latestAdd by rememberUpdatedState<(Product, Long, String?) -> Boolean> { product, amount, label -> addUnits(product, amount, label) }
    LaunchedEffect(scanner, place) {
        scanner?.scans?.collect { event ->
            when (val action = ScanRules.resolve(event.code, latestScanProducts, place)) {
                is ScanAction.Add -> if (latestAdd(action.product, action.baseQuantity, action.unitLabel)) scanner.scanAdded() else scanner.scanRejected()
                is ScanAction.Refuse -> { say(action.message, true); scanner.scanRejected() }
            }
            camera = false
            // The typed copy of a scan can land in the palette's field: replace it, never keep it.
            if (paletteOpen) paletteQuery = ""
        }
    }
    if (camera) {
        CameraScanScreen(onCode = { scanner?.cameraCode(it) }, onClose = { camera = false }, closeLabel = "Back to selling")
        return
    }

    Scaffold(Modifier.fillMaxSize().imePadding(), containerColor = MaterialTheme.colorScheme.background, contentWindowInsets = WindowInsets.systemBars,
        topBar = {
            Surface(color = MaterialTheme.colorScheme.surface, shadowElevation = 2.dp) {
                Column(Modifier.statusBarsPadding().padding(horizontal = 8.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        TextButton(onBack, Modifier.heightIn(min = 56.dp).testTag("back"), colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface)) { Text("Back", fontSize = 17.sp, fontWeight = FontWeight.Bold) }
                        Column(Modifier.weight(1f)) {
                            Text(title, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag("screen-title"))
                            subtitle?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag("sale-customer")) }
                        }
                        OutlinedButton({ camera = true }, Modifier.heightIn(min = 56.dp).testTag("scan-camera"), shape = SunprideTokens.shapes.small,
                            colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface), border = BorderStroke(2.dp, MaterialTheme.colorScheme.outline)) { Text("Camera", fontWeight = FontWeight.Bold) }
                    }
                    Surface(Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable { paletteOpen = true }.testTag("sale-add-product"), shape = SunprideTokens.shapes.small,
                        color = MaterialTheme.colorScheme.background, border = BorderStroke(2.dp, MaterialTheme.colorScheme.outline)) {
                        Row(Modifier.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text("Search name, code or scan", fontSize = 18.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
                            Text("Search", fontWeight = FontWeight.Bold, fontSize = 16.sp)
                        }
                    }
                }
            }
        },
        bottomBar = { CartBar(lines.size, totalLabel, chargeEnabled && !busy, onOpen = { onCartOpen(true) }, onCharge = onCharge) }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Spacer(Modifier.height(0.dp))
            banner?.let { b ->
                Surface(Modifier.fillMaxWidth().padding(horizontal = 16.dp).semantics { liveRegion = LiveRegionMode.Polite }.testTag("scan-toast"), shape = SunprideTokens.shapes.small,
                    color = if (b.error) SunprideTokens.emptyRed else SunprideTokens.stockGreen) {
                    Text(b.text, Modifier.padding(14.dp), color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                }
            } ?: Text(message ?: "Ready to scan. Tap a product to add one, hold it to type a quantity.", Modifier.padding(horizontal = 16.dp).testTag("message"),
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            CategoryChips(categories, category) { category = it }
            LazyVerticalGrid(GridCells.Fixed(2), Modifier.fillMaxSize().testTag("product-grid"), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                header?.let { h -> item(span = { GridItemSpan(maxLineSpan) }) { h() } }
                if (shown.isEmpty()) item(span = { GridItemSpan(maxLineSpan) }) {
                    Text(if (all.isEmpty()) "No products on this ${place.noun} yet. Sync first." else "No products in this group.", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.testTag("no-products"))
                }
                items(shown, key = { it.product.productId }) { hit ->
                    ProductCard(hit, SellingCart.baseOf(lines, hit.product.productId), touched == hit.product.productId,
                        onTap = { addUnits(hit.product, hit.product.quantityScale, null) },
                        onLong = { if (hit.availableBase > 0) keypadFor = hit.product else say(SellingCart.refusalText(AddOutcome.OutOfStock(hit.product.name))!!, true) })
                }
            }
        }
    }

    if (paletteOpen) SearchPalette(search, lines, touched, onTap = { addUnits(it, it.quantityScale, null) }, query = paletteQuery, onQuery = { paletteQuery = it },
        banner = banner?.let { it.text to it.error }, onClose = { paletteOpen = false })
    keypadFor?.let { p ->
        QuantityKeypad(p, SellingCart.baseOf(lines, p.productId), byId[p.productId]?.availableBase ?: 0L,
            onSet = { base ->
                val outcome = SellingCart.setQuantity(currentLines(), p, base, byId[p.productId]?.availableBase ?: 0L)
                if (outcome is AddOutcome.Added) { onSetLine(p.productId, outcome.newBase); touched = p.productId; keypadFor = null }
                else say(SellingCart.refusalText(outcome) ?: "Cannot set this.", true)
            }, onClose = { keypadFor = null })
    }
    if (cartOpen) CartSheet(title = cartTitle, rows = rows, totalLabel = totalLabel, itemCount = lines.size, chargeEnabled = chargeEnabled && !busy,
        onSetLine = { id, base -> onSetLine(id, base) },
        onKeypad = { id -> keypadFor = scanProducts.firstOrNull { it.productId == id } },
        onCharge = onCharge, onClose = { onCartOpen(false) }, extras = cartExtras,
        banner = banner?.let { it.text to it.error }, onClear = { lines.forEach { onSetLine(it.productId, 0) } })
}

/** The search palette (Itemcount pattern 3): stays open, adds on tap, marks the match, shows IN CART n, and has a Done button. */
@Composable private fun SearchPalette(search: ProductSearch, lines: List<CartLine>, touched: String?, onTap: (Product) -> Unit, query: String, onQuery: (String) -> Unit,
    banner: Pair<String, Boolean>?, onClose: () -> Unit) {
    val scanner = LocalScannerInput.current
    DisposableEffect(scanner) { scanner?.wedgeCapture = false; onDispose { scanner?.wedgeCapture = true } }
    val hits = remember(search, query) { search.search(query, 80) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnClickOutside = false)) {
        Surface(Modifier.fillMaxSize().statusBarsPadding().imePadding().navigationBarsPadding().testTag("search-palette"), color = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(query, { if (it.length <= 120) onQuery(it) }, Modifier.weight(1f).heightIn(min = 60.dp).focusRequester(focus).testTag("product-search"),
                        placeholder = { Text("Name, code or barcode", fontSize = 18.sp) }, singleLine = true, keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                        shape = SunprideTokens.shapes.small, textStyle = MaterialTheme.typography.bodyLarge.copy(fontSize = 20.sp),
                        trailingIcon = if (query.isNotEmpty()) ({ TextButton({ onQuery("") }, Modifier.heightIn(min = Touch).testTag("product-clear")) { Text("Clear", fontWeight = FontWeight.Bold) } }) else null)
                }
                banner?.let { (text, error) ->
                    Surface(Modifier.fillMaxWidth().padding(horizontal = 12.dp).testTag("palette-toast"), shape = SunprideTokens.shapes.small, color = if (error) SunprideTokens.emptyRed else SunprideTokens.stockGreen) {
                        Text(text, Modifier.padding(12.dp), color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.Bold)
                    }
                }
                LazyColumn(Modifier.weight(1f).fillMaxWidth().testTag("product-results"), contentPadding = PaddingValues(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    itemsIndexedHits(hits) { index, hit ->
                        val inCart = SellingCart.baseOf(lines, hit.product.productId)
                        PaletteRow(hit, index, query, inCart, highlighted = touched == hit.product.productId, onTap = { onTap(hit.product) })
                    }
                    if (hits.isEmpty()) item { Text("No matching products", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(8.dp).testTag("no-match")) }
                }
                PrimaryBottomButtonPadded("Done", onClose, "palette-done")
            }
        }
    }
}

private inline fun androidx.compose.foundation.lazy.LazyListScope.itemsIndexedHits(hits: List<PosProductHit>, crossinline row: @Composable (Int, PosProductHit) -> Unit) {
    items(hits.size, key = { hits[it].product.productId }) { row(it, hits[it]) }
}

@Composable private fun PrimaryBottomButtonPadded(label: String, onClick: () -> Unit, tag: String, enabled: Boolean = true) {
    Box(Modifier.padding(12.dp)) { Button(onClick, Modifier.fillMaxWidth().heightIn(min = 64.dp).testTag(tag), enabled = enabled, shape = SunprideTokens.shapes.small,
        colors = ButtonDefaults.buttonColors(containerColor = SunprideTokens.barInk, contentColor = Color.White)) { Text(label, fontSize = 20.sp, fontWeight = FontWeight.ExtraBold) } }
}

@Composable private fun PaletteRow(hit: PosProductHit, index: Int, query: String, inCart: Long, highlighted: Boolean, onTap: () -> Unit) {
    Surface(Modifier.fillMaxWidth().heightIn(min = 72.dp).clickable(onClick = onTap).testTag("product-$index"), shape = SunprideTokens.shapes.small,
        color = if (inCart > 0) Color(0xFFDCEBFF) else MaterialTheme.colorScheme.surface,
        border = BorderStroke(if (highlighted) 4.dp else 2.dp, if (highlighted) SunprideTokens.stockGreen else MaterialTheme.colorScheme.outline)) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StockBadge(hit)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(highlight(hit.product.name, query), style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(hit.price?.let { PosMoney.format(it.unitPriceMinor, it.currency) } ?: "Office price", fontSize = 18.sp, fontWeight = FontWeight.ExtraBold, modifier = Modifier.testTag("product-price-$index"))
            }
            if (inCart > 0) Surface(shape = CircleShape, color = SunprideTokens.barInk, modifier = Modifier.testTag("in-cart-$index")) {
                Text("IN CART ${hit.product.displayQuantity(inCart)}", Modifier.padding(horizontal = 12.dp, vertical = 6.dp), color = SunprideTokens.barYellow, fontWeight = FontWeight.ExtraBold, fontSize = 15.sp)
            }
        }
    }
}

/** Marks every typed word where it appears in [text] (case-insensitive). */
internal fun highlight(text: String, query: String): AnnotatedString {
    val tokens = query.trim().split(' ').filter { it.isNotEmpty() }
    if (tokens.isEmpty()) return AnnotatedString(text)
    val marked = BooleanArray(text.length)
    val lower = text.lowercase()
    tokens.forEach { token ->
        var from = 0
        val t = token.lowercase()
        while (true) { val at = lower.indexOf(t, from); if (at < 0) break; for (i in at until minOf(text.length, at + t.length)) marked[i] = true; from = at + t.length }
    }
    return buildAnnotatedString {
        var i = 0
        while (i < text.length) {
            var j = i
            while (j < text.length && marked[j] == marked[i]) j++
            if (marked[i]) withStyle(SpanStyle(background = Color(0xFFFFE066), color = Color.Black)) { append(text.substring(i, j)) } else append(text.substring(i, j))
            i = j
        }
    }
}

@Composable private fun Stepper(product: Product?, base: Long, onChange: (Long) -> Unit, onTapQty: () -> Unit, tagPrefix: String) {
    val step = product?.quantityScale ?: 1L
    Row(verticalAlignment = Alignment.CenterVertically) {
        OutlinedButton({ onChange(maxOf(0L, base - step)) }, Modifier.size(width = 56.dp, height = 56.dp).testTag("$tagPrefix-minus"), shape = RoundedCornerShape(topStart = 10.dp, bottomStart = 10.dp),
            contentPadding = PaddingValues(0.dp), border = BorderStroke(2.dp, MaterialTheme.colorScheme.outline), colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface)) { Text("−", fontSize = 28.sp, fontWeight = FontWeight.ExtraBold) }
        Surface(Modifier.size(width = 64.dp, height = 56.dp).clickable(onClick = onTapQty).testTag("$tagPrefix-qty"), color = MaterialTheme.colorScheme.surface, border = BorderStroke(2.dp, MaterialTheme.colorScheme.outline)) {
            Box(contentAlignment = Alignment.Center) { Text(product?.displayQuantity(base) ?: "$base", fontSize = 22.sp, fontWeight = FontWeight.ExtraBold, textAlign = TextAlign.Center) }
        }
        OutlinedButton({ onChange(base + step) }, Modifier.size(width = 56.dp, height = 56.dp).testTag("$tagPrefix-plus"), shape = RoundedCornerShape(topEnd = 10.dp, bottomEnd = 10.dp),
            contentPadding = PaddingValues(0.dp), border = BorderStroke(2.dp, MaterialTheme.colorScheme.outline), colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface)) { Text("+", fontSize = 28.sp, fontWeight = FontWeight.ExtraBold) }
    }
}

/** The cart (Itemcount pattern 5): steppers, tap the quantity for a keypad, cases and pieces, line totals, Remove, footer total and Charge. */
@Composable private fun CartSheet(title: String, rows: List<CartRowUi>, totalLabel: String, itemCount: Int, chargeEnabled: Boolean,
    onSetLine: (String, Long) -> Unit, onKeypad: (String) -> Unit, onCharge: () -> Unit, onClose: () -> Unit, extras: @Composable ColumnScope.() -> Unit,
    banner: Pair<String, Boolean>?, onClear: () -> Unit) {
    var confirmClear by remember { mutableStateOf(false) }
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().testTag("cart-sheet"), color = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxSize()) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                    if (rows.isNotEmpty()) TextButton({ confirmClear = true }, Modifier.heightIn(min = 56.dp).testTag("cart-clear")) { Text("Clear", color = SunprideTokens.emptyRed, fontWeight = FontWeight.ExtraBold, fontSize = 17.sp) }
                    TextButton(onClose, Modifier.heightIn(min = 56.dp).testTag("cart-close")) { Text("Close", fontWeight = FontWeight.ExtraBold, fontSize = 17.sp, color = MaterialTheme.colorScheme.onSurface) }
                }
                banner?.let { (text, error) ->
                    Surface(Modifier.fillMaxWidth().padding(horizontal = 16.dp), shape = SunprideTokens.shapes.small, color = if (error) SunprideTokens.emptyRed else SunprideTokens.stockGreen) {
                        Text(text, Modifier.padding(12.dp), color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.Bold)
                    }
                }
                LazyColumn(Modifier.weight(1f).fillMaxWidth().testTag("cart-lines"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (rows.isEmpty()) item { Text("Your cart is empty. Scan or tap a product.", style = MaterialTheme.typography.titleMedium, modifier = Modifier.testTag("cart-empty")) }
                    items(rows.size, key = { rows[it].productId }) { index ->
                        val row = rows[index]
                        Surface(Modifier.fillMaxWidth().testTag("sale-line-$index"), shape = SunprideTokens.shapes.large, color = MaterialTheme.colorScheme.surface, border = BorderStroke(2.dp, MaterialTheme.colorScheme.outline)) {
                            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
                                    Column(Modifier.weight(1f)) {
                                        Text(row.product?.name ?: "Product no longer on this phone", style = MaterialTheme.typography.titleMedium)
                                        Text(buildString {
                                            row.product?.let { append(Quantities.label(it, row.baseQuantity)) }
                                            row.unitPriceLabel?.let { append(" · "); append(it) }
                                        }, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("line-qty-$index"))
                                        row.note?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                                    }
                                    Text(row.totalLabel, fontSize = 22.sp, fontWeight = FontWeight.ExtraBold, color = SunprideTokens.emptyRed, textAlign = TextAlign.End, modifier = Modifier.testTag("sale-line-total-$index"))
                                }
                                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                                    TextButton({ onSetLine(row.productId, 0) }, Modifier.heightIn(min = 56.dp).testTag("line-remove-$index")) { Text("Remove", color = SunprideTokens.emptyRed, fontWeight = FontWeight.ExtraBold, fontSize = 17.sp) }
                                    Stepper(row.product, row.baseQuantity, onChange = { v -> if (v <= row.availableBase || v < row.baseQuantity) onSetLine(row.productId, v) }, onTapQty = { onKeypad(row.productId) }, tagPrefix = "line-$index")
                                }
                                row.product?.let { p -> Quantities.casePack(p)?.let { pack ->
                                    OutlinedButton({ val next = row.baseQuantity + pack.perCaseBase; if (next <= row.availableBase) onSetLine(row.productId, next) }, Modifier.fillMaxWidth().heightIn(min = Touch).testTag("line-case-$index"),
                                        shape = SunprideTokens.shapes.small, border = BorderStroke(2.dp, MaterialTheme.colorScheme.outline), colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface)) { Text("+1 ${pack.uomCode} (${p.displayQuantity(pack.perCaseBase)} ${p.uomCode})", fontWeight = FontWeight.Bold) }
                                } }
                            }
                        }
                    }
                    item { Column(verticalArrangement = Arrangement.spacedBy(10.dp)) { extras() } }
                }
                Surface(color = MaterialTheme.colorScheme.surface, shadowElevation = 6.dp) {
                    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text("Total", style = MaterialTheme.typography.titleMedium)
                                Text("$itemCount ${if (itemCount == 1) "item" else "items"}", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            Text(totalLabel, style = MaterialTheme.typography.headlineLarge, modifier = Modifier.testTag("cart-total"))
                        }
                        Button(onCharge, Modifier.fillMaxWidth().heightIn(min = 64.dp).testTag("cart-charge"), enabled = chargeEnabled && itemCount > 0, shape = SunprideTokens.shapes.small,
                            colors = ButtonDefaults.buttonColors(containerColor = SunprideTokens.accessibleRed, contentColor = Color.White)) { Text("Charge", fontSize = 24.sp, fontWeight = FontWeight.ExtraBold) }
                    }
                }
            }
        }
    }
    if (confirmClear) AlertDialog(onDismissRequest = { confirmClear = false }, title = { Text("Clear the cart?") }, text = { Text("Every item comes out of this sale.") },
        confirmButton = { TextButton({ confirmClear = false; onClear() }, Modifier.heightIn(min = Touch).testTag("cart-clear-yes")) { Text("Clear cart", color = SunprideTokens.emptyRed, fontWeight = FontWeight.ExtraBold) } },
        dismissButton = { TextButton({ confirmClear = false }, Modifier.heightIn(min = Touch)) { Text("Keep", fontWeight = FontWeight.Bold) } })
}

/** A digit pad. [decimal] adds the point for products sold by weight. */
@Composable fun DigitPad(onKey: (String) -> Unit, decimal: Boolean, tag: String) {
    val keys = listOf(listOf("1", "2", "3"), listOf("4", "5", "6"), listOf("7", "8", "9"), listOf(if (decimal) "." else "", "0", "back"))
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        keys.forEach { row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { key ->
                    if (key.isEmpty()) Spacer(Modifier.weight(1f).height(64.dp))
                    else OutlinedButton({ onKey(key) }, Modifier.weight(1f).heightIn(min = 64.dp).testTag("$tag-key-$key"), shape = SunprideTokens.shapes.small,
                        border = BorderStroke(2.dp, MaterialTheme.colorScheme.outline), colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface)) {
                        Text(if (key == "back") "⌫" else key, fontSize = 28.sp, fontWeight = FontWeight.ExtraBold)
                    }
                }
            }
        }
    }
}

/** Long-press on a card, or a tap on the quantity in the cart: type the exact quantity, in pieces or whole cases. */
@Composable fun QuantityKeypad(product: Product, currentBase: Long, availableBase: Long, onSet: (Long) -> Unit, onClose: () -> Unit) {
    val pack = Quantities.casePack(product)
    var cases by remember { mutableStateOf(false) }
    var typed by remember { mutableStateOf("") }
    val decimal = !cases && product.quantityScale > 1
    val base: Long? = if (typed.isEmpty()) null else if (cases) typed.toLongOrNull()?.let { Math.multiplyExact(it, pack!!.perCaseBase) }
        else com.sunpride.van.ui.VanRules.parseQuantity(typed, product.quantityScale)
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxWidth().padding(12.dp).navigationBarsPadding().statusBarsPadding().testTag("qty-keypad"), shape = SunprideTokens.shapes.large) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(product.name, style = MaterialTheme.typography.titleMedium)
                Text("In cart now: ${Quantities.label(product, currentBase)} · ${product.displayQuantity(availableBase)} ${product.uomCode} on hand", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (pack != null) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf(false to product.uomCode, true to pack.uomCode).forEach { (isCase, label) ->
                        val on = cases == isCase
                        Button({ cases = isCase; typed = "" }, Modifier.weight(1f).heightIn(min = Touch).testTag("qty-unit-$label"), shape = SunprideTokens.shapes.small,
                            colors = ButtonDefaults.buttonColors(containerColor = if (on) SunprideTokens.barInk else MaterialTheme.colorScheme.surfaceVariant, contentColor = if (on) Color.White else MaterialTheme.colorScheme.onSurface)) { Text(label, fontWeight = FontWeight.ExtraBold, fontSize = 17.sp) }
                    }
                }
                Surface(Modifier.fillMaxWidth(), shape = SunprideTokens.shapes.small, color = MaterialTheme.colorScheme.background, border = BorderStroke(2.dp, MaterialTheme.colorScheme.outline)) {
                    Box(Modifier.fillMaxWidth().heightIn(min = 72.dp).padding(horizontal = 16.dp), contentAlignment = Alignment.CenterEnd) {
                        Text(typed.ifEmpty { "0" } + " " + (if (cases) pack!!.uomCode else product.uomCode), style = MaterialTheme.typography.headlineMedium, modifier = Modifier.testTag("sale-quantity"))
                    }
                }
                if (base != null && base > availableBase) Text("Only ${product.displayQuantity(availableBase)} ${product.uomCode} left.", color = SunprideTokens.emptyRed, fontWeight = FontWeight.Bold, modifier = Modifier.testTag("qty-over"))
                DigitPad(onKey = { key -> typed = when (key) {
                    "back" -> typed.dropLast(1)
                    "." -> if ('.' in typed || typed.isEmpty()) typed else "$typed."
                    else -> if (typed.length >= 9) typed else if (typed == "0") key else typed + key
                } }, decimal = decimal, tag = "qty")
                Button({ base?.let(onSet) }, Modifier.fillMaxWidth().heightIn(min = 64.dp).testTag("save-quantity"), enabled = base != null && base <= availableBase, shape = SunprideTokens.shapes.small,
                    colors = ButtonDefaults.buttonColors(containerColor = SunprideTokens.barInk, contentColor = Color.White)) { Text(if (base == 0L) "Remove from cart" else "Set quantity", fontSize = 20.sp, fontWeight = FontWeight.ExtraBold) }
                TextButton(onClose, Modifier.fillMaxWidth().heightIn(min = Touch).testTag("cancel-quantity")) { Text("Cancel", fontWeight = FontWeight.Bold, fontSize = 17.sp, color = MaterialTheme.colorScheme.onSurface) }
            }
        }
    }
}
