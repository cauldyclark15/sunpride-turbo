package com.sunpride.field.orders

import com.sunpride.field.storage.CallSheet
import com.sunpride.field.storage.FieldStore
import com.sunpride.field.ui.customers.CustomerDirectory
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * Offline field order capture (SP-0061, AND-014).
 *
 * Authorized catalog: the account's server-owned Annex C product setup that arrived in the scoped
 * bootstrap (call sheet lines). The nationwide product master is never offered on the phone.
 *
 * Price rules: v1 bootstrap sends `priceAvailability: "unavailable"` (no governed price list yet,
 * ADR-008), so a draft carries quantities in the setup UOM only and never an amount or total.
 * The account's free-text pricing note is shown as a reference, never computed.
 *
 * Drafts are local only (encrypted Room); review and submission are a later step (SP-0060).
 */
data class CatalogItem(val productId: String, val code: String, val name: String, val uom: String,
    val barcode: String?, val priceNote: String?)

object OrderCatalog {
    fun of(sheet: CallSheet?): List<CatalogItem> = sheet?.lines.orEmpty().map {
        CatalogItem(it.productId, it.code, it.name, it.uom, it.barcode, it.pricing)
    }

    /** Every word must appear in code, name or barcode; exact code/barcode first, then setup order. */
    fun search(items: List<CatalogItem>, query: String): List<CatalogItem> {
        val words = CustomerDirectory.normalize(query).split(' ').filter { it.isNotEmpty() }
        if (words.isEmpty()) return items
        val phrase = words.joinToString(" ")
        return items.withIndex().mapNotNull { (index, item) ->
            val codes = listOfNotNull(item.code, item.barcode).map { CustomerDirectory.normalize(it) }
            val joined = (codes + CustomerDirectory.normalize(item.name)).joinToString(" ")
            if (words.any { !joined.contains(it) }) return@mapNotNull null
            val score = when {
                codes.any { it == phrase } -> 0
                codes.any { it.startsWith(phrase) } || CustomerDirectory.normalize(item.name).startsWith(phrase) -> 1
                else -> 2
            }
            Triple(item, score, index)
        }.sortedWith(compareBy({ it.second }, { it.third })).map { it.first }
    }
}

data class OrderDraftLine(val productId: String, val code: String, val name: String, val uom: String,
    val quantity: Int)

/** Association is derived from the stored check-in and cached snapshot, never typed by the user. */
data class OrderDraft(
    val draftId: String, val clientVisitId: String, val checkInRequestId: String,
    val plannedVisitId: String?, val outletId: String, val serviceDate: String,
    val customerId: String?, val customerCode: String?, val territoryId: String?, val territoryCode: String?,
    val routeId: String?, val catalogRevision: Long, val lines: List<OrderDraftLine>,
    val createdAt: Long, val updatedAt: Long,
    val priceAvailability: String = OrderDraftRules.PRICE_UNAVAILABLE)

object OrderDraftCodec {
    private fun JSONObject.nullable(key: String): String? = if (!has(key) || isNull(key)) null else getString(key)
    fun encode(d: OrderDraft): String = JSONObject().put("draftId", d.draftId).put("clientVisitId", d.clientVisitId)
        .put("checkInRequestId", d.checkInRequestId).put("plannedVisitId", d.plannedVisitId ?: JSONObject.NULL)
        .put("outletId", d.outletId).put("serviceDate", d.serviceDate)
        .put("customerId", d.customerId ?: JSONObject.NULL).put("customerCode", d.customerCode ?: JSONObject.NULL)
        .put("territoryId", d.territoryId ?: JSONObject.NULL).put("territoryCode", d.territoryCode ?: JSONObject.NULL)
        .put("routeId", d.routeId ?: JSONObject.NULL).put("catalogRevision", d.catalogRevision)
        .put("priceAvailability", d.priceAvailability)
        .put("lines", JSONArray().apply { d.lines.forEach { l ->
            put(JSONObject().put("productId", l.productId).put("code", l.code).put("name", l.name)
                .put("uom", l.uom).put("quantity", l.quantity))
        } })
        .put("createdAt", d.createdAt).put("updatedAt", d.updatedAt).toString()
    fun decode(text: String): OrderDraft {
        val o = JSONObject(text)
        val lines = o.getJSONArray("lines")
        return OrderDraft(o.getString("draftId"), o.getString("clientVisitId"), o.getString("checkInRequestId"),
            o.nullable("plannedVisitId"), o.getString("outletId"), o.getString("serviceDate"),
            o.nullable("customerId"), o.nullable("customerCode"), o.nullable("territoryId"), o.nullable("territoryCode"),
            o.nullable("routeId"), o.getLong("catalogRevision"),
            (0 until lines.length()).map { i -> lines.getJSONObject(i).let { l ->
                OrderDraftLine(l.getString("productId"), l.getString("code"), l.getString("name"),
                    l.getString("uom"), l.getInt("quantity"))
            } },
            o.getLong("createdAt"), o.getLong("updatedAt"), o.getString("priceAvailability"))
    }
}

