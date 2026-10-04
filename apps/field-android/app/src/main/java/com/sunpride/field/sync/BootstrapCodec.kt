package com.sunpride.field.sync

import com.sunpride.field.storage.ScopedSnapshot
import com.sunpride.field.storage.SnapshotItem
import com.sunpride.field.storage.CallSheet
import com.sunpride.field.storage.CallSheetCodec
import com.sunpride.field.storage.CatalogProduct
import com.sunpride.field.storage.InventoryAvailability
import com.sunpride.field.storage.ReferenceDataCodec
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate

/** Strict required v1 shapes; unknown response enums remain raw and never authorize a transition. */
class WireFailure(message: String) : Exception(message)
data class MobileError(val code: String, val retryable: Boolean, val raw: JSONObject)
sealed interface ResponseStatus {
    val raw: String
    data class Known(override val raw: String) : ResponseStatus
    data class Unknown(override val raw: String) : ResponseStatus
}
fun responseStatus(raw: String): ResponseStatus = if (raw in setOf("accepted", "rejected", "conflict"))
    ResponseStatus.Known(raw) else ResponseStatus.Unknown(raw)
data class BootstrapPage(
    val page: Int, val serverTime: Long, val employee: JSONObject, val fingerprint: String,
    val visits: List<SnapshotItem>, val outlets: List<SnapshotItem>, val customers: List<SnapshotItem>,
    val tasks: List<SnapshotItem>, val route: String?, val next: String?, val cursor: String?,
    val lease: Long, val cache: Long, val supported: Boolean, val raw: JSONObject,
    val callSheets: List<CallSheet> = emptyList(),
    val activityRules: List<com.sunpride.field.storage.ActivityRule>? = null,
    /** AND-016 `photoTypes`; null when an older server omits the field. */
    val photoTypes: List<com.sunpride.field.storage.PhotoType>? = null,
    val productCatalog: List<CatalogProduct> = emptyList(),
    val inventoryAvailability: List<InventoryAvailability> = emptyList()
)

