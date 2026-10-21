package com.sunpride.van

import com.sunpride.van.data.*
import com.sunpride.van.pos.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class CanonicalPromotionsTest {
    private fun context(row: JSONObject,selfLimit: Long = 1_000_000): CheckoutContext {
        val request=row.getJSONObject("request")
        val source=request.getJSONArray("lines")
        val products=(0 until source.length()).map { source.getJSONObject(it) }.map { p -> Product(p.getString("productId"),p.getString("productId"),"Sample product","EA",1,emptyList()) }
        val prices=(0 until source.length()).map { source.getJSONObject(it) }.map { p -> PriceLine("sample-quote",p.getString("productId"),p.getString("uom"),p.getLong("unitPriceCentavos"),"PHP",0,null,"Sample quote") }
        val offers=JSONArray(request.getJSONArray("promotions").toString())
        for(i in 0 until offers.length()) offers.getJSONObject(i).put("effectiveFrom",0).put("effectiveTo",JSONObject.NULL)
        val quoteContext=JSONObject().put("engineVersion",1).put("outletId","sample-store").put("quotedAt",0).put("validUntil",10000)
            .put("channelKey","sample").put("accountLinked",true).put("prices",source).put("promotions",offers)
            .put("authority",JSONArray().put(JSONObject().put("channel","sample").put("minCentavos","0").put("maxCentavos","99999999").put("selfLimitCentavos",selfLimit.toString())))
        val policy=VanPolicy(schemesJson=JSONObject().put("engineVersion",1).put("outlets",JSONArray().put(quoteContext)).toString())
        val customer=Customer("sample-store","SAMPLE","Sample store",null,null,"route",priceListId="sample-quote",priceListMode=CustomerPriceListMode.GOVERNED)
        return CheckoutContext(true,listOf(customer),products,products.map { TruckStock(it.productId,1000,0) },prices,policy,1000)
    }
    @Test fun f502ActualCheckoutUsesAllCanonicalMechanicsStackingAndDeferredBenefits() {
        val fixtures=JSONArray(checkNotNull(javaClass.getResourceAsStream("/scheme-v1-parity.json")).bufferedReader().use { it.readText() })
        for(i in 0 until fixtures.length()) {
            val row=fixtures.getJSONObject(i)
            if(row.getString("name")=="eligibility-exclusion") continue // Server snapshot performs scoped filtering; its own API test covers it.
            val source=row.getJSONObject("request").getJSONArray("lines")
            val cart=(0 until source.length()).map { source.getJSONObject(it) }.map { CartLine(it.getString("productId"),it.getLong("quantity")) }
            val result=CheckoutRules.evaluate(CheckoutRequest(UUID.randomUUID().toString(),"sample-store",cart,PaymentInput("cash",1000000)),context(row))
            assertTrue(row.getString("name")+result.issues,result.ok)
            val quote=checkNotNull(result.quote)
            val expected=row.getJSONObject("expected")
            assertEquals(row.getString("name"),expected.getLong("totalCentavos"),quote.totalMinor)
            val promotions=expected.getJSONArray("promotionsApplied")
            var gifts=0L;var earned=0L
            for(j in 0 until promotions.length()) {
                val p=promotions.getJSONObject(j);earned+=p.getLong("earnedCentavos")
                val a=p.getJSONArray("freeGoods");for(k in 0 until a.length()) gifts+=a.getJSONObject(k).getLong("quantity")
            }
            assertEquals(gifts,quote.lines.sumOf { it.freeBase })
            assertEquals(earned,quote.earnedMinor)
            assertEquals(expected.getLong("subtotalCentavos")-quote.totalMinor,quote.lines.sumOf { it.discountMinor })
        }
    }
    @Test fun f511ActualCheckoutRefusesOutOfBandBenefitsAndExpiredContext() {
        val fixtures=JSONArray(checkNotNull(javaClass.getResourceAsStream("/scheme-v1-parity.json")).bufferedReader().use { it.readText() })
        val row=fixtures.getJSONObject(2)
        val request=CheckoutRequest(UUID.randomUUID().toString(),"sample-store",listOf(CartLine("sample-a",4),CartLine("sample-b",2)),PaymentInput("cash",1000000))
        for(c in listOf(context(row,0),context(row).copy(now=10001))) {
            val result=CheckoutRules.evaluate(request,c)
            assertFalse(result.ok)
            assertTrue(result.issues.any { it.problem==CheckoutProblem.PROMOTION_NEEDS_OFFICE })
        }
    }
}
