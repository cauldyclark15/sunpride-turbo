package com.sunpride.field.ui.today

import com.sunpride.field.auth.AuthFailure
import com.sunpride.field.auth.ConvexFunctionError
import com.sunpride.field.storage.ProductiveCall
import org.json.JSONObject
import java.text.NumberFormat
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Today's sales against target, read from the server's daily sales report (`dsr/report:day`, the Annex B
 * sheet a seller may read for themselves). Amounts are PHP centavos. [productiveCallRule] is the seller's
 * governed rule (null when an older server omits it); the phone uses it for calls not yet on the server.
 */
data class DaySales(
    val serviceDate: String, val dailyTarget: Long?, val todaySales: Long, val todayPct: Int?,
    val monthlyTarget: Long?, val mtdSales: Long, val productiveCallRule: String?)

/** What the Sales card shows: figures (live or saved), or a fixed explanation. Never invented zeros. */
data class DaySalesView(val sales: DaySales? = null, val savedAt: Long? = null, val message: String? = null)

class DaySalesWireFailure : Exception("Invalid daily sales report")

object DaySalesCodec {
    const val PATH = "dsr/report:day"

    fun args(profileId: String, serviceDate: String): JSONObject =
        JSONObject().put("profileId", profileId).put("serviceDate", serviceDate)

    fun decode(text: String): DaySales = try {
        val o = JSONObject(text)
        val targets = o.getJSONObject("targets"); val totals = o.getJSONObject("totals")
        val calls = o.optJSONObject("calls")
        DaySales(o.getString("serviceDate").also { require(it.isNotBlank()) },
            targets.money("daily"), totals.money("todaySales") ?: throw DaySalesWireFailure(),
            totals.wholeOrNull("todayPct")?.toInt(), targets.money("monthly"),
            totals.money("mtdSales") ?: throw DaySalesWireFailure(),
            calls?.optString("productiveCallRule")
                ?.takeIf { it == ProductiveCall.ANY_LISTED_ACTIVITY || it == ProductiveCall.TRUCK_SELLER })
    } catch (e: DaySalesWireFailure) { throw e } catch (_: Exception) { throw DaySalesWireFailure() }

    private fun JSONObject.wholeOrNull(k: String): Long? = when (val v = opt(k)) {
        null, JSONObject.NULL -> null
        is Number -> v.toDouble().takeIf { it.isFinite() && it == Math.floor(it) && Math.abs(it) < 9e15 }?.toLong()
            ?: throw DaySalesWireFailure()
        else -> throw DaySalesWireFailure()
    }
    private fun JSONObject.money(k: String): Long? = wholeOrNull(k)?.also { if (it < 0) throw DaySalesWireFailure() }
}

/** Where the last good report is kept (encrypted store, per signed-in partition). */
interface DaySalesCache {
    fun read(key: String): Pair<String, Long>?
    fun write(key: String, json: String, savedAt: Long)
}

object DaySalesRepository {
    /**
     * With [fetch], read live and save; otherwise (or when the server can't be reached) show today's saved
     * report. A server refusal never shows saved figures (access may have been withdrawn).
     */
    fun load(serviceDate: String, cache: DaySalesCache, now: Long, fetch: (() -> String)?): DaySalesView {
        if (fetch == null) return saved(cache, serviceDate, null)
        return try {
            val text = fetch()
            val sales = DaySalesCodec.decode(text)
            if (sales.serviceDate != serviceDate) throw DaySalesWireFailure()
            runCatching { cache.write(serviceDate, text, now) }
            DaySalesView(sales)
        } catch (_: ConvexFunctionError) {
            DaySalesView(message = "Not available for your account")
        } catch (e: AuthFailure) {
            if (e.kind == AuthFailure.Kind.SESSION_EXPIRED) DaySalesView(message = "Sign in again to see sales")
            else saved(cache, serviceDate, "Offline")
        } catch (_: DaySalesWireFailure) {
            saved(cache, serviceDate, "Couldn't read the latest sales")
        } catch (_: java.io.IOException) {
            saved(cache, serviceDate, "Offline")
        }
    }

    private fun saved(cache: DaySalesCache, serviceDate: String, reason: String?): DaySalesView {
        val hit = runCatching { cache.read(serviceDate) }.getOrNull()
        val sales = hit?.let { runCatching { DaySalesCodec.decode(it.first) }.getOrNull() }
            ?.takeIf { it.serviceDate == serviceDate }
            ?: return DaySalesView(message = reason?.let { "$it · sync to see sales" } ?: "Sync to see sales")
        return DaySalesView(sales, savedAt = hit.second)
    }
}

object DaySalesText {
    private val MANILA = ZoneId.of("Asia/Manila")
    fun peso(centavos: Long): String = "₱" + NumberFormat.getNumberInstance(Locale.ENGLISH)
        .apply { minimumFractionDigits = 2; maximumFractionDigits = 2 }.format(centavos / 100.0)
    fun target(s: DaySales) = s.dailyTarget?.let { peso(it) } ?: "No target set"
    fun sold(s: DaySales) = peso(s.todaySales) + (s.todayPct?.let { " · $it%" } ?: "")
    fun month(s: DaySales) = peso(s.mtdSales) + (s.monthlyTarget?.let { " of ${peso(it)}" } ?: "")
    fun savedNote(at: Long) = "Saved at " + DateTimeFormatter.ofPattern("h:mm a", Locale.ENGLISH)
        .format(Instant.ofEpochMilli(at).atZone(MANILA))
}
