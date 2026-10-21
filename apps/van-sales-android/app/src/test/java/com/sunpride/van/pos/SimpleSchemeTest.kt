package com.sunpride.van.pos

import com.sunpride.van.data.*
import com.sunpride.van.sync.VanBootstrapCodec
import com.sunpride.integrity.OfflineApproval
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class SimpleSchemeTest {
    @Test fun F110_exactCanonicalWireRunsThroughNativeQuoteAndManualAllocation() {
        val wire=JSONObject(checkNotNull(javaClass.classLoader?.getResourceAsStream("simple-schemes-v1.json")).bufferedReader().use{it.readText()})
        fun objects(a:JSONArray)=(0 until a.length()).map{a.getJSONObject(it)}
        val products=objects(wire.getJSONArray("products")).map{Product(it.getString("productId"),it.getString("code"),it.getString("name"),"EA",1,emptyList())}
        val prices=objects(wire.getJSONArray("products")).map{PriceLine(wire.getString("priceListId"),it.getString("productId"),"EA",it.getLong("unitPriceMinor"),"PHP",0,null)}
        val customer=Customer(wire.getString("outletId"),"SAMPLE","SAMPLE buyer",null,1,"route",priceListId=wire.getString("priceListId"))
        var lastRequest:CheckoutRequest?=null;var lastContext:CheckoutContext?=null
        for(c in objects(wire.getJSONArray("cases"))){
            val promotions=objects(c.getJSONArray("promotions")).map(VanBootstrapCodec::promotion)
            promotions.forEach{assertEquals(it,VanBootstrapCodec.promotion(VanBootstrapCodec.promotionJson(it)))}
            val cart=objects(c.getJSONArray("cart")).map{CartLine(it.getString("productId"),it.getLong("quantityBase"))}
            val context=CheckoutContext(true,listOf(customer),products,products.map{TruckStock(it.productId,100,0)},prices,VanPolicy(),wire.getLong("at"),promotions=promotions,previewOnly=true)
            val request=CheckoutRequest(UUID.randomUUID().toString(),customer.outletId,cart,PaymentInput("cash",CheckoutRules.MAX_MINOR),ManualDiscountInput(basketMinor=c.getLong("basketMinor"),reason="SAMPLE manual reduction"))
            val evaluated=CheckoutRules.evaluate(request,context)
            assertTrue("${c.getString("name")}: ${evaluated.issues}",evaluated.issues.isEmpty())
            val quote=checkNotNull(evaluated.quote)
            val native=JSONArray(quote.lines.map{l->JSONObject().put("productId",l.product.productId).put("quantityBase",l.quantityBase.toString())
                .put("paidBase",l.paidBase.toString()).put("freeBase",l.freeBase.toString()).put("unitPriceMinor",l.unitPriceMinor.toString())
                .put("grossMinor",l.grossMinor.toString()).put("discountMinor",l.discountMinor.toString()).put("totalMinor",l.totalMinor.toString())
                .put("promotion",l.promotion?.let{p->JSONObject().put("promotionId",p.promotionId).put("code",p.code).put("name",p.name).put("kind",p.kind)}?:JSONObject.NULL)})
            assertEquals(c.getString("name"),OfflineApproval.canonical(c.getJSONArray("expected")),OfflineApproval.canonical(native))
            val foreign=customer.copy(outletId="00000000-0000-4000-8000-000000000999")
            val none=PromotionEngine.apply(cart,foreign,products.associateBy{it.productId},prices,promotions,wire.getLong("at"))
            assertTrue(none.lines.all{it.promotion==null&&it.freeBase==0L})
            lastRequest=request;lastContext=context
        }
        val request=checkNotNull(lastRequest).copy(manualDiscount=null)
        val hold=JSONObject().put("schemeHolds",JSONArray().put(JSONObject().put("outletId",customer.outletId).put("productIds",JSONArray().put(products.first().productId)).put("code","SAMPLE-NEEDS-OFFICE")))
        val blocked=CheckoutRules.evaluate(request,checkNotNull(lastContext).copy(policy=VanPolicy(fiscalJson=hold.toString()),promotions=emptyList(),previewOnly=false))
        assertTrue(blocked.issues.any{it.problem==CheckoutProblem.PROMOTION_NEEDS_OFFICE})
    }
}
