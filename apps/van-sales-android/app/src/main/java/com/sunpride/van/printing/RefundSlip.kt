package com.sunpride.van.printing

import com.sunpride.van.pos.RefundPlan
import com.sunpride.van.pos.RefundReason
import com.sunpride.van.pos.RefundTender
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId

/** One returned item on the slip. */
data class SlipLine(val name: String, val uom: String, val quantityBase: Long, val amountMinor: Long)

/**
 * IP-REFUND: everything the refund slip says, frozen with the refund. A reprint is always the same slip because it is read back
 * from these facts (never from today's prices or masters).
 */
data class RefundSlipFacts(
    val creditNumber: String,
    val originalNumber: String,
    val customerName: String?,
    val seller: String?,
    val place: String?,
    val lines: List<SlipLine>,
    val totalMinor: Long,
    val vatableMinor: Long,
    val vatMinor: Long,
    val vatExemptMinor: Long,
    val zeroRatedMinor: Long,
    val privilegeDiscountMinor: Long,
    val tenders: List<RefundTender>,
    val reasonLabel: String,
    val damaged: Boolean,
    val note: String?,
    val at: Long,
    val supervisorName: String? = null,
    val entityName: String? = null,
    val tin: String? = null,
    val address: String? = null,
    val sample: Boolean = false,
) {
    fun toJson(): JSONObject = JSONObject().put("creditNumber", creditNumber).put("originalNumber", originalNumber)
        .put("customerName", customerName ?: JSONObject.NULL).put("seller", seller ?: JSONObject.NULL).put("place", place ?: JSONObject.NULL)
        .put("lines", JSONArray(lines.map { JSONObject().put("name", it.name).put("uom", it.uom).put("quantityBase", it.quantityBase.toString()).put("amountMinor", it.amountMinor.toString()) }))
        .put("totalMinor", totalMinor.toString()).put("vatableMinor", vatableMinor.toString()).put("vatMinor", vatMinor.toString())
        .put("vatExemptMinor", vatExemptMinor.toString()).put("zeroRatedMinor", zeroRatedMinor.toString()).put("privilegeDiscountMinor", privilegeDiscountMinor.toString())
        .put("tenders", JSONArray(tenders.map { JSONObject().put("method", it.method).put("label", it.label).put("amountMinor", it.amountMinor.toString()) }))
        .put("reasonLabel", reasonLabel).put("damaged", damaged).put("note", note ?: JSONObject.NULL).put("at", at.toString())
        .put("supervisorName", supervisorName ?: JSONObject.NULL).put("entityName", entityName ?: JSONObject.NULL).put("tin", tin ?: JSONObject.NULL)
        .put("address", address ?: JSONObject.NULL).put("sample", sample)

    companion object {
        private fun JSONObject.text(k: String): String? = if (!has(k) || isNull(k)) null else getString(k)
        private fun objects(a: JSONArray) = (0 until a.length()).map { a.getJSONObject(it) }
        fun fromJson(o: JSONObject): RefundSlipFacts = RefundSlipFacts(o.getString("creditNumber"), o.getString("originalNumber"), o.text("customerName"), o.text("seller"), o.text("place"),
            objects(o.getJSONArray("lines")).map { SlipLine(it.getString("name"), it.getString("uom"), it.getString("quantityBase").toLong(), it.getString("amountMinor").toLong()) },
            o.getString("totalMinor").toLong(), o.getString("vatableMinor").toLong(), o.getString("vatMinor").toLong(), o.getString("vatExemptMinor").toLong(),
            o.getString("zeroRatedMinor").toLong(), o.getString("privilegeDiscountMinor").toLong(),
            objects(o.getJSONArray("tenders")).map { RefundTender(it.getString("method"), it.getString("label"), it.getString("amountMinor").toLong()) },
            o.getString("reasonLabel"), o.getBoolean("damaged"), o.text("note"), o.getString("at").toLong(), o.text("supervisorName"), o.text("entityName"), o.text("tin"), o.text("address"), o.optBoolean("sample"))

        fun of(creditNumber: String, originalNumber: String, customerName: String?, seller: String?, place: String?, plan: RefundPlan, tenders: List<RefundTender>,
            reason: RefundReason, note: String?, at: Long, supervisorName: String? = null, entityName: String? = null, tin: String? = null, address: String? = null, sample: Boolean = false) =
            RefundSlipFacts(creditNumber, originalNumber, customerName, seller, place,
                plan.lines.map { SlipLine(it.line.name, it.line.uom ?: "PC", it.quantityBase, it.amountMinor) }, plan.totalMinor, plan.vatableMinor, plan.vatMinor,
                plan.vatExemptMinor, plan.zeroRatedMinor, plan.privilegeDiscountMinor, tenders, reason.label, reason.damaged, note, at, supervisorName, entityName, tin, address, sample)
    }
}

object RefundSlip {
    private fun peso(minor: Long) = PesoAmounts.fromCentavos(minor)

    /** The printed refund slip: the BIR credit memo as the phone holds it, with the receipt it takes back and the goods it returns. */
    fun document(f: RefundSlipFacts, reprint: Boolean = false): ReceiptDocument {
        val e = mutableListOf<ReceiptElement>()
        fun line(v: String) { e += ReceiptElement.Text(v) }
        f.entityName?.takeIf { it.isNotBlank() }?.let { line(it) }
        f.tin?.takeIf { it.isNotBlank() }?.let { line("TIN $it") }
        f.address?.takeIf { it.isNotBlank() }?.let { line(it) }
        f.place?.takeIf { it.isNotBlank() }?.let { line(it) }
        line("CREDIT MEMO / REFUND ${f.creditNumber}")
        if (f.sample) line("SAMPLE SERIES · NOT A BIR CREDIT MEMO")
        if (reprint) line("REPRINT")
        line("Takes back receipt ${f.originalNumber}")
        f.customerName?.takeIf { it.isNotBlank() }?.let { line("Customer: $it") }
        f.seller?.takeIf { it.isNotBlank() }?.let { line("Served by: $it") }
        line(Instant.ofEpochMilli(f.at).atZone(ZoneId.of("Asia/Manila")).toString())
        e += ReceiptElement.Divider()
        f.lines.forEach { l ->
            line(l.name)
            e += ReceiptElement.Columns("${l.quantityBase} ${l.uom} returned", peso(l.amountMinor))
        }
        e += ReceiptElement.Divider()
        e += ReceiptElement.Columns("REFUND TOTAL", peso(f.totalMinor), true)
        f.tenders.forEach { t -> e += ReceiptElement.Columns("Given back: ${t.label}", peso(t.amountMinor)) }
        e += ReceiptElement.Columns("VATable", peso(f.vatableMinor))
        e += ReceiptElement.Columns("VAT", peso(f.vatMinor))
        e += ReceiptElement.Columns("VAT exempt", peso(f.vatExemptMinor))
        if (f.zeroRatedMinor != 0L) e += ReceiptElement.Columns("Zero rated", peso(f.zeroRatedMinor))
        if (f.privilegeDiscountMinor != 0L) e += ReceiptElement.Columns("SC/PWD discount returned", peso(f.privilegeDiscountMinor))
        line("Why: ${f.reasonLabel}" + if (f.damaged) " (goods set aside as damaged)" else "")
        f.note?.takeIf { it.isNotBlank() }?.let { line("Note: $it") }
        f.supervisorName?.takeIf { it.isNotBlank() }?.let { line("Approved by: $it") }
        e += ReceiptElement.Divider()
        line("Customer signature: ______________")
        e += ReceiptElement.Feed()
        return ReceiptDocument(e, reprint)
    }
}
