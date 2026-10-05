package com.sunpride.field.ui.diagnosticvisit

import com.sunpride.field.auth.AuthFailure
import com.sunpride.field.auth.ConvexFunctionError
import com.sunpride.field.storage.CallSheet
import kotlinx.coroutines.runBlocking
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

/** A saved answer, or a durable refusal marker ([blocked] = why) that replaced it. */
data class SuggestedOrderCacheRow(val json: String?, val savedAt: Long, val blocked: String? = null)

interface SuggestedOrderCache {
    fun read(key: String): SuggestedOrderCacheRow?
    fun write(key: String, json: String, savedAt: Long)
    /** Drop the saved answer for [key] and remember the refusal on the phone, surviving relaunch. */
    fun block(key: String, reason: String, at: Long)
}

/**
 * The phone's durable cache: today's answers in the scoped partition's `local.suggestedOrder` rows. A refusal
 * is a tombstone row carrying its reason, so it survives offline reopen and app relaunch.
 */
class StoreSuggestedOrderCache(private val store: com.sunpride.field.storage.FieldStore,
                               private val asOfDate: String) : SuggestedOrderCache {
    override fun read(key: String) = runBlocking { store.localCache(ENTITY, key) }?.let { row ->
        if (row.tombstone) SuggestedOrderCacheRow(null, row.revision,
            row.json ?: SuggestedOrderRepository.BLOCKED_NOT_ALLOWED)
        else SuggestedOrderCacheRow(row.json, row.revision)
    }
    override fun write(key: String, json: String, savedAt: Long) = runBlocking {
        store.putLocalCache(ENTITY, key, json, savedAt, "$asOfDate|")
    }
    override fun block(key: String, reason: String, at: Long) = runBlocking {
        store.blockLocalCache(ENTITY, key, reason, at)
    }
    companion object { const val ENTITY = "local.suggestedOrder" }
}

object SuggestedOrderRepository {
    const val LOADING = "Loading suggestions…"
    const val CONNECTION = "Suggestions need a connection. Enter your order as usual."
    const val NOT_ALLOWED = "Suggestions aren't available for your account."
    const val UNREADABLE = "Couldn't read suggestions. Enter your order as usual."
    const val SIGN_IN = "Sign in again to see suggestions."

    fun key(asOfDate: String, outletId: String) = "$asOfDate|$outletId"

    const val BLOCKED_NOT_ALLOWED = "not_allowed"
    const val BLOCKED_SIGN_IN = "sign_in"
    const val BLOCKED_UNREADABLE = "unreadable"

    /**
     * In-session deny latch (key -> refusal reason). Set BEFORE the durable write, so a refusal blocks saved
     * suggestions for the rest of this process even when the phone storage can still be read but the refusal
     * marker could not be written. Only a fresh live answer for the same store and day clears it.
     */
    private val sessionDenials = java.util.concurrent.ConcurrentHashMap<String, String>()

    /**
     * Request generations: every load takes a fresh, never-reused ticket and records it as the newest request
     * for its store and day. A success may renew access (clear the latch, overwrite the saved answer) only if
     * no newer request for that key started meanwhile — so an old in-flight success can never undo a newer
     * refusal, in memory or on the phone. Refusals always apply (fail closed). Guarded by [lock] so the
     * check and the latch/cache writes are one step.
     */
    private val nextTicket = java.util.concurrent.atomic.AtomicLong(0)
    private val newestRequest = HashMap<String, Long>()
    private val lock = Any()

    /**
     * Authorization lifetime. Bumped whenever the verified account/device/scope, the session or the phone's
     * enrollment changes (scope change, partition hold, removal, sign-out). A request remembers the epoch it
     * started in; its success may renew access, be saved or be shown only while that epoch is still current.
     * Equal store/day/partition values afterwards (A → B → A) do not make an old answer current again.
     */
    private var epoch = 0L
    fun epoch(): Long = synchronized(lock) { epoch }

    /**
     * The authorization lifetime ended (scope change, hold, removal, account renewal). Orphans every in-flight
     * request so none of their answers can be saved, renew access or be shown. Refusals stay latched.
     */
    fun retire(): Unit = synchronized(lock) {
        epoch++
        newestRequest.clear()
    }

    /** The call sheet closed: an answer still in flight is neither shown nor saved. */
    fun abandon(): Unit = synchronized(lock) { newestRequest.clear() }

