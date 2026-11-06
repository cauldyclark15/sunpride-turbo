package com.sunpride.van.ui

import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.view.WindowCompat
import com.sunpride.van.data.Product
import com.sunpride.van.selling.Quantities
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * IP-LOOK: the BELION-style look of the handheld POS. Visual only: tokens, glyphs, steppers, sheets, the cashier header and the
 * product photo / tile. Nothing here knows about carts, prices or the wire; screens pass in what they already had.
 *
 * Contrast rules kept from IP-HH1: text >= 4.5:1 everywhere, primary numbers >= 7:1 (see SellingLookTest), 48dp touch targets.
 */
object Look {
    /** Header and sheet title gradient. Fixed in light and dark so the white title always sits on a red it can be read on (>= 5:1). */
    val gradient = Brush.linearGradient(listOf(Color(0xFFAB151C), Color(0xFFD2282B)))
    val gradientStart = Color(0xFFAB151C)
    val gradientEnd = Color(0xFFD2282B)
    val barInk = Color(0xFF111111)
    val amberText = Color(0xFF7A4200)
    val amberDot = Color(0xFFE08A00)
    val scrim = Color(0x80000000)
    val hairlineLight = Color(0xFFD9D9DE)
    val cardLight = Color(0xFFFAFAFA)
    val tintLight = Color(0xFFFCE9E7)
    val sheetTop = 28.dp
    val cardRadius = 20.dp
    val pill = 28.dp

    private val dark @Composable get() = MaterialTheme.colorScheme.background.luminance() < 0.5f
    val accent: Color @Composable get() = MaterialTheme.colorScheme.primary
    val onAccent: Color @Composable get() = MaterialTheme.colorScheme.onPrimary
    val tint: Color @Composable get() = if (dark) Color(0xFF3A2220) else tintLight
    val hairline: Color @Composable get() = if (dark) Color(0xFF4A4A4A) else hairlineLight
    val card: Color @Composable get() = if (dark) MaterialTheme.colorScheme.surface else cardLight
    val canvas: Color @Composable get() = MaterialTheme.colorScheme.background
    val sheet: Color @Composable get() = MaterialTheme.colorScheme.surface
    val ink: Color @Composable get() = MaterialTheme.colorScheme.onSurface
    val muted: Color @Composable get() = MaterialTheme.colorScheme.onSurfaceVariant

    /** Largest font size in [minSize, maxSize] whose single-line width is <= [maxWidthPx]. [widthAt] measures the text at a size in sp. Never returns less than [minSize]. */
    fun fitFontSize(maxSize: Float, minSize: Float, maxWidthPx: Float, widthAt: (Float) -> Float): Float {
        if (maxWidthPx <= 0f) return minSize
        var size = maxSize
        while (size > minSize && widthAt(size) > maxWidthPx) size -= 1f
        return size.coerceAtLeast(minSize)
    }
}

/** Single-line text that shrinks (down to [minSize]) instead of clipping, so an amount can never lose its last digits. */
@Composable fun FitText(text: String, maxSize: TextUnit, modifier: Modifier = Modifier, minSize: TextUnit = 14.sp, color: Color = Color.Unspecified,
    fontWeight: FontWeight = FontWeight.ExtraBold, textAlign: TextAlign? = null, tag: String? = null) =
    FitText(AnnotatedString(text), maxSize, modifier, minSize, color, fontWeight, textAlign, tag)

@Composable fun FitText(text: AnnotatedString, maxSize: TextUnit, modifier: Modifier = Modifier, minSize: TextUnit = 14.sp, color: Color = Color.Unspecified,
    fontWeight: FontWeight = FontWeight.ExtraBold, textAlign: TextAlign? = null, tag: String? = null) {
    val measurer = rememberTextMeasurer()
    BoxWithConstraints(modifier) {
        val maxPx = if (constraints.hasBoundedWidth) constraints.maxWidth.toFloat() else Float.MAX_VALUE
        val size = remember(text, maxPx, maxSize, minSize, fontWeight) {
            Look.fitFontSize(maxSize.value, minSize.value, maxPx) { s -> measurer.measure(text, TextStyle(fontSize = s.sp, fontWeight = fontWeight), maxLines = 1, softWrap = false).size.width.toFloat() }
        }
        Text(text, Modifier.then(if (tag != null) Modifier.testTag(tag) else Modifier).then(if (constraints.hasBoundedWidth) Modifier.fillMaxWidth() else Modifier),
            color = color, fontSize = size.sp, lineHeight = (size * 1.15f).sp, fontWeight = fontWeight, maxLines = 1, softWrap = false, textAlign = textAlign, overflow = TextOverflow.Clip)
    }
}

