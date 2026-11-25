package com.sunpride.field.census

import com.sunpride.field.storage.*
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** A durable local identity is the original encrypted capture request, never a made-up server UUID.
 * Keep this identity after acknowledgement so already-saved calls and carts do not change association. */
object LocalCustomers {
    private const val PREFIX = "@customer:"
    const val CATALOG = "local.customer.catalog"
    fun reference(requestId: String): String { require(UUID.fromString(requestId).toString() == requestId); return PREFIX + requestId }
    fun requestId(reference: String): String? = if (!reference.startsWith(PREFIX)) null else
        reference.removePrefix(PREFIX).takeIf { runCatching { UUID.fromString(it).toString() == it }.getOrDefault(false) }
    fun payload(row: IntentRow): JSONObject? = if (row.kind != CensusRules.KIND) null else
        JSONObject(row.serializedOperation).getJSONObject("payload").takeIf { it.has("customer") && !CensusRules.isChange(it) }

    suspend fun outlets(store: FieldStore, downloaded: List<SnapshotItem>): List<SnapshotItem> {
        val states=store.localCache("local.customerdraft","states")?.takeUnless { it.tombstone }?.json?.let(::JSONArray) ?: JSONArray()
        val completion=(0 until states.length()).map { states.getJSONObject(it) }.associateBy { it.optString("draftId") }
        val local = store.history().filter { payload(it.first) != null }
            .groupBy { (row, _) -> payload(row)!!.optString("customerCaptureRequestId").ifBlank { row.requestId } }
            .mapNotNull { (root, rows) ->
            val (row, state) = rows.lastOrNull { !OutboxState.refused(it.second.state) } ?: return@mapNotNull null
            val p = payload(row) ?: return@mapNotNull null
            val id = reference(root)
            val c = p.getJSONObject("customer")
            val server = store.ack(root)?.entityId
            val checked=completion[p.optString("customerDraftId")]?.takeIf { state.state=="done" && it.optInt("revision")==p.optInt("draftRevision") }
            val canonical=downloaded.firstOrNull { it.id==server }?.let { JSONObject(it.json) }
            SnapshotItem(id, JSONObject().put("id", id).put("name", p.getString("name"))
                .put("address", p.optString("address")).put("ownerName", c.optString("customerName"))
                .put("ownerPhone", c.optString("mobileNo")).put("customerId", id)
                .put("completeness", if (p.optBoolean("draftIncomplete",true)) "draft" else "complete")
                .put("localCaptureId", root).put("serverOutletId", server ?: JSONObject.NULL)
                .put("addressParts", JSONObject().apply { CensusRules.ADDRESS_PART_KEYS.forEach { key -> put(key, c.opt(key) ?: JSONObject.NULL) } })
                .apply {
                    checked?.optString("completeness")?.takeIf { it in setOf("draft","complete") }?.let { put("completeness",it) }
                    if(state.state=="done" && canonical!=null) for(key in listOf("name","address","ownerName","ownerPhone","completeness","addressParts","latitude","longitude","code"))
                        if(canonical.has(key))put(key,canonical.get(key))
                }
                .toString())
        }
        val aliases = local.mapNotNull { JSONObject(it.json).optString("serverOutletId").takeUnless { id -> id.isBlank() || id == "null" } }.toSet()
        return downloaded.filterNot { it.id in aliases } + local
    }

    /** Persist the unpriced enrollment catalog once; never borrow another customer's prices or credit. */
    fun catalog(config: JSONObject?, fallback: List<CatalogProduct>): String = (config?.optJSONArray("newCustomerProducts")
        ?: JSONArray().apply { fallback.forEach { put(ReferenceDataCodec.encode(it)) } }).toString()
    suspend fun callSheet(store: FieldStore, outletId: String): CallSheet? {
        val request = requestId(outletId) ?: return null
        val row = store.intent(request) ?: return null
        val p = payload(row) ?: return null
        store.ack(request)?.entityId?.let { server ->
            store.callSheet(server)?.let { return it.copy(outletId=outletId) }
        }
        val raw = store.localCache(CATALOG, request)?.takeUnless { it.tombstone }?.json ?: return null
        val products = JSONArray(raw)
        return CallSheet(outletId, 1, CallSheetHeader(p.getString("name"), p.optString("address"),
            p.getJSONObject("customer").optString("customerName"), null, null, null, null, null, null,
            "Customer saved here: prices and credit confirmed by the office"), (0 until products.length()).map {
            val product = ReferenceDataCodec.product(products.getJSONObject(it))
            CallSheetProduct(product.id, product.code, product.name, product.uom, null, null)
        })
    }

    /** Resolve only from a durable matching capture acknowledgement, before signing. Never edit the template. */
    suspend fun materialize(store: FieldStore, operation: JSONObject): JSONObject? {
        val p = operation.getJSONObject("payload")
        val reference = p.optString("outletId")
        val request = requestId(reference) ?: return operation
        val parent = store.intent(request) ?: error("Customer capture is missing; saved work is retained")
        require(payload(parent) != null) { "Not a customer capture" }
        val ack = store.ack(request) ?: return null
        require(runCatching { UUID.fromString(ack.entityId).toString() == ack.entityId }.getOrDefault(false))
        p.put("outletId", ack.entityId)
        return operation
    }
}
