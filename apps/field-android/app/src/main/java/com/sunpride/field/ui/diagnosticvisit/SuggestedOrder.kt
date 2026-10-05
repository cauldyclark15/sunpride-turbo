package com.sunpride.field.ui.diagnosticvisit

import com.sunpride.field.auth.AuthFailure
import com.sunpride.field.auth.ConvexFunctionError
import com.sunpride.field.storage.CallSheet
import org.json.JSONException
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * ANA-010: the ICO suggested order (`analytics/suggested_orders:forOutlet`, ANA-009 engine) shown on the
 * call sheet. Read-only: these types only ever change local Order text fields. Nothing here queues or
 * submits; the salesperson still taps "Save call sheet", whose payload is unchanged.
 */
data class SuggestedLine(val productId: String?, val code: String, val name: String, val unit: String,
    val status: String, val suggestedQuantity: Double, val reasons: List<String>) {
    /** Never round, clamp or coerce an unsafe recommendation into an order. */
    val wholeQuantity: Int? get() = suggestedQuantity.takeIf {
        it.isFinite() && it in 0.0..1_000_000.0 && it == Math.floor(it)
    }?.toInt()
    val quantityText: String get() = wholeQuantity?.toString() ?: suggestedQuantity.toString()
    val canUse: Boolean get() = status == "suggest" && wholeQuantity != null
}

data class SuggestedOrder(val version: String, val asOfDate: String, val outletId: String, val coverDays: Int,
    val nextVisitDays: Int, val leadTimeDays: Int, val leadTimeProvisional: Boolean, val lines: List<SuggestedLine>,
    /** ANA-009 history scope: complete, partial_scope, shared_account or no_customer (unknown kept raw). */
    val historyStatus: String? = null)

class SuggestedOrderWireFailure : Exception()

object SuggestedOrderCodec {
    const val PATH = "analytics/suggested_orders:forOutlet"
    const val MAX_LINES = 200
    const val MAX_REASONS = 10
    const val MAX_REASON_LENGTH = 300

    /** Only today's store and date; the engine's selling location and lead time stay server defaults. */
    fun args(outletId: String, asOfDate: String): JSONObject =
        JSONObject().put("outletId", outletId).put("asOfDate", asOfDate)

    private fun JSONObject.text(key: String): String =
        (opt(key) as? String) ?: throw SuggestedOrderWireFailure()
    private fun JSONObject.whole(key: String): Int {
        val value = opt(key) as? Number ?: throw SuggestedOrderWireFailure()
        val d = value.toDouble()
        if (!d.isFinite() || d != Math.floor(d) || d < 0 || d > 10_000) throw SuggestedOrderWireFailure()
        return d.toInt()
    }

    /** Decode and check it answers the request asked; unknown keys and statuses are tolerated. */
    fun decode(text: String, outletId: String, asOfDate: String): SuggestedOrder = try {
        val o = JSONObject(text)
        val lines = o.getJSONArray("lines")
        if (lines.length() > MAX_LINES) throw SuggestedOrderWireFailure()
        val order = SuggestedOrder(o.text("version"), o.text("asOfDate"),
            o.getJSONObject("outlet").text("outletId"), o.whole("coverDays"),
            o.getJSONObject("nextVisit").whole("days"), o.whole("leadTimeDays"),
            o.opt("leadTimeProvisional") as? Boolean ?: throw SuggestedOrderWireFailure(),
            (0 until lines.length()).map { i ->
                val l = lines.getJSONObject(i)
                val productId = l.opt("productId").let { if (it == null || it == JSONObject.NULL) null else it as? String
                    ?: throw SuggestedOrderWireFailure() }
                val quantity = (l.opt("suggestedQuantity") as? Number)?.toDouble() ?: throw SuggestedOrderWireFailure()
                val reasons = l.getJSONArray("reasons")
                SuggestedLine(productId, l.text("code"), l.text("name"), l.text("unit"), l.text("status"), quantity,
                    (0 until minOf(reasons.length(), MAX_REASONS)).map { reasons.getString(it).take(MAX_REASON_LENGTH) })
            }, (o.opt("historyStatus") as? String)?.take(40))
        if (order.outletId != outletId || order.asOfDate != asOfDate) throw SuggestedOrderWireFailure()
        order
    } catch (_: JSONException) { throw SuggestedOrderWireFailure() }
      catch (_: ClassCastException) { throw SuggestedOrderWireFailure() }
}

/** Pure helpers over the call sheet's text drafts. They edit Order fields only, never other measures. */
object SuggestedOrderRules {
    const val NOTE = "Suggestions only. Nothing is ordered until you save the call sheet."

    fun suggestion(order: SuggestedOrder, productId: String): SuggestedLine? =
        order.lines.firstOrNull { it.productId == productId }

    /** Explicit per-product accept: overwrite that product's Order with the suggested whole number. */
    fun use(order: SuggestedOrder, drafts: List<CallSheetDraftLine>, productId: String): List<CallSheetDraftLine> {
        val line = suggestion(order, productId)?.takeIf { it.canUse } ?: return drafts
        return drafts.map { if (it.productId == productId) it.copy(order = line.wholeQuantity.toString()) else it }
    }