enum class GlyphKind { PLUS, MINUS, BAG, CAMERA, SEARCH, BACK, CLOSE, CHECK, PERCENT, HOME, CART, RECEIPT, WALLET, BOX, DOTS, CHEVRON, SYNC, PRINTER, USER, USERS, TRUCK, CHAT, FLAG, SWITCH, LOCK }

/** Small stroke icons drawn here so no icon library is needed. */
@Composable fun Glyph(kind: GlyphKind, color: Color, size: Dp = 20.dp, modifier: Modifier = Modifier) {
    Canvas(modifier.size(size)) {
        val u = this.size.minDimension / 24f
        val stroke = Stroke(width = 2.4f * u, cap = StrokeCap.Round, join = StrokeJoin.Round)
        fun line(x1: Float, y1: Float, x2: Float, y2: Float) = drawLine(color, Offset(x1 * u, y1 * u), Offset(x2 * u, y2 * u), strokeWidth = 2.4f * u, cap = StrokeCap.Round)
        when (kind) {
            GlyphKind.PLUS -> { line(12f, 5f, 12f, 19f); line(5f, 12f, 19f, 12f) }
            GlyphKind.MINUS -> line(5f, 12f, 19f, 12f)
            GlyphKind.CLOSE -> { line(6f, 6f, 18f, 18f); line(18f, 6f, 6f, 18f) }
            GlyphKind.CHECK -> { line(5f, 12.5f, 10f, 17.5f); line(10f, 17.5f, 19f, 7f) }
            GlyphKind.BACK -> { line(15f, 5f, 8f, 12f); line(8f, 12f, 15f, 19f) }
            GlyphKind.SEARCH -> { drawCircle(color, radius = 6.5f * u, center = Offset(10.5f * u, 10.5f * u), style = stroke); line(15.5f, 15.5f, 20f, 20f) }
            GlyphKind.BAG -> {
                drawRoundRect(color, Offset(4f * u, 8f * u), Size(16f * u, 12.5f * u), androidx.compose.ui.geometry.CornerRadius(3.5f * u), style = stroke)
                val handle = Path().apply { moveTo(8.5f * u, 8f * u); cubicTo(8.5f * u, 1.5f * u, 15.5f * u, 1.5f * u, 15.5f * u, 8f * u) }
                drawPath(handle, color, style = stroke)
            }
            GlyphKind.CAMERA -> {
                drawRoundRect(color, Offset(3f * u, 7f * u), Size(18f * u, 13f * u), androidx.compose.ui.geometry.CornerRadius(3.5f * u), style = stroke)
                drawCircle(color, radius = 3.6f * u, center = Offset(12f * u, 13.5f * u), style = stroke)
                line(8.5f, 4.5f, 15.5f, 4.5f)
            }
            GlyphKind.PERCENT -> {
                drawCircle(color, radius = 2.6f * u, center = Offset(7f * u, 7f * u), style = stroke)
                drawCircle(color, radius = 2.6f * u, center = Offset(17f * u, 17f * u), style = stroke)
                line(18f, 5f, 6f, 19f)
            }
            GlyphKind.HOME -> {
                line(3.5f, 11f, 12f, 3.5f); line(12f, 3.5f, 20.5f, 11f)
                line(6f, 9.5f, 6f, 20f); line(18f, 9.5f, 18f, 20f); line(6f, 20f, 18f, 20f)
                line(10f, 20f, 10f, 14f); line(14f, 20f, 14f, 14f); line(10f, 14f, 14f, 14f)
            }
            GlyphKind.CART -> {
                line(3f, 4.5f, 5.8f, 4.5f); line(5.8f, 4.5f, 8.2f, 15.5f); line(8.2f, 15.5f, 18.5f, 15.5f)
                line(6.4f, 7.5f, 20.5f, 7.5f); line(20.5f, 7.5f, 18.8f, 13f)
                drawCircle(color, radius = 1.7f * u, center = Offset(9.8f * u, 19.6f * u)); drawCircle(color, radius = 1.7f * u, center = Offset(17f * u, 19.6f * u))
            }
            GlyphKind.RECEIPT -> {
                drawRoundRect(color, Offset(5.5f * u, 2.8f * u), Size(13f * u, 18.4f * u), androidx.compose.ui.geometry.CornerRadius(2.5f * u), style = stroke)
                line(9f, 8f, 15f, 8f); line(9f, 12f, 15f, 12f); line(9f, 16f, 12.5f, 16f)
            }
            GlyphKind.WALLET -> {
                drawRoundRect(color, Offset(3f * u, 6f * u), Size(18f * u, 13.5f * u), androidx.compose.ui.geometry.CornerRadius(3.2f * u), style = stroke)
                line(5.5f, 6f, 16f, 3.6f); drawCircle(color, radius = 1.5f * u, center = Offset(16.4f * u, 12.8f * u))
            }
            GlyphKind.BOX -> {
                drawRoundRect(color, Offset(4f * u, 9f * u), Size(16f * u, 11f * u), androidx.compose.ui.geometry.CornerRadius(2f * u), style = stroke)
                line(3f, 9f, 5.5f, 4f); line(5.5f, 4f, 18.5f, 4f); line(18.5f, 4f, 21f, 9f); line(10f, 13.5f, 14f, 13.5f)
            }
            GlyphKind.DOTS -> { drawCircle(color, radius = 2.1f * u, center = Offset(5.5f * u, 12f * u)); drawCircle(color, radius = 2.1f * u, center = Offset(12f * u, 12f * u)); drawCircle(color, radius = 2.1f * u, center = Offset(18.5f * u, 12f * u)) }
            GlyphKind.CHEVRON -> { line(9f, 5f, 16f, 12f); line(16f, 12f, 9f, 19f) }
            GlyphKind.SYNC -> {
                drawArc(color, startAngle = -40f, sweepAngle = 250f, useCenter = false, topLeft = Offset(4.5f * u, 4.5f * u), size = Size(15f * u, 15f * u), style = stroke)
                line(19.5f, 3.5f, 19.6f, 8.2f); line(19.6f, 8.2f, 14.9f, 8.2f)
            }
            GlyphKind.PRINTER -> {
                drawRoundRect(color, Offset(3f * u, 9f * u), Size(18f * u, 8f * u), androidx.compose.ui.geometry.CornerRadius(2.5f * u), style = stroke)
                line(7f, 9f, 7f, 3.5f); line(7f, 3.5f, 17f, 3.5f); line(17f, 3.5f, 17f, 9f)
                drawRoundRect(color, Offset(7f * u, 14f * u), Size(10f * u, 6.5f * u), androidx.compose.ui.geometry.CornerRadius(1f * u), style = stroke)
            }
            GlyphKind.USER -> {
                drawCircle(color, radius = 4f * u, center = Offset(12f * u, 8f * u), style = stroke)
                drawArc(color, startAngle = 180f, sweepAngle = 180f, useCenter = false, topLeft = Offset(4.5f * u, 14f * u), size = Size(15f * u, 15f * u), style = stroke)
            }
            GlyphKind.USERS -> {
                drawCircle(color, radius = 3.4f * u, center = Offset(9f * u, 8.5f * u), style = stroke)
                drawArc(color, startAngle = 180f, sweepAngle = 180f, useCenter = false, topLeft = Offset(2.5f * u, 14.5f * u), size = Size(13f * u, 13f * u), style = stroke)
                drawCircle(color, radius = 2.8f * u, center = Offset(17.2f * u, 9.2f * u), style = stroke)
                drawArc(color, startAngle = 200f, sweepAngle = 150f, useCenter = false, topLeft = Offset(12.5f * u, 14.5f * u), size = Size(10f * u, 10f * u), style = stroke)
            }
            GlyphKind.TRUCK -> {
                drawRoundRect(color, Offset(2f * u, 6f * u), Size(12f * u, 10f * u), androidx.compose.ui.geometry.CornerRadius(1.5f * u), style = stroke)
                line(14f, 9.5f, 18.2f, 9.5f); line(18.2f, 9.5f, 21.5f, 13f); line(21.5f, 13f, 21.5f, 16f); line(14f, 16f, 21.5f, 16f)
                drawCircle(color, radius = 2.1f * u, center = Offset(7f * u, 17.8f * u), style = stroke); drawCircle(color, radius = 2.1f * u, center = Offset(17f * u, 17.8f * u), style = stroke)
            }
            GlyphKind.CHAT -> {
                drawRoundRect(color, Offset(3f * u, 4f * u), Size(18f * u, 12.5f * u), androidx.compose.ui.geometry.CornerRadius(4f * u), style = stroke)
                line(8f, 16.5f, 7f, 20.5f); line(7f, 20.5f, 12f, 16.5f)
            }
            GlyphKind.FLAG -> { line(6f, 3.5f, 6f, 21f); line(6f, 4.5f, 18.5f, 4.5f); line(18.5f, 4.5f, 15.5f, 8.5f); line(15.5f, 8.5f, 18.5f, 12.5f); line(18.5f, 12.5f, 6f, 12.5f) }
            GlyphKind.SWITCH -> { line(4f, 8f, 19f, 8f); line(19f, 8f, 15.5f, 4.5f); line(20f, 16f, 5f, 16f); line(5f, 16f, 8.5f, 19.5f) }
            GlyphKind.LOCK -> {
                drawRoundRect(color, Offset(5f * u, 10.5f * u), Size(14f * u, 10f * u), androidx.compose.ui.geometry.CornerRadius(2.5f * u), style = stroke)
                drawArc(color, startAngle = 180f, sweepAngle = 180f, useCenter = false, topLeft = Offset(8f * u, 3.5f * u), size = Size(8f * u, 10f * u), style = stroke)
            }
        }
    }
}

