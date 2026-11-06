package com.sunpride.field.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat

/**
 * Field v2 look kit. The Field Sales app is a sibling of the handheld POS: Sunpride red contour header, a white sheet with
 * rounded top corners under it, FAFAFA cards with a hairline, pill chips and buttons, a near-black floating bar and stroke
 * icons drawn here (no icon library on the classpath). Visual only: nothing in this file knows about visits, sync or the wire.
 *
 * Contrast: white title text sits on the gradient (AB151C to D2282B, at least 5:1); chips pair a tinted fill with a dark
 * text of the same hue (at least 4.5:1, see LookContrastTest); touch targets are 48 dp.
 */
object Look {
    /** Header gradient. Fixed in light and dark so white text always has the same red under it. */
    val gradient = Brush.linearGradient(listOf(Color(0xFFAB151C), Color(0xFFD2282B)))
    val gradientStart = Color(0xFFAB151C)
    val gradientEnd = Color(0xFFD2282B)
    val barInk = Color(0xFF111111)
    val sheetTop = 28.dp
    val cardRadius = 20.dp
    val pill = 28.dp

    /** Chip tones: tinted fill, dark text of the same hue. */
    enum class Tone { NEUTRAL, GOOD, WARN, BAD, ACCENT }

    private val dark @Composable get() = MaterialTheme.colorScheme.background.luminance() < 0.5f
    val card: Color @Composable get() = MaterialTheme.colorScheme.surface
    val canvas: Color @Composable get() = MaterialTheme.colorScheme.background
    val hairline: Color @Composable get() = MaterialTheme.colorScheme.outlineVariant
    val accent: Color @Composable get() = MaterialTheme.colorScheme.primary
    val onAccent: Color @Composable get() = MaterialTheme.colorScheme.onPrimary
    val tint: Color @Composable get() = MaterialTheme.colorScheme.primaryContainer
    val onTint: Color @Composable get() = MaterialTheme.colorScheme.onPrimaryContainer
    val ink: Color @Composable get() = MaterialTheme.colorScheme.onSurface
    val muted: Color @Composable get() = MaterialTheme.colorScheme.onSurfaceVariant

    fun toneFill(tone: Tone, dark: Boolean): Color = when (tone) {
        Tone.NEUTRAL -> if (dark) Color(0xFF2A2A2A) else Color(0xFFEFEFF2)
        Tone.GOOD -> if (dark) Color(0xFF17301F) else Color(0xFFE3F1E7)
        Tone.WARN -> if (dark) Color(0xFF3A2A10) else Color(0xFFFFF1D6)
        Tone.BAD -> if (dark) Color(0xFF3F1A22) else Color(0xFFFDE3E6)
        Tone.ACCENT -> if (dark) Color(0xFF3A2220) else Color(0xFFFCE9E7)
    }

    fun toneText(tone: Tone, dark: Boolean): Color = when (tone) {
        Tone.NEUTRAL -> if (dark) Color(0xFFE4E4E7) else Color(0xFF3F3F46)
        Tone.GOOD -> if (dark) Color(0xFF8FD6A5) else Color(0xFF0F5C33)
        Tone.WARN -> if (dark) Color(0xFFF5C26B) else Color(0xFF7A4200)
        Tone.BAD -> if (dark) Color(0xFFF4A6B8) else Color(0xFF9E1220)
        Tone.ACCENT -> if (dark) Color(0xFFFFDAD6) else Color(0xFF8E1117)
    }

    @Composable fun fill(tone: Tone) = toneFill(tone, dark)
    @Composable fun text(tone: Tone) = toneText(tone, dark)
}

enum class GlyphKind {
    PLUS, MINUS, BACK, CLOSE, CHECK, SEARCH, CHEVRON, TODAY, ROUTE, STORE, CHAT, MORE, PERSON, PEOPLE, PHONE, NAVIGATE,
    SYNC, BOX, CLOCK, CASH, INFO, LOCK, SLIDERS, BATTERY, CAMERA, SIGN_OUT, LIST, PIN
}

