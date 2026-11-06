package com.sunpride.van.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.foundation.Canvas
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
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

/** "24 remaining" with an amber dot (BELION); "Out of stock" in red. Text >= 4.5:1 on the card. */
@Composable private fun StockBadge(hit: PosProductHit, modifier: Modifier = Modifier) {
    val empty = hit.availableBase <= 0
    Row(modifier.testTag("stock-badge-${hit.product.code}"), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.size(10.dp).clip(CircleShape).background((if (empty) SunprideTokens.emptyRed else Look.amberDot).copy(alpha = 0.28f)), contentAlignment = Alignment.Center) {
            Box(Modifier.size(5.dp).clip(CircleShape).background(if (empty) SunprideTokens.emptyRed else Look.amberDot))
        }
        Text(if (empty) "Out of stock" else hit.product.displayQuantity(hit.availableBase) + " remaining", color = if (empty) SunprideTokens.emptyRed else Look.amberText,
            fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** "₱194.67" with the peso sign in the accent colour and the amount in ink. */
private fun priceText(label: String, accent: Color): AnnotatedString = buildAnnotatedString {
    val sign = label.takeWhile { !it.isDigit() }
    if (sign.isNotEmpty() && label.length > sign.length) { withStyle(SpanStyle(color = accent)) { append(sign) }; append(label.substring(sign.length)) } else append(label)
}

@OptIn(ExperimentalFoundationApi::class)
@Composable private fun ProductCard(hit: PosProductHit, inCart: Long, highlighted: Boolean, onTap: () -> Unit, onLong: () -> Unit, onMinus: () -> Unit, onPlus: () -> Unit) {
    val empty = hit.availableBase <= 0
    val code = hit.product.code
    val border = when { highlighted -> BorderStroke(3.dp, Look.accent); inCart > 0 -> BorderStroke(1.5.dp, Look.accent.copy(alpha = 0.4f)); else -> BorderStroke(1.dp, Look.hairline) }
    Surface(Modifier.fillMaxWidth().combinedClickable(onClick = onTap, onLongClick = onLong).testTag("grid-$code"),
        shape = RoundedCornerShape(Look.cardRadius), color = Look.card, border = border) {
        Column(Modifier.padding(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Box {
                ProductPhoto(hit.product, Modifier.fillMaxWidth().aspectRatio(1.7f))
                if (empty) Box(Modifier.matchParentSize().clip(RoundedCornerShape(16.dp)).background(Color.White.copy(alpha = 0.55f)))
            }
            Column(Modifier.padding(horizontal = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                StockBadge(hit)
                Text(hit.product.name, Modifier.heightIn(min = 40.dp), fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis, color = Look.ink)
                FitText(hit.price?.let { priceText(PosMoney.format(it.unitPriceMinor, it.currency), Look.accent) } ?: AnnotatedString("Office price"), 20.sp, minSize = 13.sp, color = Look.ink,
                    tag = "grid-price-$code")
            }
            if (inCart > 0) QtyStepper(hit.product.displayQuantity(inCart), onMinus, onPlus, onQuantity = onLong, tagPrefix = "grid-$code")
            else Row(Modifier.fillMaxWidth().height(48.dp).clip(CircleShape).background(if (empty) MaterialTheme.colorScheme.surfaceVariant else Look.tint).clickable(onClick = onPlus).testTag("grid-add-$code"), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                val fg = if (empty) MaterialTheme.colorScheme.onSurfaceVariant else Look.accent
                Glyph(GlyphKind.PLUS, fg, 18.dp)
                Spacer(Modifier.width(6.dp))
                Text("Add", color = fg, fontSize = 17.sp, fontWeight = FontWeight.ExtraBold)
            }
        }
    }
}

/** Pill chips; the selected one is dark filled. */
@Composable private fun CategoryChips(categories: List<Pair<String, Int>>, selected: String, onSelect: (String) -> Unit) {
    LazyRow(Modifier.fillMaxWidth().testTag("category-chips"), horizontalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(horizontal = 16.dp)) {
        items(categories) { (name, count) ->
            val on = name == selected
            Surface(Modifier.heightIn(min = Touch).clip(CircleShape).clickable { onSelect(name) }.testTag("chip-$name"), shape = CircleShape,
                color = if (on) Look.barInk else Look.sheet,
                border = BorderStroke(1.5.dp, if (on) Look.barInk else Look.hairline)) {
                Row(Modifier.padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(name, fontWeight = FontWeight.Bold, fontSize = 15.sp, color = if (on) Color.White else Look.ink)
                    Text("$count", fontWeight = FontWeight.Bold, fontSize = 14.sp, color = if (on) Color(0xFFFFD7D2) else Look.muted)
                }
            }
        }
    }
}

/**
 * The floating dark bar that is on every selling screen: "n items selected", what is in it, the total in big type, and the round Charge
 * button (one tap to payment). Tapping the left side opens the cart.
 */
@Composable fun CartBar(itemCount: Int, totalLabel: String, chargeEnabled: Boolean, onOpen: () -> Unit, onCharge: () -> Unit, modifier: Modifier = Modifier, summary: String? = null,
    /** IP-LOOK polish: "2 products · 3 pcs"; null falls back to the line count. */
    countLabel: String? = null) {
    Box(modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 12.dp, vertical = 10.dp)) {
        Row(Modifier.fillMaxWidth().floatingBar().padding(start = 20.dp, end = 8.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f).heightIn(min = 56.dp).clickable(onClick = onOpen).testTag("cart-bar"), verticalArrangement = Arrangement.Center) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(countLabel ?: "$itemCount ${if (itemCount == 1) "item" else "items"}", color = SunprideTokens.barText, fontSize = 14.sp, fontWeight = FontWeight.Bold, maxLines = 1, softWrap = false, modifier = Modifier.testTag("cart-bar-count"))
                }
                FitText(totalLabel, 30.sp, minSize = 20.sp, color = Color.White, tag = "cart-bar-total")
            }
            // IP-LOOK polish: the bag button now carries its word, "Checkout" (one tap to Payment, as before).
            Row(Modifier.height(56.dp).clip(CircleShape).background(if (chargeEnabled) Look.gradient else Brush.linearGradient(listOf(Color(0xFF3A3A3A), Color(0xFF3A3A3A))))
                .border(1.5.dp, Color.White.copy(alpha = if (chargeEnabled) 0.4f else 0.15f), CircleShape)
                .clickable(enabled = chargeEnabled, onClick = onCharge, role = Role.Button).semantics { contentDescription = "Checkout" }.testTag("checkout")
                .padding(start = 16.dp, end = 14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Checkout", color = if (chargeEnabled) Color.White else Color(0xFFD0D0D0), fontSize = 15.sp, fontWeight = FontWeight.ExtraBold, maxLines = 1, softWrap = false)
                Glyph(GlyphKind.BAG, if (chargeEnabled) Color.White else Color(0xFFD0D0D0), 26.dp)
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
    /** IP-LOOK: who is selling (the signed-in seller) and in what role, for the header. Display only. */
    cashierName: String? = null, roleLabel: String = "Cashier",
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

    val navInset = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val countLabel = CartCount.label(lines) { id -> byId[id]?.product ?: scanProducts.firstOrNull { it.productId == id } }
    Box(Modifier.fillMaxSize().background(Look.canvas).imePadding()) {
        Column(Modifier.fillMaxSize()) {
            LookHeader(bottomOverlap = 20.dp) {
                // IP-LOOK polish: one 48dp row (back, small avatar, name, one role/place line) instead of three text lines.
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.size(48.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.18f)).clickable(onClick = onBack, role = Role.Button).testTag("back")
                        .semantics { contentDescription = "Back" }, contentAlignment = Alignment.Center) { Glyph(GlyphKind.BACK, Color.White, 22.dp) }
                    Avatar(cashierName ?: title, size = 40.dp)
                    Column(Modifier.weight(1f)) {
                        Text(cashierName ?: title, color = Color.White, fontSize = 18.sp, lineHeight = 22.sp, fontWeight = FontWeight.ExtraBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.testTag("cashier-name"))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            if (cashierName != null) Text("$roleLabel · ", color = Color.White, fontSize = 13.sp, lineHeight = 16.sp, maxLines = 1, softWrap = false)
                            Text(title, color = Color.White, fontSize = 13.sp, lineHeight = 16.sp, maxLines = 1, softWrap = false, modifier = Modifier.testTag("screen-title"))
                            subtitle?.let { Text(" · $it", color = Color.White, fontSize = 13.sp, lineHeight = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false).testTag("sale-customer")) }
                        }
                    }
                }
            }
            Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Surface(Modifier.weight(1f).heightIn(min = 48.dp).clip(CircleShape).clickable { paletteOpen = true }.testTag("sale-add-product"), shape = CircleShape,
                        color = Look.sheet, border = BorderStroke(1.5.dp, Look.hairline), shadowElevation = 2.dp) {
                        Row(Modifier.padding(horizontal = 18.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Glyph(GlyphKind.SEARCH, Look.muted, 22.dp)
                            Text("Scan or search a product", fontSize = 16.sp, color = Look.muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        }
                    }
                    Box(Modifier.size(48.dp).clip(CircleShape).background(Look.gradient).border(1.5.dp, Color.White.copy(alpha = 0.5f), CircleShape).clickable(role = Role.Button) { camera = true }
                        .testTag("scan-camera").semantics { contentDescription = "Scan with camera" }, contentAlignment = Alignment.Center) { Glyph(GlyphKind.CAMERA, Color.White, 24.dp) }
                }
                banner?.let { b ->
                    Surface(Modifier.fillMaxWidth().padding(horizontal = 16.dp).semantics { liveRegion = LiveRegionMode.Polite }.testTag("scan-toast"), shape = RoundedCornerShape(16.dp),
                        color = if (b.error) SunprideTokens.emptyRed else SunprideTokens.stockGreen) {
                        Text(b.text, Modifier.padding(14.dp), color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.Bold)
                    }
                } ?: message?.let { Text(it, Modifier.padding(horizontal = 20.dp).testTag("message"), fontSize = 14.sp, lineHeight = 18.sp, color = Look.ink, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                CategoryChips(categories, category) { category = it }
                LazyVerticalGrid(GridCells.Fixed(2), Modifier.fillMaxSize().testTag("product-grid"), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 2.dp, bottom = 88.dp + navInset),
                    horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    header?.let { h -> item(span = { GridItemSpan(maxLineSpan) }) { h() } }
                    if (shown.isEmpty()) item(span = { GridItemSpan(maxLineSpan) }) {
                        Text(if (all.isEmpty()) "No products on this ${place.noun} yet. Sync first." else "No products in this group.", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.testTag("no-products"))
                    }
                    items(shown, key = { it.product.productId }) { hit ->
                        val inCart = SellingCart.baseOf(lines, hit.product.productId)
                        ProductCard(hit, inCart, touched == hit.product.productId,
                            onTap = { addUnits(hit.product, hit.product.quantityScale, null) },
                            onLong = { if (hit.availableBase > 0) keypadFor = hit.product else say(SellingCart.refusalText(AddOutcome.OutOfStock(hit.product.name))!!, true) },
                            onMinus = { onSetLine(hit.product.productId, maxOf(0L, inCart - hit.product.quantityScale)) },
                            onPlus = { addUnits(hit.product, hit.product.quantityScale, null) })
                    }
                }
            }
        }
        CartBar(lines.size, totalLabel, chargeEnabled && !busy, onOpen = { onCartOpen(true) }, onCharge = onCharge, Modifier.align(Alignment.BottomCenter), countLabel = countLabel)
    }

    if (paletteOpen) SearchPalette(search, lines, touched, onTap = { addUnits(it, it.quantityScale, null) }, query = paletteQuery, onQuery = { paletteQuery = it },
        banner = banner?.let { it.text to it.error }, onClose = { paletteOpen = false })
    keypadFor?.let { p ->
        QuantityKeypad(p, SellingCart.baseOf(lines, p.productId), byId[p.productId]?.availableBase ?: 0L,
            priceLabel = rows.firstOrNull { it.productId == p.productId }?.unitPriceLabel?.removeSuffix(" each") ?: byId[p.productId]?.price?.let { PosMoney.format(it.unitPriceMinor, it.currency) },
            onSet = { base ->
                val outcome = SellingCart.setQuantity(currentLines(), p, base, byId[p.productId]?.availableBase ?: 0L)
                if (outcome is AddOutcome.Added) { onSetLine(p.productId, outcome.newBase); touched = p.productId; keypadFor = null }
                else say(SellingCart.refusalText(outcome) ?: "Cannot set this.", true)
            }, onClose = { keypadFor = null })
    }
    if (cartOpen) CartSheet(title = cartTitle, rows = rows, totalLabel = totalLabel, itemCount = lines.size, countLabel = countLabel, chargeEnabled = chargeEnabled && !busy,
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
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnClickOutside = false, decorFitsSystemWindows = false)) {
        Surface(Modifier.fillMaxSize().testTag("search-palette"), color = Look.canvas) {
            Column(Modifier.fillMaxSize().statusBarsPadding().imePadding().navigationBarsPadding(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(query, { if (it.length <= 120) onQuery(it) }, Modifier.weight(1f).heightIn(min = 60.dp).focusRequester(focus).testTag("product-search"),
                        placeholder = { Text("Name, code or barcode", fontSize = 18.sp) }, singleLine = true, keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                        shape = CircleShape, textStyle = MaterialTheme.typography.bodyLarge.copy(fontSize = 20.sp),
                        leadingIcon = { Glyph(GlyphKind.SEARCH, Look.muted, 22.dp) },
                        colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Look.accent, unfocusedBorderColor = Look.hairline, focusedContainerColor = Look.sheet, unfocusedContainerColor = Look.sheet),
                        trailingIcon = if (query.isNotEmpty()) ({ TextButton({ onQuery("") }, Modifier.heightIn(min = Touch).testTag("product-clear")) { Text("Clear", fontWeight = FontWeight.Bold, color = Look.accent) } }) else null)
                }
                banner?.let { (text, error) ->
                    Surface(Modifier.fillMaxWidth().padding(horizontal = 12.dp).testTag("palette-toast"), shape = RoundedCornerShape(16.dp), color = if (error) SunprideTokens.emptyRed else SunprideTokens.stockGreen) {
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
    Box(Modifier.padding(12.dp)) { PillButton(label, onClick, Modifier.testTag(tag), enabled = enabled, height = 60.dp, fontSize = 20.sp) }
}

@Composable private fun PaletteRow(hit: PosProductHit, index: Int, query: String, inCart: Long, highlighted: Boolean, onTap: () -> Unit) {
    Surface(Modifier.fillMaxWidth().heightIn(min = 76.dp).clip(RoundedCornerShape(18.dp)).clickable(onClick = onTap).testTag("product-$index"), shape = RoundedCornerShape(18.dp),
        color = if (inCart > 0) Look.tint else Look.card,
        border = BorderStroke(if (highlighted) 3.dp else 1.dp, if (highlighted) Look.accent else Look.hairline)) {
        Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ProductPhoto(hit.product, Modifier.size(60.dp), initialsSize = 20.sp, showCategory = false)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(highlight(hit.product.name, query), fontSize = 16.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                StockBadge(hit)
                Text(hit.price?.let { priceText(PosMoney.format(it.unitPriceMinor, it.currency), Look.accent) } ?: AnnotatedString("Office price"), fontSize = 18.sp, fontWeight = FontWeight.ExtraBold, modifier = Modifier.testTag("product-price-$index"))
            }
            if (inCart > 0) Surface(shape = CircleShape, color = Look.accent, modifier = Modifier.testTag("in-cart-$index")) {
                Text("IN CART ${hit.product.displayQuantity(inCart)}", Modifier.padding(horizontal = 12.dp, vertical = 6.dp), color = Look.onAccent, fontWeight = FontWeight.ExtraBold, fontSize = 14.sp)
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

/** The cart (Itemcount pattern 5): steppers, tap the quantity for a keypad, cases and pieces, line totals, Remove, footer total and Charge. */
@Composable private fun CartSheet(title: String, rows: List<CartRowUi>, totalLabel: String, itemCount: Int, countLabel: String, chargeEnabled: Boolean,
    onSetLine: (String, Long) -> Unit, onKeypad: (String) -> Unit, onCharge: () -> Unit, onClose: () -> Unit, extras: @Composable ColumnScope.() -> Unit,
    banner: Pair<String, Boolean>?, onClear: () -> Unit) {
    var confirmClear by remember { mutableStateOf(false) }
    LookSheet(title, onClose, tag = "cart-sheet", fill = true, closeTag = "cart-close", footer = {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.widthIn(min = 72.dp)) {
                Text("Total", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = Look.ink)
                Text(countLabel, fontSize = 14.sp, color = Look.muted, maxLines = 1)
            }
            FitText(totalLabel, 44.sp, Modifier.weight(1f), minSize = 24.sp, color = Look.ink, textAlign = TextAlign.End, tag = "cart-total")
        }
        PillButton("Charge", onCharge, Modifier.testTag("cart-charge"), enabled = chargeEnabled && itemCount > 0, height = 64.dp, fontSize = 22.sp)
    }) {
        banner?.let { (text, error) ->
            Surface(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), shape = RoundedCornerShape(16.dp), color = if (error) SunprideTokens.emptyRed else SunprideTokens.stockGreen) {
                Text(text, Modifier.padding(12.dp), color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.Bold)
            }
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth().testTag("cart-lines"), contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (rows.isNotEmpty()) item {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("Your order", Modifier.weight(1f), fontSize = 18.sp, fontWeight = FontWeight.Bold, color = Look.ink)
                    TextButton({ confirmClear = true }, Modifier.heightIn(min = Touch).testTag("cart-clear")) { Text("Clear", color = SunprideTokens.emptyRed, fontWeight = FontWeight.ExtraBold, fontSize = 17.sp) }
                }
            }
            if (rows.isEmpty()) item { Text("Your cart is empty. Scan or tap a product.", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(vertical = 12.dp).testTag("cart-empty")) }
            items(rows.size, key = { rows[it].productId }) { index ->
                val row = rows[index]
                Surface(Modifier.fillMaxWidth().testTag("sale-line-$index"), shape = RoundedCornerShape(Look.cardRadius), color = Look.card, border = BorderStroke(1.dp, Look.hairline)) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
                            row.product?.let { ProductPhoto(it, Modifier.size(56.dp), initialsSize = 18.sp, showCategory = false) }
                            Column(Modifier.weight(1f)) {
                                Text(row.product?.name ?: "Product no longer on this phone", fontSize = 17.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold)
                                Text(buildString {
                                    row.product?.let { append(Quantities.label(it, row.baseQuantity)) }
                                    row.unitPriceLabel?.let { append(" · "); append(it) }
                                }, style = MaterialTheme.typography.bodyMedium, color = Look.muted, modifier = Modifier.testTag("line-qty-$index"))
                                row.note?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = Look.muted) }
                            }
                            Box(Modifier.size(48.dp).clickable { onSetLine(row.productId, 0) }.testTag("line-remove-$index").semantics { contentDescription = "Remove" }, contentAlignment = Alignment.Center) {
                                Box(Modifier.size(32.dp).clip(CircleShape).background(Look.sheet).border(1.5.dp, SunprideTokens.emptyRed, CircleShape), contentAlignment = Alignment.Center) { Glyph(GlyphKind.CLOSE, SunprideTokens.emptyRed, 14.dp) }
                            }
                        }
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            val step = row.product?.quantityScale ?: 1L
                            QtyStepper(row.product?.displayQuantity(row.baseQuantity) ?: "${row.baseQuantity}", onMinus = { onSetLine(row.productId, maxOf(0L, row.baseQuantity - step)) },
                                onPlus = { val v = row.baseQuantity + step; if (v <= row.availableBase) onSetLine(row.productId, v) }, onQuantity = { onKeypad(row.productId) },
                                tagPrefix = "line-$index", modifier = Modifier.width(156.dp))
                            FitText(priceText(row.totalLabel, Look.accent), 24.sp, Modifier.weight(1f), minSize = 14.sp, color = Look.ink, textAlign = TextAlign.End, tag = "sale-line-total-$index")
                        }
                        row.product?.let { p -> Quantities.casePack(p)?.let { pack ->
                            Box(Modifier.fillMaxWidth().heightIn(min = Touch).clip(CircleShape).background(Look.tint).clickable { val next = row.baseQuantity + pack.perCaseBase; if (next <= row.availableBase) onSetLine(row.productId, next) }.testTag("line-case-$index"), contentAlignment = Alignment.Center) {
                                Text("+1 ${pack.uomCode} (${p.displayQuantity(pack.perCaseBase)} ${p.uomCode})", Modifier.padding(horizontal = 12.dp), color = Look.accent, fontWeight = FontWeight.ExtraBold, fontSize = 16.sp, maxLines = 1)
                            }
                        } }
                    }
                }
            }
            item { Column(verticalArrangement = Arrangement.spacedBy(10.dp)) { extras() } }
        }
    }
    if (confirmClear) AlertDialog(onDismissRequest = { confirmClear = false }, title = { Text("Clear the cart?") }, text = { Text("Every item comes out of this sale.") },
        shape = RoundedCornerShape(Look.sheetTop),
        confirmButton = { TextButton({ confirmClear = false; onClear() }, Modifier.heightIn(min = Touch).testTag("cart-clear-yes")) { Text("Clear cart", color = SunprideTokens.emptyRed, fontWeight = FontWeight.ExtraBold) } },
        dismissButton = { TextButton({ confirmClear = false }, Modifier.heightIn(min = Touch)) { Text("Keep", fontWeight = FontWeight.Bold) } })
}