/** A round action button with a [Glyph]. The whole [touch] square is the tap target; the visible disc is [disc]. */
@Composable fun GlyphButton(kind: GlyphKind, description: String, onClick: () -> Unit, modifier: Modifier = Modifier, touch: Dp = 48.dp, disc: Dp = 40.dp,
    background: Color = Look.accent, glyph: Color = Look.onAccent, enabled: Boolean = true) {
    Box(modifier.size(touch).clickable(enabled = enabled, onClick = onClick, role = androidx.compose.ui.semantics.Role.Button).semantics { contentDescription = description }, contentAlignment = Alignment.Center) {
        Box(Modifier.size(disc).clip(CircleShape).background(background), contentAlignment = Alignment.Center) { Glyph(kind, glyph, disc * 0.5f) }
    }
}

/** The pale track with a round minus, the quantity, and a round plus (the BELION stepper). 48dp tall; each button is a 48dp tap target. */
@Composable fun QtyStepper(quantity: String, onMinus: () -> Unit, onPlus: () -> Unit, onQuantity: (() -> Unit)?, tagPrefix: String, modifier: Modifier = Modifier,
    plusEnabled: Boolean = true) {
    Row(modifier.height(48.dp).clip(CircleShape).background(Look.tint), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(48.dp).clickable(onClick = onMinus).testTag("$tagPrefix-minus").semantics { contentDescription = "Remove one" }, contentAlignment = Alignment.Center) {
            Box(Modifier.size(36.dp).clip(CircleShape).background(Look.accent), contentAlignment = Alignment.Center) { Glyph(GlyphKind.MINUS, Look.onAccent, 18.dp) }
        }
        Box(Modifier.weight(1f).fillMaxHeight().then(if (onQuantity != null) Modifier.clickable(onClick = onQuantity) else Modifier).testTag("$tagPrefix-qty"), contentAlignment = Alignment.Center) {
            FitText(quantity, 20.sp, Modifier.padding(horizontal = 2.dp), minSize = 12.sp, color = Look.ink, textAlign = TextAlign.Center)
        }
        Box(Modifier.size(48.dp).clickable(onClick = onPlus).testTag("$tagPrefix-plus").semantics { contentDescription = "Add one" }, contentAlignment = Alignment.Center) {
            Box(Modifier.size(36.dp).clip(CircleShape).background(if (plusEnabled) Look.accent else Look.hairline), contentAlignment = Alignment.Center) { Glyph(GlyphKind.PLUS, Look.onAccent, 18.dp) }
        }
    }
}

