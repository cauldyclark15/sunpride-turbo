package com.sunpride.schemes

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NativeSchemeContextTest {
    private fun context(): JSONObject = JSONObject().put("engineVersion",1).put("outletId","sample-store").put("quotedAt",0).put("validUntil",10000)
        .put("accountLinked",true).put("channelKey","GT")
        .put("prices",JSONArray().put(JSONObject().put("productId","sample-a").put("uom","EA").put("unitPriceCentavos",100).put("priceListId",JSONObject.NULL)))
        .put("authority",JSONArray().put(JSONObject().put("channel","GT").put("minCentavos","0").put("maxCentavos","100000").put("selfLimitCentavos","100000")))
        .put("promotions",JSONArray().put(JSONObject().put("id","sample-rebate").put("code","SAMPLE").put("name","Sample rebate")
            .put("effectiveFrom",0).put("effectiveTo",JSONObject.NULL).put("benefit_timing","claimable")
            .put("rule",JSONObject().put("kind","value_off").put("valueCentavos",25).put("item",JSONObject().put("productId","sample-a").put("uom","EA").put("quantity",2)))))
    private val lines=listOf(SchemeLine("sample-a","EA",4000,100))
    @Test fun f511DeferredBenefitsNeedAnAccountingAccountAndNeverReduceThePayment() {
        val quote=NativeSchemeQuote.evaluate(context(),"sample-store",lines,1000,true)
        assertEquals(400L,quote.result.getLong("totalCentavos"));assertEquals(50L,quote.benefitMinor)
        assertThrows(IllegalArgumentException::class.java) { NativeSchemeQuote.evaluate(context().put("accountLinked",false),"sample-store",lines,1000,true) }
        assertThrows(IllegalArgumentException::class.java) { NativeSchemeQuote.evaluate(context().apply { remove("accountLinked") },"sample-store",lines,1000,true) }
    }
    @Test fun f511MissingChannelDoesNotTurnWildcardPolicyIntoAuthority() {
        val missing=context().put("channelKey",JSONObject.NULL).apply { getJSONArray("authority").getJSONObject(0).put("channel","*") }
        assertFalse(NativeSchemeQuote.evaluate(missing,"sample-store",lines,1000,false).authorityAllowed)
        assertThrows(IllegalStateException::class.java) { NativeSchemeQuote.evaluate(missing,"sample-store",lines,1000,true) }
    }
    @Test fun f503MoneyAndEpochsAreNotCoercedAndApi29OverflowRemainsExact() {
        val price=context().apply { getJSONArray("prices").getJSONObject(0).put("unitPriceCentavos","100") }
        assertThrows(IllegalArgumentException::class.java) { NativeSchemeQuote.evaluate(price,"sample-store",lines,1000,true) }
        assertThrows(IllegalArgumentException::class.java) { NativeSchemeQuote.evaluate(context().put("quotedAt","0"),"sample-store",lines,1000,true) }
        val overflow=context().apply { getJSONArray("prices").getJSONObject(0).put("unitPriceCentavos",9_007_199_254_740_991L) }
        assertThrows(NumberFormatException::class.java) { NativeSchemeQuote.evaluate(overflow,"sample-store",listOf(SchemeLine("sample-a","EA",1_000_000_000,9_007_199_254_740_991)),1000,true) }
    }
}