/** A digit pad. [decimal] adds the point for products sold by weight. */
@Composable fun DigitPad(onKey: (String) -> Unit, decimal: Boolean, tag: String, keyHeight: androidx.compose.ui.unit.Dp = 56.dp) {
    val keys = listOf(listOf("1", "2", "3"), listOf("4", "5", "6"), listOf("7", "8", "9"), listOf(if (decimal) "." else "", "0", "back"))
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        keys.forEach { row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { key ->
                    if (key.isEmpty()) Spacer(Modifier.weight(1f).height(keyHeight))
                    else Box(Modifier.weight(1f).height(keyHeight).clip(RoundedCornerShape(18.dp)).background(Look.card).border(1.dp, Look.hairline, RoundedCornerShape(18.dp))
                        .clickable(role = Role.Button) { onKey(key) }.testTag("$tag-key-$key").semantics { if (key == "back") contentDescription = "Delete" }, contentAlignment = Alignment.Center) {
                        Text(if (key == "back") "⌫" else key, fontSize = 28.sp, fontWeight = FontWeight.ExtraBold, color = Look.ink)
                    }
                }
            }
        }
    }
}

/**
 * Edit line sheet. Long-press on a card, or a tap on the quantity in the cart: the product, its code and price, and the exact quantity
 * typed in pieces or whole cases; Done saves it, Cancel leaves it.
 */