    /**
     * Sign-out (the phone's data is purged) or a test simulating a new process. Also ends the authorization
     * lifetime, so no in-flight answer can be saved or shown afterwards.
     */
    fun forgetSessionDenials(): Unit = synchronized(lock) {
        sessionDenials.clear()
        newestRequest.clear()
        epoch++
    }

    /**
     * Fetch live and save for today; offline, show today's saved suggestions for the same store. A server
     * refusal, ended session or unreadable answer durably replaces the saved answer with a refusal marker,
     * so a later offline open or app relaunch never restores it; only a fresh live answer clears the marker.
     * The in-session latch keeps the refusal even when that marker cannot be written. An answer that was
     * overtaken by a newer request for the same store and day is discarded, never saved.
     */
    fun load(outletId: String, asOfDate: String, cache: SuggestedOrderCache, now: Long,
             fetch: () -> String): SuggestedOrderView {
        val key = key(asOfDate, outletId)
        val ticket = nextTicket.incrementAndGet()
        val started = synchronized(lock) { newestRequest[key] = ticket; epoch }
        return try {
            val text = fetch()
            val order = SuggestedOrderCodec.decode(text, outletId, asOfDate)
            var sameLifetime = true
            val current = synchronized(lock) {
                sameLifetime = epoch == started
                (sameLifetime && newestRequest[key] == ticket).also { newest ->
                    if (newest) {
                        sessionDenials.remove(key)
                        runCatching { cache.write(key, text, now) }
                    }
                }
            }
            when {
                current -> SuggestedOrderView(order)
                // The authorization it was asked under has ended: nothing from it (or its old partition) shows.
                !sameLifetime -> SuggestedOrderView(message = CONNECTION)
                // Overtaken: show only what an offline open would (a newer refusal stays a refusal).
                else -> saved(cache, key, outletId, asOfDate, now)
            }
        } catch (_: ConvexFunctionError) {
            refuse(cache, key, BLOCKED_NOT_ALLOWED, now)
        } catch (e: AuthFailure) {
            when (e.kind) {
                AuthFailure.Kind.SESSION_EXPIRED, AuthFailure.Kind.INVALID_CREDENTIALS ->
                    refuse(cache, key, BLOCKED_SIGN_IN, now)
                AuthFailure.Kind.REFUSED -> refuse(cache, key, BLOCKED_NOT_ALLOWED, now)
                else -> if (epoch() != started) SuggestedOrderView(message = CONNECTION)
                    else saved(cache, key, outletId, asOfDate, now)
            }
        } catch (_: SuggestedOrderWireFailure) {
            refuse(cache, key, BLOCKED_UNREADABLE, now)
        }
    }

    private fun refuse(cache: SuggestedOrderCache, key: String, reason: String, now: Long): SuggestedOrderView {
        synchronized(lock) {
            sessionDenials[key] = reason
            runCatching { cache.block(key, reason, now) }
        }
        return SuggestedOrderView(message = blockedMessage(reason))
    }

    private fun blockedMessage(reason: String) = when (reason) {
        BLOCKED_SIGN_IN -> SIGN_IN
        BLOCKED_UNREADABLE -> UNREADABLE
        else -> NOT_ALLOWED
    }

    private fun saved(cache: SuggestedOrderCache, key: String, outletId: String, asOfDate: String,
                      now: Long): SuggestedOrderView {
        // Refused earlier in this session: never read the saved answer; retry the durable marker so a later
        // relaunch stays refused too if storage has recovered.
        sessionDenials[key]?.let { reason ->
            runCatching { cache.block(key, reason, now) }
            return SuggestedOrderView(message = blockedMessage(reason))
        }
        val hit = runCatching { cache.read(key) }.getOrNull() ?: return SuggestedOrderView(message = CONNECTION)
        // A refusal stays a refusal offline, even after relaunch.
        hit.blocked?.let { return SuggestedOrderView(message = blockedMessage(it)) }
        val order = hit.json?.let { runCatching { SuggestedOrderCodec.decode(it, outletId, asOfDate) }.getOrNull() }
            ?: return SuggestedOrderView(message = CONNECTION)
        return SuggestedOrderView(order, "Offline — showing suggestions loaded at ${clock(hit.savedAt)}")
    }

    private val MANILA = ZoneId.of("Asia/Manila")
    fun clock(at: Long): String = DateTimeFormatter.ofPattern("h:mm a", Locale.ENGLISH)
        .format(Instant.ofEpochMilli(at).atZone(MANILA))
}