object BootstrapCodec {
    private fun JSONObject.field(name: String): Any = if (!has(name)) throw WireFailure("Missing $name") else get(name)
    private fun JSONObject.obj(name: String): JSONObject = field(name) as? JSONObject ?: throw WireFailure("Invalid $name")
    private fun JSONObject.arr(name: String): JSONArray = field(name) as? JSONArray ?: throw WireFailure("Invalid $name")
    private fun JSONObject.str(name: String): String = (field(name) as? String)?.takeIf { it.isNotBlank() }
        ?: throw WireFailure("Invalid $name")
    private fun JSONObject.num(name: String): Long {
        val n = field(name)
        if (n !is Number || n.toString().contains('.') || n.toString().contains('e', true)) throw WireFailure("Invalid $name")
        return n.toLong()
    }
    private fun JSONObject.bool(name: String): Boolean = field(name) as? Boolean ?: throw WireFailure("Invalid $name")
    private fun JSONObject.nullable(name: String): String? = when (val v = field(name)) {
        JSONObject.NULL -> null
        is String -> v.takeIf { it.isNotBlank() } ?: throw WireFailure("Invalid $name")
        else -> throw WireFailure("Invalid $name")
    }
    private fun version(o: JSONObject, type: String) {
        if (o.str("type") != type || o.num("contractVersion") != 1L) throw WireFailure("Unsupported contract")
    }
    fun request(deviceId: String, day: String, pageCursor: String? = null): ByteArray {
        require(deviceId.isNotBlank()); LocalDate.parse(day)
        val o = JSONObject().put("type", "bootstrap.request").put("contractVersion", 1)
            .put("deviceId", deviceId).put("dayFrom", day).put("limit", 100)
        if (pageCursor != null) o.put("pageCursor", pageCursor) else o.put("referenceData", true)
        return o.toString().toByteArray(Charsets.UTF_8)
    }
    fun error(text: String): MobileError = guard {
        val o = JSONObject(text); version(o, "error.response"); o.num("serverTime")
        // Runtime HTTP gateway currently emits flat fields; frozen schema fixtures use nested `error`.
        val e = if (o.has("error")) o.obj("error") else o
        e.str("message"); MobileError(e.str("code"), e.bool("retryable"), o)
    }
    private fun strings(a: JSONArray) {
        for (i in 0 until a.length()) if (a.opt(i) !is String) throw WireFailure("Invalid array item")
    }
    private fun items(o: JSONObject, key: String, fields: (JSONObject) -> Unit, day: Boolean = false): List<SnapshotItem> {
        val a = o.arr(key)
        return (0 until a.length()).map { i ->
            val row = a.optJSONObject(i) ?: throw WireFailure("Invalid $key item")
            fields(row)
            SnapshotItem(row.str("id"), row.toString(), if (day) row.str("serviceDate") else null)
        }
    }
    /** Optional daily-route outlet fields (added 2026-10): code, customer link, address and a verified pin. */
    private fun routeFields(v: JSONObject) {
        if (v.has("code") && v.get("code") !is String) throw WireFailure("Invalid code")
        if (v.has("customerId")) v.str("customerId")
        if (v.has("address")) v.str("address")
        if (v.has("latitude") != v.has("longitude")) throw WireFailure("Invalid pin")
        if (v.has("latitude")) {
            val lat = (v.get("latitude") as? Number)?.toDouble() ?: throw WireFailure("Invalid pin")
            val lng = (v.get("longitude") as? Number)?.toDouble() ?: throw WireFailure("Invalid pin")
            if (!lat.isFinite() || !lng.isFinite() || lat !in -90.0..90.0 || lng !in -180.0..180.0)
                throw WireFailure("Invalid pin")
        }
    }
    fun page(text: String): BootstrapPage = guard {
        val o = JSONObject(text); version(o, "bootstrap.response")
        val employee = o.obj("employee"); employee.str("id"); val role = employee.str("role"); employee.str("orgUnitId")
        val scope = o.obj("scope"); val fingerprint = scope.str("fingerprint"); strings(scope.arr("orgUnitIds"))
        val config = o.obj("appConfig"); val lease = config.num("offlineLeaseExpiresAt"); val cache = config.num("cacheExpiresAt")
        config.bool("orderCaptureEnabled")
        val supported = role in setOf("sales", "manager", "super_admin", "admin", "operations", "approver", "analyst", "viewer") &&
            config.str("priceAvailability") == "unavailable" &&
            config.str("promotionsAvailability") == "unavailable" && !config.bool("orderCaptureEnabled")
        val route = when (val r = o.field("route")) {
            JSONObject.NULL -> null
            is JSONObject -> { r.str("id"); r.str("code"); r.toString() }
            else -> throw WireFailure("Invalid route")
        }
        val visits = items(o, "plannedVisits", { v ->
            v.str("outletId"); LocalDate.parse(v.str("serviceDate")); v.str("planId"); v.num("planVersion"); strings(v.arr("intents"))
            if (v.has("sequence")) {
                val sequence = v.num("sequence")
                if (sequence !in 0..Int.MAX_VALUE.toLong()) throw WireFailure("Invalid sequence")
            }
        }, true)
        val outlets = items(o, "outlets", { v -> v.str("name"); v.nullable("routeId"); routeFields(v) })
        val callSheets = if (!o.has("callSheets")) emptyList() else o.arr("callSheets").let { a ->
            (0 until a.length()).map { CallSheetCodec.decode(a.getJSONObject(it)) }
        }
        val visitOutlets = visits.map { JSONObject(it.json).getString("outletId") }.toSet()
        require(callSheets.all { it.outletId in visitOutlets })
        require(callSheets.map { it.outletId }.distinct().size == callSheets.size)
        // AND-013 additive field: strict when present; an older server simply omits it.
        val activityRules = if (!o.has("activityRules")) null else o.arr("activityRules").let { a ->
            if (a.length() > 32) throw WireFailure("Invalid activityRules")
            (0 until a.length()).map { i ->
                val row = a.optJSONObject(i) ?: throw WireFailure("Invalid activityRules item")
                try { com.sunpride.field.storage.ActivityRules.decode(row) }
                catch (_: Exception) { throw WireFailure("Invalid activityRules item") }
            }.also { rules -> if (rules.map { it.intent }.distinct().size != rules.size) throw WireFailure("Duplicate activity rule") }
        }
        // AND-016 additive field: strict when present; an older server simply omits it.
        val photoTypes = if (!o.has("photoTypes")) null else o.arr("photoTypes").let { a ->
            if (a.length() > 32) throw WireFailure("Invalid photoTypes")
            (0 until a.length()).map { i ->
                val row = a.optJSONObject(i) ?: throw WireFailure("Invalid photoTypes item")
                try { com.sunpride.field.storage.EvidencePhotos.decode(row) }
                catch (_: Exception) { throw WireFailure("Invalid photoTypes item") }
            }.also { types -> if (types.map { it.code }.distinct().size != types.size) throw WireFailure("Duplicate photo type") }
        }
        val customers = items(o, "localCustomers", { it.str("code") })
        val tasks = items(o, "tasks", { it.str("kind"); it.bool("required") })
        val catalog = o.arr("productCatalog").let { a ->
            (0 until a.length()).map { ReferenceDataCodec.product(a.getJSONObject(it)) }
        }
        val availability = if (!o.has("inventoryAvailability")) emptyList() else o.arr("inventoryAvailability").let { a ->
            (0 until a.length()).map { ReferenceDataCodec.availability(a.getJSONObject(it)) }
        }
        val permissions = o.arr("permissions")
        for (i in 0 until permissions.length()) if (permissions.opt(i) !is String) throw WireFailure("Invalid permissions")
        val next = o.nullable("nextPageCursor"); val cursor = o.nullable("syncCursor")
        if ((next == null) == (cursor == null)) throw WireFailure("Invalid pagination")
        BootstrapPage(o.num("page").toInt(), o.num("serverTime"), employee, fingerprint,
            visits, outlets, customers, tasks, route, next, cursor, lease, cache, supported, o, callSheets,
            activityRules, photoTypes, catalog, availability)
    }
    /** Re-encode a validated v1 envelope without normalizing unknown optional response properties. */
    fun encode(page: BootstrapPage): ByteArray = page.raw.toString().toByteArray(Charsets.UTF_8)
    fun encode(error: MobileError): ByteArray = error.raw.toString().toByteArray(Charsets.UTF_8)
    fun snapshot(pages: List<BootstrapPage>): ScopedSnapshot {
        require(pages.isNotEmpty())
        val first = pages.first()
        require(pages.last().cursor != null && pages.dropLast(1).all { it.cursor == null })
        require(pages.all { it.fingerprint == first.fingerprint && it.employee.toString() == first.employee.toString() && it.supported })
        fun unique(items: List<SnapshotItem>) = items.distinctBy { it.id }.also { distinct ->
            require(distinct.size == items.size || items.groupBy { it.id }.values.all { group -> group.map { it.json }.distinct().size == 1 })
        }
        fun <T> referenceUnique(rows: List<T>, id: (T) -> String): List<T> {
            require(rows.groupBy(id).values.all { it.distinct().size == 1 })
            return rows.distinctBy(id)
        }
        val catalog = referenceUnique(pages.flatMap { it.productCatalog }) { it.id }
        val availability = referenceUnique(pages.flatMap { it.inventoryAvailability }) { it.id }
        val sheets = pages.flatMap { it.callSheets }
        // Every page of one download carries the same rule set (the server's signed manifest).
        val ruleSets = pages.mapNotNull { it.activityRules }.distinct()
        require(ruleSets.size <= 1)
        val typeSets = pages.mapNotNull { it.photoTypes }.distinct()
        require(typeSets.size <= 1)
        require(sheets.groupBy { it.outletId }.values.all { it.distinct().size == 1 })
        return ScopedSnapshot(first.employee.toString(), pages.firstNotNullOfOrNull { it.route },
            unique(pages.flatMap { it.visits }), unique(pages.flatMap { it.outlets }),
            unique(pages.flatMap { it.customers }), unique(pages.flatMap { it.tasks }), sheets.distinctBy { it.outletId },
            ruleSets.singleOrNull() ?: emptyList(), typeSets.singleOrNull() ?: emptyList(),
            catalog, availability)
    }
    private inline fun <T> guard(block: () -> T): T = try { block() }
        catch (e: WireFailure) { throw e }
        catch (_: Exception) { throw WireFailure("Malformed v1 response") }
}