class OrderDraftFailure(val code: Code) : IllegalStateException(code.name) {
    enum class Code(val text: String) {
        CALL_NOT_OPEN("Start the call before taking an order."),
        CALL_ENDED("This call has ended. The saved draft can no longer be changed."),
        NO_CATALOG("No products set up for this account yet. Ask your office."),
        CATALOG_CHANGED("The office changed this account's products. Check the lines and save again."),
        EMPTY("Add at least one product."),
        INVALID_QUANTITY("Use whole numbers from 1 to 99,999."),
        HELD("This phone's work is held for review. Sync and ask your administrator."),
        LEASE_EXPIRED("Your offline day has closed. Sync to keep taking orders."),
    }
}

object OrderDraftRules {
    const val PRICE_UNAVAILABLE = "unavailable"
    const val MAX_LINES = 100
    const val MAX_QUANTITY = 99_999

    /** Blank means "not ordered"; anything else must be a whole number 1..99,999 in the setup UOM. */
    fun quantity(text: String): Int? {
        val t = text.trim()
        if (t.isEmpty()) return null
        if (!t.all { it in '0'..'9' } || t.length > 5) throw OrderDraftFailure(OrderDraftFailure.Code.INVALID_QUANTITY)
        return t.toInt().takeIf { it in 1..MAX_QUANTITY } ?: throw OrderDraftFailure(OrderDraftFailure.Code.INVALID_QUANTITY)
    }

    private fun payload(json: String) = JSONObject(json).getJSONObject("payload")
    private fun JSONObject.text(key: String): String? =
        if (!has(key) || isNull(key)) null else (opt(key) as? String)?.takeIf { it.isNotBlank() }

    /** The open call this order belongs to: a non-rejected check-in with no End call yet. */
    private suspend fun openCheckIn(store: FieldStore, clientVisitId: String, checkInRequestId: String): JSONObject {
        val history = store.history()
        val checkIn = history.firstOrNull { it.first.requestId == checkInRequestId }
            ?: throw OrderDraftFailure(OrderDraftFailure.Code.CALL_NOT_OPEN)
        if (checkIn.first.kind != "visit.checkIn" || checkIn.first.clientVisitId != clientVisitId ||
            checkIn.second.state == "review") throw OrderDraftFailure(OrderDraftFailure.Code.CALL_NOT_OPEN)
        if (history.any { it.first.clientVisitId == clientVisitId && it.first.kind == "visit.checkOut" })
            throw OrderDraftFailure(OrderDraftFailure.Code.CALL_ENDED)
        return payload(checkIn.first.serializedOperation)
    }