/** Small stroke icons on a 24 unit grid, one stroke weight, round caps. */
@Composable
fun Glyph(kind: GlyphKind, color: Color, size: Dp = 24.dp, modifier: Modifier = Modifier, weight: Float = 2f) {
    Canvas(modifier.size(size)) {
        val u = this.size.minDimension / 24f
        val stroke = Stroke(width = weight * u, cap = StrokeCap.Round, join = StrokeJoin.Round)
        fun line(x1: Float, y1: Float, x2: Float, y2: Float) =
            drawLine(color, Offset(x1 * u, y1 * u), Offset(x2 * u, y2 * u), strokeWidth = weight * u, cap = StrokeCap.Round)
        fun rrect(x: Float, y: Float, w: Float, h: Float, r: Float) =
            drawRoundRect(color, Offset(x * u, y * u), Size(w * u, h * u), CornerRadius(r * u), style = stroke)
        fun path(block: Path.(Float) -> Unit) = drawPath(Path().apply { block(u) }, color, style = stroke)
        when (kind) {
            GlyphKind.PLUS -> { line(12f, 5f, 12f, 19f); line(5f, 12f, 19f, 12f) }
            GlyphKind.MINUS -> line(5f, 12f, 19f, 12f)
            GlyphKind.CLOSE -> { line(6f, 6f, 18f, 18f); line(18f, 6f, 6f, 18f) }
            GlyphKind.CHECK -> { line(5f, 12.5f, 10f, 17.5f); line(10f, 17.5f, 19f, 7f) }
            GlyphKind.BACK -> { line(15f, 5f, 8f, 12f); line(8f, 12f, 15f, 19f) }
            GlyphKind.CHEVRON -> { line(9f, 5f, 16f, 12f); line(16f, 12f, 9f, 19f) }
            GlyphKind.SEARCH -> { drawCircle(color, radius = 6.5f * u, center = Offset(10.5f * u, 10.5f * u), style = stroke); line(15.5f, 15.5f, 20f, 20f) }
            GlyphKind.TODAY -> {
                rrect(4f, 5.5f, 16f, 14.5f, 3.2f); line(4f, 10f, 20f, 10f); line(8.5f, 3.5f, 8.5f, 7f); line(15.5f, 3.5f, 15.5f, 7f)
                line(9f, 14.8f, 11.2f, 17f); line(11.2f, 17f, 15.2f, 12.8f)
            }
            GlyphKind.ROUTE, GlyphKind.PIN -> {
                path { s ->
                    moveTo(12f * s, 21f * s); cubicTo(7f * s, 16.5f * s, 5f * s, 13.5f * s, 5f * s, 10f * s)
                    cubicTo(5f * s, 6.1f * s, 8.1f * s, 3f * s, 12f * s, 3f * s); cubicTo(15.9f * s, 3f * s, 19f * s, 6.1f * s, 19f * s, 10f * s)
                    cubicTo(19f * s, 13.5f * s, 17f * s, 16.5f * s, 12f * s, 21f * s); close()
                }
                drawCircle(color, radius = 2.6f * u, center = Offset(12f * u, 10f * u), style = stroke)
            }
            GlyphKind.STORE -> {
                path { s -> moveTo(4f * s, 9.5f * s); lineTo(5.6f * s, 4.5f * s); lineTo(18.4f * s, 4.5f * s); lineTo(20f * s, 9.5f * s); close() }
                path { s -> moveTo(5.5f * s, 9.5f * s); lineTo(5.5f * s, 19.5f * s); lineTo(18.5f * s, 19.5f * s); lineTo(18.5f * s, 9.5f * s) }
                path { s -> moveTo(10f * s, 19.5f * s); lineTo(10f * s, 14f * s); lineTo(14f * s, 14f * s); lineTo(14f * s, 19.5f * s) }
            }
            GlyphKind.CHAT -> { rrect(4f, 4.5f, 16f, 12f, 3.6f); path { s -> moveTo(9f * s, 16.5f * s); lineTo(9f * s, 20.5f * s); lineTo(13.5f * s, 16.5f * s) } }
            GlyphKind.MORE -> {
                rrect(4.5f, 4.5f, 6f, 6f, 1.8f); rrect(13.5f, 4.5f, 6f, 6f, 1.8f)
                rrect(4.5f, 13.5f, 6f, 6f, 1.8f); rrect(13.5f, 13.5f, 6f, 6f, 1.8f)
            }
            GlyphKind.PERSON -> {
                drawCircle(color, radius = 3.7f * u, center = Offset(12f * u, 8.2f * u), style = stroke)
                path { s -> moveTo(5f * s, 20f * s); cubicTo(5f * s, 15.8f * s, 8f * s, 14f * s, 12f * s, 14f * s); cubicTo(16f * s, 14f * s, 19f * s, 15.8f * s, 19f * s, 20f * s) }
            }
            GlyphKind.PEOPLE -> {
                drawCircle(color, radius = 3f * u, center = Offset(9f * u, 8.5f * u), style = stroke)
                path { s -> moveTo(3.5f * s, 19f * s); cubicTo(3.5f * s, 15.8f * s, 6f * s, 14.5f * s, 9f * s, 14.5f * s); cubicTo(12f * s, 14.5f * s, 14.5f * s, 15.8f * s, 14.5f * s, 19f * s) }
                drawCircle(color, radius = 2.4f * u, center = Offset(16.8f * u, 9f * u), style = stroke)
                path { s -> moveTo(16.3f * s, 14.4f * s); cubicTo(19f * s, 14.4f * s, 20.6f * s, 15.7f * s, 20.6f * s, 18.5f * s) }
            }
            GlyphKind.PHONE -> path { s ->
                moveTo(7f * s, 3.8f * s); lineTo(9.6f * s, 3.8f * s); lineTo(10.7f * s, 8f * s); lineTo(8.8f * s, 9.4f * s)
                cubicTo(9.9f * s, 11.7f * s, 12.3f * s, 14.1f * s, 14.6f * s, 15.2f * s); lineTo(16f * s, 13.3f * s)
                lineTo(20.2f * s, 14.4f * s); lineTo(20.2f * s, 17f * s); cubicTo(20.2f * s, 18.9f * s, 18.8f * s, 20.2f * s, 17f * s, 20.2f * s)
                cubicTo(10f * s, 19.6f * s, 4.4f * s, 14f * s, 3.8f * s, 7f * s); cubicTo(3.8f * s, 5.2f * s, 5.1f * s, 3.8f * s, 7f * s, 3.8f * s)
            }
            GlyphKind.NAVIGATE -> path { s -> moveTo(20.5f * s, 3.5f * s); lineTo(4.5f * s, 10.5f * s); lineTo(11f * s, 13f * s); lineTo(13.5f * s, 19.5f * s); close() }
            GlyphKind.SYNC -> {
                drawArc(color, startAngle = -45f, sweepAngle = 270f, useCenter = false, topLeft = Offset(5f * u, 5f * u), size = Size(14f * u, 14f * u), style = stroke)
                line(16.9f, 7.1f, 16.9f, 3.2f); line(16.9f, 7.1f, 20.8f, 7.1f)
            }
            GlyphKind.BOX -> {
                path { s -> moveTo(12f * s, 3f * s); lineTo(20f * s, 7.5f * s); lineTo(20f * s, 16.5f * s); lineTo(12f * s, 21f * s); lineTo(4f * s, 16.5f * s); lineTo(4f * s, 7.5f * s); close() }
                line(4f, 7.5f, 12f, 12f); line(12f, 12f, 20f, 7.5f); line(12f, 12f, 12f, 21f)
            }
            GlyphKind.CLOCK -> { drawCircle(color, radius = 8.5f * u, center = Offset(12f * u, 12f * u), style = stroke); line(12f, 7f, 12f, 12f); line(12f, 12f, 15.5f, 14f) }
            GlyphKind.CASH -> { rrect(3f, 6.5f, 18f, 11f, 2.5f); drawCircle(color, radius = 2.6f * u, center = Offset(12f * u, 12f * u), style = stroke); line(6.5f, 12f, 6.6f, 12f); line(17.4f, 12f, 17.5f, 12f) }
            GlyphKind.INFO -> { drawCircle(color, radius = 9f * u, center = Offset(12f * u, 12f * u), style = stroke); line(12f, 11f, 12f, 16.5f); line(12f, 7.8f, 12f, 7.9f) }
            GlyphKind.LOCK -> { rrect(5.5f, 10.5f, 13f, 9.5f, 2.5f); path { s -> moveTo(8.5f * s, 10.5f * s); lineTo(8.5f * s, 8f * s); cubicTo(8.5f * s, 4.5f * s, 15.5f * s, 4.5f * s, 15.5f * s, 8f * s); lineTo(15.5f * s, 10.5f * s) } }
            GlyphKind.SLIDERS -> {
                line(4f, 7f, 20f, 7f); line(4f, 12f, 20f, 12f); line(4f, 17f, 20f, 17f)
                drawCircle(color, radius = 2.2f * u, center = Offset(9f * u, 7f * u)); drawCircle(color, radius = 2.2f * u, center = Offset(15f * u, 12f * u))
                drawCircle(color, radius = 2.2f * u, center = Offset(8f * u, 17f * u))
            }
            GlyphKind.BATTERY -> { rrect(3f, 8f, 15f, 8.5f, 2.2f); line(21f, 10.8f, 21f, 13.7f); line(6.5f, 12.2f, 12f, 12.2f) }
            GlyphKind.CAMERA -> { rrect(3f, 7f, 18f, 13f, 3.5f); drawCircle(color, radius = 3.6f * u, center = Offset(12f * u, 13.5f * u), style = stroke); line(8.5f, 4.5f, 15.5f, 4.5f) }
            GlyphKind.SIGN_OUT -> {
                path { s -> moveTo(10f * s, 4.5f * s); lineTo(6.5f * s, 4.5f * s); cubicTo(5.4f * s, 4.5f * s, 4.5f * s, 5.4f * s, 4.5f * s, 6.5f * s); lineTo(4.5f * s, 17.5f * s); cubicTo(4.5f * s, 18.6f * s, 5.4f * s, 19.5f * s, 6.5f * s, 19.5f * s); lineTo(10f * s, 19.5f * s) }
                line(10.5f, 12f, 20f, 12f); line(16.5f, 8.5f, 20f, 12f); line(16.5f, 15.5f, 20f, 12f)
            }
            GlyphKind.LIST -> { line(9f, 7f, 20f, 7f); line(9f, 12f, 20f, 12f); line(9f, 17f, 20f, 17f); line(4.5f, 7f, 4.6f, 7f); line(4.5f, 12f, 4.6f, 12f); line(4.5f, 17f, 4.6f, 17f) }
        }
    }
}