/** Full-width pill buttons: the filled accent one (Done / Set / Charge) and the white outlined one (Cancel). */
@Composable fun PillButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, filled: Boolean = true, height: Dp = 56.dp,
    fontSize: TextUnit = 18.sp, fillColor: Color? = null) {
    val shape = RoundedCornerShape(Look.pill + 8.dp)
    val bg = when { !filled -> Look.sheet; !enabled -> MaterialTheme.colorScheme.surfaceVariant; fillColor != null -> fillColor; else -> Look.accent }
    val fg = when { !filled -> Look.ink; !enabled -> MaterialTheme.colorScheme.onSurfaceVariant; else -> if (fillColor != null) Color.White else Look.onAccent }
    Box(modifier.fillMaxWidth().heightIn(min = height).clip(shape).background(bg).then(if (!filled) Modifier.border(1.5.dp, Look.hairline, shape) else Modifier)
        .clickable(enabled = enabled, onClick = onClick, role = androidx.compose.ui.semantics.Role.Button), contentAlignment = Alignment.Center) {
        FitText(label, fontSize, Modifier.padding(horizontal = 16.dp), minSize = 13.sp, color = fg, textAlign = TextAlign.Center)
    }
}

/** Light status-bar icons while a red header is under them; the previous style comes back when the screen leaves. */
@Composable fun LightStatusIcons() {
    val view = LocalView.current
    if (view.isInEditMode) return
    DisposableEffect(view) {
        val window = (view.context as? android.app.Activity)?.window
        val controller = window?.let { WindowCompat.getInsetsController(it, view) }
        val previous = controller?.isAppearanceLightStatusBars
        controller?.isAppearanceLightStatusBars = false
        onDispose { if (previous != null) controller.isAppearanceLightStatusBars = previous }
    }
}

