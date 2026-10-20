package com.sunpride.catalogue

import org.json.JSONArray
import org.json.JSONObject

/** F-616 shared read-only catalogue contract; never a price or stock authority. */
data class CatalogueImage(val path: String, val sha256: String, val bytes: Int)
data class CataloguePack(val uom: String, val label: String, val numerator: Long?, val denominator: Long?, val baseUom: String) {
    fun explanation(): String = if (numerator == null || denominator == null) "$label · conversion needs setup"
        else if (numerator % denominator == 0L) "$label · ${numerator / denominator} $baseUom"
        else "$label · $numerator/$denominator $baseUom"
}
data class CatalogueDetails(val revision: Int, val versionId: String, val source: String, val sample: Boolean,
    val description: String, val ingredients: String, val allergens: String, val storage: String,
    val shelfLifeDays: Int, val caseSpecifications: String, val packs: List<CataloguePack>, val image: CatalogueImage?) {
    fun json(): JSONObject = JSONObject().put("revision", revision).put("versionId", versionId).put("source", source).put("sample", sample)
        .put("description", description).put("ingredients", ingredients).put("allergens", allergens).put("storage", storage)
        .put("shelfLifeDays", shelfLifeDays).put("caseSpecifications", caseSpecifications)
        .put("packHierarchy", JSONArray(packs.map { p -> JSONObject().put("uom", p.uom).put("label", p.label)
            .put("numerator", p.numerator ?: JSONObject.NULL).put("denominator", p.denominator ?: JSONObject.NULL).put("baseUom", p.baseUom) }))
        .put("image", image?.let { JSONObject().put("path", it.path).put("sha256", it.sha256).put("bytes", it.bytes) } ?: JSONObject.NULL)
    companion object {
        fun decode(o: JSONObject): CatalogueDetails {
            fun text(key: String): String = o.getString(key).also { require(it.length in 1..2000) }
            val revision = o.getInt("revision").also { require(it > 0) }
            val source = text("source").also { require(it in listOf("sample", "sap")) }
            val sample = o.getBoolean("sample"); require(sample == (source == "sample"))
            val list = o.getJSONArray("packHierarchy"); require(list.length() <= 100)
            val packs = (0 until list.length()).map { i -> list.getJSONObject(i).let { p ->
                val numerator = if (p.isNull("numerator")) null else p.getLong("numerator").also { require(it > 0) }
                val denominator = if (p.isNull("denominator")) null else p.getLong("denominator").also { require(it > 0) }
                require((numerator == null) == (denominator == null))
                CataloguePack(p.getString("uom"), p.getString("label"), numerator, denominator, p.getString("baseUom"))
            } }
            val image = o.optJSONObject("image")?.let { i ->
                CatalogueImage(i.getString("path").also { require(Regex("/api/v1/masters/catalogue-images/[0-9a-fA-F-]{36}").matches(it)) },
                    i.getString("sha256").also { require(Regex("[0-9a-f]{64}").matches(it)) }, i.getInt("bytes").also { require(it in 1..524288) })
            }
            return CatalogueDetails(revision, text("versionId"), source, sample, text("description"), text("ingredients"), text("allergens"),
                text("storage"), o.getInt("shelfLifeDays").also { require(it in 0..3650) }, text("caseSpecifications"), packs, image)
        }
    }
}
data class CatalogueEntry(val id: String, val code: String, val name: String, val barcodes: List<String>, val details: CatalogueDetails?)
object CatalogueSearch {
    private fun fold(s: String) = java.text.Normalizer.normalize(s, java.text.Normalizer.Form.NFD)
        .replace(Regex("\\p{M}+"), "").lowercase(java.util.Locale.ROOT)
    fun search(entries: List<CatalogueEntry>, query: String): List<CatalogueEntry> {
        val q = fold(query.trim())
        return entries.filter { q.isBlank() || fold(it.code).contains(q) || fold(it.name).contains(q) || it.barcodes.any { b -> b.contains(q) } }
            .sortedWith(compareBy<CatalogueEntry> { if (it.barcodes.contains(query.trim()) || fold(it.code) == q) 0 else 1 }.thenBy { it.name })
    }
    fun scan(entries: List<CatalogueEntry>, barcode: String) = entries.filter { barcode.trim() in it.barcodes }
}