/** Soft contour lines for the red header, like the POS. Drawn once, no state. */
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

/** Light status-bar icons while the red header is under them; the previous style comes back when it leaves. */
@Composable
fun LightStatusIcons() {
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

/**
 * The red screen header: optional round Back, title and subtitle in white, [actions] on the right, an optional [below] row
 * (sync chip, location), and a white sheet with rounded top corners that starts under it. Draws behind the status bar.
 */
@Composable
fun FieldHeader(
    title: String, modifier: Modifier = Modifier, subtitle: String? = null, onBack: (() -> Unit)? = null,
    backTag: String? = null, titleTag: String? = null, actions: @Composable RowScope.() -> Unit = {},
    below: (@Composable () -> Unit)? = null,
) {
    LightStatusIcons()
    Box(modifier.fillMaxWidth()) {
        Box(Modifier.matchParentSize().background(Look.gradient)) { Canvas(Modifier.matchParentSize()) { drawContours() } }
        Column(Modifier.fillMaxWidth().statusBarsPadding().padding(start = 12.dp, end = 12.dp, top = 4.dp, bottom = Look.sheetTop)) {
            Row(Modifier.heightIn(min = 52.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (onBack != null) HeaderRoundButton(GlyphKind.BACK, "Back", onBack, Modifier.then(if (backTag != null) Modifier.testTag(backTag) else Modifier))
                else Box(Modifier.width(4.dp))
                Column(Modifier.weight(1f)) {
                    Text(title, color = Color.White, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = if (titleTag != null) Modifier.testTag(titleTag) else Modifier)
                    if (subtitle != null) Text(subtitle, color = Color.White, style = MaterialTheme.typography.bodySmall, maxLines = 1,
                        overflow = TextOverflow.Ellipsis)
                }
                actions()
            }
            below?.let { Box(Modifier.padding(start = 4.dp, top = 2.dp)) { it() } }
        }
        Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(Look.sheetTop)
            .clip(RoundedCornerShape(topStart = Look.sheetTop, topEnd = Look.sheetTop)).background(Look.canvas))
    }
}

/** A 48 dp tap target with a translucent white disc and a white [kind] glyph, for use on the red header. */
@Composable
fun HeaderRoundButton(kind: GlyphKind, description: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Box(modifier.size(48.dp).clickable(onClick = onClick, role = Role.Button).semantics { contentDescription = description },
        contentAlignment = Alignment.Center) {
        Box(Modifier.size(40.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.18f)), contentAlignment = Alignment.Center) {
            Glyph(kind, Color.White, 22.dp)
        }
    }
}