@Composable fun QuantityKeypad(product: Product, currentBase: Long, availableBase: Long, onSet: (Long) -> Unit, onClose: () -> Unit, priceLabel: String? = null) {
    val pack = Quantities.casePack(product)
    var cases by remember { mutableStateOf(false) }
    var typed by remember { mutableStateOf("") }
    val decimal = !cases && product.quantityScale > 1
    val base: Long? = if (typed.isEmpty()) null else if (cases) typed.toLongOrNull()?.let { Math.multiplyExact(it, pack!!.perCaseBase) }
        else com.sunpride.van.ui.VanRules.parseQuantity(typed, product.quantityScale)
    LookSheet("Edit item", onClose, tag = "qty-keypad", footer = {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PillButton("Cancel", onClose, Modifier.weight(1f).testTag("cancel-quantity"), filled = false, height = 56.dp)
            PillButton(if (base == 0L) "Remove from cart" else "Done", { base?.let(onSet) }, Modifier.weight(1.6f).testTag("save-quantity"), enabled = base != null && base <= availableBase, height = 56.dp, fontSize = 20.sp)
        }
    }) {
        Column(Modifier.padding(horizontal = 20.dp).padding(top = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(product.name, fontSize = 20.sp, lineHeight = 24.sp, fontWeight = FontWeight.ExtraBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                LookField("Product code", product.code, Modifier.weight(1f), tag = "edit-code")
                LookField("Price", priceLabel ?: "Office price", Modifier.weight(1f), tag = "edit-price")
            }
            Text("In cart now: ${Quantities.label(product, currentBase)} · ${product.displayQuantity(availableBase)} ${product.uomCode} on hand", fontSize = 14.sp, color = Look.muted)
            if (pack != null) Row(Modifier.fillMaxWidth().clip(CircleShape).background(Look.tint), horizontalArrangement = Arrangement.spacedBy(0.dp)) {
                listOf(false to product.uomCode, true to pack.uomCode).forEach { (isCase, label) ->
                    val on = cases == isCase
                    Box(Modifier.weight(1f).heightIn(min = Touch).clip(CircleShape).background(if (on) Look.accent else Color.Transparent).clickable { cases = isCase; typed = "" }.testTag("qty-unit-$label"), contentAlignment = Alignment.Center) {
                        Text(label, fontWeight = FontWeight.ExtraBold, fontSize = 17.sp, color = if (on) Look.onAccent else Look.accent)
                    }
                }
            }
            Box(Modifier.fillMaxWidth().heightIn(min = 56.dp).clip(RoundedCornerShape(Look.pill)).border(1.5.dp, Look.hairline, RoundedCornerShape(Look.pill)).padding(horizontal = 18.dp), contentAlignment = Alignment.CenterEnd) {
                FitText(typed.ifEmpty { "0" } + " " + (if (cases) pack!!.uomCode else product.uomCode), 30.sp, Modifier.padding(vertical = 6.dp), minSize = 16.sp, color = Look.ink, textAlign = TextAlign.End, tag = "sale-quantity")
            }
            if (base != null && base > availableBase) Text("Only ${product.displayQuantity(availableBase)} ${product.uomCode} left.", color = SunprideTokens.emptyRed, fontWeight = FontWeight.Bold, modifier = Modifier.testTag("qty-over"))
            DigitPad(onKey = { key -> typed = when (key) {
                "back" -> typed.dropLast(1)
                "." -> if ('.' in typed || typed.isEmpty()) typed else "$typed."
                else -> if (typed.length >= 9) typed else if (typed == "0") key else typed + key
            } }, decimal = decimal, tag = "qty", keyHeight = 48.dp)
        }
    }
}