/** Soft contour lines for the red header, like the reference. Drawn once, no state. */
fun DrawScope.drawContours() {
    val w = size.width
    val h = size.height
    val line = Color.White.copy(alpha = 0.10f)
    for (i in 0..5) {
        val y = h * (0.15f + i * 0.17f)
        val p = Path().apply {
            moveTo(-20f, y)
            cubicTo(w * 0.25f, y - h * 0.35f, w * 0.55f, y + h * 0.45f, w + 20f, y - h * 0.10f)
        }
        drawPath(p, line, style = Stroke(width = 2.2f))
    }
    drawCircle(Color.White.copy(alpha = 0.06f), radius = h * 0.9f, center = Offset(w * 0.9f, -h * 0.1f))
}

/** Initials for an avatar or a photo tile: the first letters of the first two words (letters and digits only). */
fun initialsOf(name: String, max: Int = 2): String {
    val words = name.trim().split(Regex("\\s+")).map { w -> w.filter { it.isLetterOrDigit() } }.filter { it.isNotEmpty() }
    if (words.isEmpty()) return "?"
    return if (words.size == 1) words[0].take(max).uppercase() else words.take(max).map { it.first() }.joinToString("").uppercase()
}

@Composable fun Avatar(name: String, modifier: Modifier = Modifier, size: Dp = 48.dp) {
    Box(modifier.size(size).clip(CircleShape).background(Color(0xFFFCE9E7)).border(2.dp, Color.White.copy(alpha = 0.7f), CircleShape), contentAlignment = Alignment.Center) {
        Text(initialsOf(name), color = Color(0xFF8E1117), fontWeight = FontWeight.ExtraBold, fontSize = (size.value * 0.38f).sp)
    }
}