    private fun applicable(order: SuggestedOrder, productId: String) =
        suggestion(order, productId)?.takeIf { it.canUse && (it.wholeQuantity ?: 0) > 0 }

    fun hasApplicable(order: SuggestedOrder, sheet: CallSheet): Boolean =
        sheet.outletId == order.outletId && sheet.lines.any { applicable(order, it.productId) != null }

    /** "Use all": fill only EMPTY Order fields of call-sheet products with a positive suggestion. */
    fun useAll(order: SuggestedOrder, sheet: CallSheet, drafts: List<CallSheetDraftLine>): List<CallSheetDraftLine> {
        if (sheet.outletId != order.outletId) return drafts
        val onSheet = sheet.lines.map { it.productId }.toSet()
        return drafts.map { draft ->
            val line = applicable(order, draft.productId)
            if (draft.productId in onSheet && line != null && draft.order.isBlank())
                draft.copy(order = line.wholeQuantity.toString()) else draft
        }
    }

    /** Suggested SKUs the salesperson cannot enter here: shown read-only. */
    fun notOnSheet(order: SuggestedOrder, sheet: CallSheet): List<SuggestedLine> {
        if (sheet.outletId != order.outletId) return emptyList()
        val ids = sheet.lines.map { it.productId }.toSet()
        return order.lines.filter { it.status == "suggest" && (it.productId == null || it.productId !in ids) }
    }

    fun statusText(line: SuggestedLine): String = when (line.status) {
        "suggest" -> "Suggested: ${line.quantityText} ${line.unit}"
        "enough_stock" -> "Enough stock — no order suggested"
        "unavailable" -> "Not available to sell"
        "no_history" -> "No purchases in 12 weeks — no suggestion"
        else -> "No suggestion"
    }

    fun summary(order: SuggestedOrder): String {
        val count = order.lines.count { it.canUse && (it.wholeQuantity ?: 0) > 0 }
        val text = "$count product(s) suggested · covers ${order.coverDays} days " +
            "(${order.nextVisitDays} to next visit + ${order.leadTimeDays} lead time)"
        val withLead = if (order.leadTimeProvisional) "$text\nLead time is provisional." else text
        return historyNote(order.historyStatus)?.let { "$withLead\n$it" } ?: withLead
    }

    /** Why the engine used less history than usual (it never invents the missing part). */
    fun historyNote(status: String?): String? = when (status) {
        "partial_scope" -> "Some of this account's orders are outside your area and were not counted."
        "shared_account" -> "This account is shared with another store, so its order history is not used."
        "no_customer" -> "No customer account is linked to this store, so there is no order history."
        else -> null
    }
}

/** What the Suggested order card shows. [order] is null whenever nothing may be shown. */
data class SuggestedOrderView(val order: SuggestedOrder? = null, val message: String? = null,
    val loading: Boolean = false)

interface SuggestedOrderCache {
    fun read(key: String): Pair<String, Long>?
    fun write(key: String, json: String, savedAt: Long)
}

object SuggestedOrderRepository {
    const val LOADING = "Loading suggestions…"
    const val CONNECTION = "Suggestions need a connection. Enter your order as usual."
    const val NOT_ALLOWED = "Suggestions aren't available for your account."
    const val UNREADABLE = "Couldn't read suggestions. Enter your order as usual."
    const val SIGN_IN = "Sign in again to see suggestions."

    fun key(asOfDate: String, outletId: String) = "$asOfDate|$outletId"

    /**
     * Fetch live and save for today; offline, show today's saved suggestions for the same store. A server
     * refusal or unreadable answer never falls back to saved data (access or the store may have changed).
     */
    fun load(outletId: String, asOfDate: String, cache: SuggestedOrderCache, now: Long,
             fetch: () -> String): SuggestedOrderView {
        val key = key(asOfDate, outletId)
        return try {
            val text = fetch()
            val order = SuggestedOrderCodec.decode(text, outletId, asOfDate)
            runCatching { cache.write(key, text, now) }
            SuggestedOrderView(order)
        } catch (_: ConvexFunctionError) {
            SuggestedOrderView(message = NOT_ALLOWED)
        } catch (e: AuthFailure) {
            if (e.kind == AuthFailure.Kind.SESSION_EXPIRED) SuggestedOrderView(message = SIGN_IN)
            else saved(cache, key, outletId, asOfDate)
        } catch (_: SuggestedOrderWireFailure) {
            SuggestedOrderView(message = UNREADABLE)
        }
    }

    private fun saved(cache: SuggestedOrderCache, key: String, outletId: String, asOfDate: String): SuggestedOrderView {
        val hit = runCatching { cache.read(key) }.getOrNull()
        val order = hit?.let { runCatching { SuggestedOrderCodec.decode(it.first, outletId, asOfDate) }.getOrNull() }
            ?: return SuggestedOrderView(message = CONNECTION)
        return SuggestedOrderView(order, "Offline — showing suggestions loaded at ${clock(hit.second)}")
    }

    private val MANILA = ZoneId.of("Asia/Manila")
    fun clock(at: Long): String = DateTimeFormatter.ofPattern("h:mm a", Locale.ENGLISH)
        .format(Instant.ofEpochMilli(at).atZone(MANILA))
}