/** A small tinted status pill: label in a dark tone-matched colour. Never relies on colour alone: the label says it. */
@Composable
fun StatusChip(label: String, tone: Look.Tone = Look.Tone.NEUTRAL, modifier: Modifier = Modifier, textTag: String? = null) {
    Box(modifier.clip(CircleShape).background(Look.fill(tone)).padding(horizontal = 10.dp, vertical = 4.dp)) {
        Text(label, color = Look.text(tone), style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = if (textTag != null) Modifier.testTag(textTag) else Modifier)
    }
}

/** Filter pill. Selected = near-black fill with white text, as in the POS category row; unselected = outlined. 48 dp tap target. */
@Composable
fun FilterPill(label: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, count: Int? = null) {
    val ink = if (MaterialTheme.colorScheme.background.luminance() < 0.5f) Color(0xFFF2F2F3) else Look.barInk
    val onInk = if (MaterialTheme.colorScheme.background.luminance() < 0.5f) Look.barInk else Color.White
    Box(modifier.heightIn(min = 48.dp).clip(CircleShape)
        .clickable(onClick = onClick, role = Role.Tab).semantics { this.contentDescription = label + (count?.let { ", $it" } ?: "") },
        contentAlignment = Alignment.Center) {
        Row(Modifier.heightIn(min = 40.dp).clip(CircleShape).background(if (selected) ink else Color.Transparent)
            .then(if (selected) Modifier else Modifier.border(1.5.dp, Look.hairline, CircleShape)).padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(label, color = if (selected) onInk else Look.ink, style = MaterialTheme.typography.labelLarge, maxLines = 1)
            if (count != null) Text("$count", color = if (selected) onInk.copy(alpha = 0.85f) else Look.muted, style = MaterialTheme.typography.labelMedium)
        }
    }
}

/** The near-black floating bar from the POS: rounded, soft shadow. Content goes inside. */
fun Modifier.floatingBar(): Modifier = this.shadow(14.dp, RoundedCornerShape(28.dp), clip = false)
    .clip(RoundedCornerShape(28.dp)).background(Look.barInk)

/** A tinted round tile with a glyph, used at the start of list rows. */
@Composable
fun GlyphTile(kind: GlyphKind, modifier: Modifier = Modifier, size: Dp = 44.dp) {
    Box(modifier.size(size).clip(CircleShape).background(Look.tint), contentAlignment = Alignment.Center) {
        Glyph(kind, Look.onTint, size * 0.5f)
    }
}

/** A card with the hairline outline used for every grouped block. */
@Composable
fun LookCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    androidx.compose.material3.Surface(modifier.fillMaxWidth(), shape = RoundedCornerShape(Look.cardRadius), color = Look.card,
        border = BorderStroke(1.dp, Look.hairline)) { Column(content = content) }
}