/** The red cashier header: avatar, name, role line; the content below it starts on a white sheet with rounded top corners. */
@Composable fun LookHeader(modifier: Modifier = Modifier, bottomOverlap: Dp = Look.sheetTop, content: @Composable ColumnScope.() -> Unit) {
    LightStatusIcons()
    Box(modifier.fillMaxWidth()) {
        Box(Modifier.matchParentSize().background(Look.gradient)) { Canvas(Modifier.matchParentSize()) { drawContours() } }
        Column(Modifier.fillMaxWidth().statusBarsPadding().padding(start = 12.dp, end = 12.dp, top = 2.dp, bottom = bottomOverlap + 2.dp), content = content)
        Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(bottomOverlap).clip(RoundedCornerShape(topStart = Look.sheetTop, topEnd = Look.sheetTop)).background(Look.canvas))
    }
}

/**
 * A bottom sheet (BELION "Select Discount" / "Additional Transaction"): a dimmed screen, a red title panel, and a white sheet with rounded top
 * corners overlapping it. [fill] gives it nearly the whole screen (cart); otherwise it wraps its content and scrolls only if it must.
 */
@Composable fun LookSheet(title: String, onClose: () -> Unit, tag: String, modifier: Modifier = Modifier, fill: Boolean = false, dismissible: Boolean = true,
    closeTag: String? = null, footer: (@Composable ColumnScope.() -> Unit)? = null, content: @Composable ColumnScope.() -> Unit) {
    Dialog(onDismissRequest = { if (dismissible) onClose() }, properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnClickOutside = dismissible, decorFitsSystemWindows = false)) {
        Box(Modifier.fillMaxSize().background(Look.scrim).clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { if (dismissible) onClose() }
            .statusBarsPadding().imePadding(), contentAlignment = Alignment.BottomCenter) {
            val none = remember { MutableInteractionSource() }
            Box(modifier.fillMaxWidth().then(if (fill) Modifier.fillMaxHeight(0.94f) else Modifier).clickable(interactionSource = none, indication = null) {}.testTag(tag)) {
                Box(Modifier.fillMaxWidth().height(76.dp).clip(RoundedCornerShape(topStart = Look.sheetTop, topEnd = Look.sheetTop)).background(Look.gradient)) {
                    Canvas(Modifier.matchParentSize()) { drawContours() }
                    Text(title, Modifier.align(Alignment.TopCenter).padding(top = 12.dp, start = 72.dp, end = 72.dp), color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
                    if (closeTag != null) Box(Modifier.align(Alignment.TopEnd).padding(top = 0.dp, end = 8.dp).size(48.dp).clickable(onClick = onClose).testTag(closeTag).semantics { contentDescription = "Close" }, contentAlignment = Alignment.Center) { Glyph(GlyphKind.CLOSE, Color.White, 20.dp) }
                }
                Surface(Modifier.padding(top = 44.dp).fillMaxWidth().then(if (fill) Modifier.fillMaxHeight() else Modifier), color = Look.sheet,
                    shape = RoundedCornerShape(topStart = Look.sheetTop, topEnd = Look.sheetTop), shadowElevation = 8.dp) {
                    Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
                        Column(Modifier.then(if (fill) Modifier.weight(1f) else Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())).fillMaxWidth(), content = content)
                        footer?.let { f -> Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(top = 8.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp), content = f) }
                    }
                }
            }
        }
    }
}

/** A read-only pill field (label above, value inside), like "Product Code N-102" in the reference. */
@Composable fun LookField(label: String, value: String, modifier: Modifier = Modifier, tag: String? = null, valueColor: Color = Look.ink) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, Modifier.padding(start = 14.dp), color = Look.muted, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
        Box(Modifier.fillMaxWidth().heightIn(min = 48.dp).clip(RoundedCornerShape(Look.pill)).border(1.5.dp, Look.hairline, RoundedCornerShape(Look.pill)).padding(horizontal = 16.dp), contentAlignment = Alignment.CenterStart) {
            FitText(value, 18.sp, Modifier.padding(vertical = 10.dp), minSize = 12.sp, color = valueColor, fontWeight = FontWeight.SemiBold, tag = tag)
        }
    }
}

/** Soft shadowed white card used on the payment and complete steps. */
@Composable fun LookCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Surface(modifier.fillMaxWidth(), shape = RoundedCornerShape(Look.cardRadius), color = Look.sheet, border = androidx.compose.foundation.BorderStroke(1.dp, Look.hairline), shadowElevation = 1.dp) {
        Column(content = content)
    }
}