    /**
     * Build a new draft (or the next version of [existing]) from the open call's check-in, the cached
     * outlet/customer rows and the account catalog. Quantities are productId → whole number.
     */
    suspend fun build(store: FieldStore, existing: OrderDraft?, clientVisitId: String, checkInRequestId: String,
        quantities: List<Pair<String, Int>>, now: Long, uuid: () -> String = { UUID.randomUUID().toString() }): OrderDraft {
        val checkIn = openCheckIn(store, clientVisitId, checkInRequestId)
        val outletId = checkIn.getString("outletId")
        val sheet = store.callSheet(outletId) ?: throw OrderDraftFailure(OrderDraftFailure.Code.NO_CATALOG)
        val catalog = OrderCatalog.of(sheet).associateBy { it.productId }
        val lines = quantities.map { (productId, quantity) ->
            val item = catalog[productId] ?: throw OrderDraftFailure(OrderDraftFailure.Code.CATALOG_CHANGED)
            OrderDraftLine(item.productId, item.code, item.name, item.uom, quantity)
        }
        val outlet = store.outlets().firstOrNull { it.id == outletId }?.let { JSONObject(it.json) }
        val customerId = outlet?.text("customerId")
        val customerCode = customerId?.let { id ->
            store.customers().firstOrNull { it.id == id }?.let { JSONObject(it.json).text("code") }
        }
        if (existing != null) require(existing.clientVisitId == clientVisitId && existing.checkInRequestId == checkInRequestId)
        val draft = OrderDraft(existing?.draftId ?: uuid().lowercase(), clientVisitId, checkInRequestId,
            checkIn.text("plannedVisitId"), outletId, checkIn.getString("serviceDate"), customerId, customerCode,
            outlet?.text("territoryId"), outlet?.text("territoryCode"), outlet?.text("routeId"), sheet.revision,
            lines, existing?.createdAt ?: now, now)
        validate(store, draft, existing)
        return draft
    }

    /** Re-checked inside the store transaction: a stale screen or forged draft never persists. */
    suspend fun validate(store: FieldStore, draft: OrderDraft, existing: OrderDraft?) {
        require(UUID.fromString(draft.draftId).toString() == draft.draftId)
        require(draft.priceAvailability == PRICE_UNAVAILABLE) // no governed price list in contract v1
        if (draft.lines.isEmpty()) throw OrderDraftFailure(OrderDraftFailure.Code.EMPTY)
        if (draft.lines.size > MAX_LINES || draft.lines.any { it.quantity !in 1..MAX_QUANTITY })
            throw OrderDraftFailure(OrderDraftFailure.Code.INVALID_QUANTITY)
        require(draft.lines.map { it.productId }.distinct().size == draft.lines.size) { "Duplicate product" }
        val checkIn = openCheckIn(store, draft.clientVisitId, draft.checkInRequestId)
        require(checkIn.getString("outletId") == draft.outletId && checkIn.getString("serviceDate") == draft.serviceDate &&
            checkIn.text("plannedVisitId") == draft.plannedVisitId) { "Draft does not match its call" }
        val sheet = store.callSheet(draft.outletId) ?: throw OrderDraftFailure(OrderDraftFailure.Code.NO_CATALOG)
        val catalog = OrderCatalog.of(sheet).associateBy { it.productId }
        if (sheet.revision != draft.catalogRevision || draft.lines.any { line ->
                catalog[line.productId]?.let { it.code == line.code && it.name == line.name && it.uom == line.uom } != true
            }) throw OrderDraftFailure(OrderDraftFailure.Code.CATALOG_CHANGED)
        val outlet = store.outlets().firstOrNull { it.id == draft.outletId }?.let { JSONObject(it.json) }
        require(outlet?.text("customerId") == draft.customerId && outlet?.text("territoryId") == draft.territoryId &&
            outlet?.text("territoryCode") == draft.territoryCode && outlet?.text("routeId") == draft.routeId) {
            "Draft association does not match the cached outlet"
        }
        if (existing != null) require(existing.draftId == draft.draftId && existing.clientVisitId == draft.clientVisitId &&
            existing.checkInRequestId == draft.checkInRequestId && existing.outletId == draft.outletId &&
            existing.createdAt == draft.createdAt && draft.updatedAt >= existing.updatedAt) { "Draft identity is immutable" }
    }

    /** Lines whose product left the account setup or changed UOM/code since the draft was saved. */
    fun staleLines(draft: OrderDraft, sheet: CallSheet?): List<OrderDraftLine> {
        val catalog = OrderCatalog.of(sheet).associateBy { it.productId }
        return draft.lines.filter { line ->
            catalog[line.productId]?.let { it.code == line.code && it.name == line.name && it.uom == line.uom } != true
        }
    }
}
