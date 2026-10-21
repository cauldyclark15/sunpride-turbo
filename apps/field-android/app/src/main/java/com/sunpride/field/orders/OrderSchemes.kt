package com.sunpride.field.orders

import com.sunpride.schemes.NativeSchemeQuote
import com.sunpride.schemes.SchemeLine
import org.json.JSONObject

/** F-502/F-503: view adapter only. No mechanic, stacking or allocation rules are implemented here. */
object OrderSchemes {
    fun apply(draft: OrderDraft,base: OrderTotals,now: Long): OrderTotals {
        val snapshot=draft.schemesJson ?: return base
        return try {
            val context=JSONObject(snapshot)
            val quote=NativeSchemeQuote.evaluate(context,draft.outletId,draft.lines.map {
                SchemeLine(it.productId,it.uom,Math.multiplyExact(it.quantity.toLong(),1000),it.unitPriceMinor)
            },now,false)
            val result=quote.result
            val discounts=result.getJSONArray("lineDiscounts")
            val applied=result.getJSONArray("promotionsApplied")
            val benefits=mutableListOf<String>()
            var earned=0L
            for(i in 0 until applied.length()) {
                val p=applied.getJSONObject(i)
                benefits+=p.getString("name")
                earned=Math.addExact(earned,p.getLong("earnedCentavos"))
                val gifts=p.getJSONArray("freeGoods")
                for(j in 0 until gifts.length()) {
                    val gift=gifts.getJSONObject(j)
                    val products=context.optJSONArray("products")
                    val product=products?.let { a->(0 until a.length()).map(a::getJSONObject).firstOrNull { it.getString("productId")==gift.getString("productId") } }
                    benefits+="Free ${gift.getLong("quantity")} ${gift.getString("uom")} · ${product?.optString("name")?.takeIf { it.isNotBlank() } ?: "configured product"}"
                }
            }
            val totalDiscount=(0 until discounts.length()).sumOf { discounts.getLong(it) }
            base.copy(totalMinor=Math.subtractExact(result.getLong("knownSubtotalCentavos"),totalDiscount),
                discountMinor=totalDiscount,earnedMinor=earned,schemeBenefits=benefits,
                approvalRequired=!quote.authorityAllowed,
                lineTotals=draft.lines.mapIndexed { index,line -> OrderSubmission.lineAmount(line)?.let { Math.subtractExact(it,discounts.getLong(index)) } })
        } catch (_: Exception) {
            base.copy(totalMinor=null,schemeProblem="Promotion quote cannot be confirmed. Sync and review the order.")
        }
    }
}