/** Product photos come from the offline, SHA-verified catalogue image cache the sync already fills; nothing is fetched here. */
object LookImages {
    private val memory = object : LruCache<String, ImageBitmap>(24) {}
    private val misses = java.util.Collections.synchronizedSet(HashSet<String>())
    fun cached(sha: String): ImageBitmap? = memory.get(sha)
    suspend fun load(context: android.content.Context, product: Product): ImageBitmap? {
        val detail = product.catalogue ?: return null
        val image = detail.image ?: return null
        memory.get(image.sha256)?.let { return it }
        if (image.sha256 in misses) return null
        return withContext(Dispatchers.IO) {
            val file = runCatching { com.sunpride.catalogue.catalogueImage(context, detail, null) }.getOrNull()
            val bitmap = file?.let {
                runCatching {
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeFile(it.path, bounds)
                    var sample = 1
                    while (bounds.outWidth / sample > 640) sample *= 2
                    BitmapFactory.decodeFile(it.path, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
                }.getOrNull()
            }
            if (bitmap != null) memory.put(image.sha256, bitmap) else misses.add(image.sha256)
            bitmap
        }
    }
}

internal val tileTints = listOf(Color(0xFFFCE9E7), Color(0xFFFFF1D6), Color(0xFFE3F1E7), Color(0xFFE5EEFA), Color(0xFFEFE7F7), Color(0xFFF1EDE4))

/** The product picture when the bundle carries one, else a clean tinted tile with the initials and the category. */
@Composable fun ProductPhoto(product: Product, modifier: Modifier = Modifier, initialsSize: TextUnit = 34.sp, showCategory: Boolean = true) {
    val context = LocalContext.current
    val sha = product.catalogue?.image?.sha256
    val bitmap by produceState(sha?.let { LookImages.cached(it) }, sha) { if (value == null) value = LookImages.load(context, product) }
    val shape = RoundedCornerShape(16.dp)
    val photo = bitmap
    if (photo != null) Image(photo, contentDescription = product.name, modifier = modifier.clip(shape), contentScale = ContentScale.Crop)
    else {
        val category = Quantities.category(product)
        val tile = tileTints[(category.lowercase().hashCode() and 0x7fffffff) % tileTints.size]
        Box(modifier.clip(shape).background(tile), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(initialsOf(product.name), color = Color(0xFF18181B), fontSize = initialsSize, fontWeight = FontWeight.ExtraBold, maxLines = 1)
                if (showCategory) Text(category, Modifier.padding(horizontal = 8.dp), color = Color(0xFF3F3F46), fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** The floating dark bar's shadow and shape in one modifier. */
fun Modifier.floatingBar(): Modifier = this.shadow(14.dp, RoundedCornerShape(28.dp), clip = false).clip(RoundedCornerShape(28.dp)).background(Look.barInk)

/**
 * The compact red title bar for every non-browse screen (payment, complete, till open/close, X/Z, receipts...): optional round Back,
 * the title in white, rounded white sheet starting under it. [title] keeps the "screen-title" tag the tests and the readers use.
 */
@Composable fun LookTopBar(title: String, onBack: (() -> Unit)?, modifier: Modifier = Modifier, backEnabled: Boolean = true, subtitle: String? = null, trailing: (@Composable () -> Unit)? = null) {
    LookHeader(modifier, bottomOverlap = 14.dp) {
        Row(Modifier.heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            if (onBack != null) Box(Modifier.size(48.dp).clip(CircleShape).background(Color.White.copy(alpha = if (backEnabled) 0.18f else 0.08f))
                .clickable(enabled = backEnabled, onClick = onBack, role = androidx.compose.ui.semantics.Role.Button).testTag("back").semantics { contentDescription = "Back" }, contentAlignment = Alignment.Center) {
                Glyph(GlyphKind.BACK, Color.White, 22.dp)
            } else Spacer(Modifier.width(4.dp))
            Column(Modifier.weight(1f)) {
                Text(title, color = Color.White, fontSize = 21.sp, lineHeight = 26.sp, fontWeight = FontWeight.ExtraBold, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag("screen-title"))
                subtitle?.let { Text(it, color = Color.White, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
            trailing?.invoke()
        }
    }
}
