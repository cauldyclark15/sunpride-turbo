package com.sunpride.field.storage

import org.json.JSONArray
import org.json.JSONObject

/** Quantities and conversions are integer base units × quantityScale, never floating point. */
data class ProductUom(val code: String, val name: String, val decimalPlaces: Long)
data class UomConversion(val numerator: Long, val denominator: Long, val roundingMode: String)
data class SellingUom(val code: String, val name: String, val decimalPlaces: Long, val toBase: UomConversion?)
data class ProductBarcode(val barcode: String, val uom: String?)
data class CatalogProduct(val id: String, val code: String, val name: String, val uom: String,
    val revision: Long = 0, val quantityScale: Long = 1000, val baseUom: ProductUom? = null,
    val sellingUoms: List<SellingUom> = emptyList(), val barcodes: List<ProductBarcode> = emptyList())
data class InventoryAvailability(val id: String, val productId: String, val locationId: String,
    val locationCode: String, val locationName: String, val availableBase: Long, val physicalBase: Long,
    val reservedBase: Long, val revision: Long, val asOf: Long)

object ReferenceDataCodec {
    private fun JSONObject.text(key: String): String = (get(key) as? String)
        ?.also { require(it.isNotBlank()) { "Invalid $key" } } ?: error("Invalid $key")
    private fun JSONObject.integer(key: String): Long {
        val n = get(key)
        require(n is Int || n is Long) { "Invalid $key" }
        return (n as Number).toLong()
    }
    private fun JSONObject.optionalInteger(key: String, default: Long): Long = if (has(key)) integer(key) else default
    private fun JSONObject.nullableText(key: String): String? = if (get(key) == JSONObject.NULL) null else text(key)
    private fun <T> JSONObject.list(key: String, decode: (JSONObject) -> T): List<T> {
        if (!has(key)) return emptyList()
        val a = getJSONArray(key)
        return (0 until a.length()).map { decode(a.getJSONObject(it)) }
    }
    private fun uom(o: JSONObject) = ProductUom(o.text("code"), o.text("name"),
        o.integer("decimalPlaces").also { require(it >= 0) })
    fun product(o: JSONObject): CatalogProduct = CatalogProduct(o.text("id"), o.text("code"),
        o.text("name"), o.text("uom"), o.optionalInteger("revision", 0).also { require(it >= 0) },
        o.optionalInteger("quantityScale", 1000).also { require(it > 0) },
        if (!o.has("baseUom") || o.isNull("baseUom")) null else uom(o.getJSONObject("baseUom")),
        o.list("sellingUoms") { s ->
            val unit = uom(s)
            val conversion = if (s.isNull("toBase")) null else s.getJSONObject("toBase").let { c ->
                UomConversion(c.integer("numerator").also { require(it > 0) },
                    c.integer("denominator").also { require(it > 0) }, c.text("roundingMode"))
            }
            require(s.has("toBase"))
            SellingUom(unit.code, unit.name, unit.decimalPlaces, conversion)
        }, o.list("barcodes") { b -> ProductBarcode(b.text("barcode").also { require(it.length <= 64) },
            b.nullableText("uom")) }.also { require(it.size <= 20) })
    fun availability(o: JSONObject): InventoryAvailability = InventoryAvailability(o.text("id"),
        o.text("productId"), o.text("locationId"), o.text("locationCode"), o.text("locationName"),
        o.integer("availableBase"), o.integer("physicalBase"), o.integer("reservedBase"),
        o.integer("revision").also { require(it > 0) }, o.integer("asOf"))
    fun encode(p: CatalogProduct): JSONObject = JSONObject().put("id", p.id).put("code", p.code)
        .put("name", p.name).put("uom", p.uom).put("revision", p.revision).put("quantityScale", p.quantityScale)
        .put("baseUom", p.baseUom?.let { unit(it.code, it.name, it.decimalPlaces) } ?: JSONObject.NULL)
        .put("sellingUoms", JSONArray().apply { p.sellingUoms.forEach { s ->
            put(unit(s.code, s.name, s.decimalPlaces).put("toBase", s.toBase?.let { c ->
                JSONObject().put("numerator", c.numerator).put("denominator", c.denominator)
                    .put("roundingMode", c.roundingMode)
            } ?: JSONObject.NULL))
        } }).put("barcodes", JSONArray().apply { p.barcodes.forEach { b ->
            put(JSONObject().put("barcode", b.barcode).put("uom", b.uom ?: JSONObject.NULL))
        } })
    private fun unit(code: String, name: String, places: Long) = JSONObject().put("code", code)
        .put("name", name).put("decimalPlaces", places)
    fun encode(i: InventoryAvailability): JSONObject = JSONObject().put("id", i.id).put("productId", i.productId)
        .put("locationId", i.locationId).put("locationCode", i.locationCode).put("locationName", i.locationName)
        .put("availableBase", i.availableBase).put("physicalBase", i.physicalBase).put("reservedBase", i.reservedBase)
        .put("revision", i.revision).put("asOf", i.asOf)
    fun productChange(change: DeltaRow): CatalogProduct {
        require(change.entity == "product" && !change.tombstone && change.json != null)
        return product(JSONObject(change.json)).also {
            require(it.id == change.entityId && it.revision == change.revision && it.revision > 0)
        }
    }
    fun inventoryChange(change: DeltaRow): InventoryAvailability {
        require(change.entity == "inventory" && !change.tombstone && change.json != null)
        return availability(JSONObject(change.json)).also {
            require(it.id == change.entityId && it.revision == change.revision)
        }
    }
}
