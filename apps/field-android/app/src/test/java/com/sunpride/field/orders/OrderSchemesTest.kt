package com.sunpride.field.orders

import com.sunpride.field.storage.OrderPriceList
import com.sunpride.field.storage.OrderTerms
import com.sunpride.field.storage.OrderTermsCodec
import com.sunpride.field.storage.OrderUnit
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class OrderSchemesTest {
    private fun draft(row: JSONObject): OrderDraft {
        val request=row.getJSONObject("request");val source=request.getJSONArray("lines")
        val offers=JSONArray(request.getJSONArray("promotions").toString())
        for(i in 0 until offers.length()) offers.getJSONObject(i).put("effectiveFrom",0).put("effectiveTo",JSONObject.NULL)
        val context=JSONObject().put("engineVersion",1).put("outletId","sample-store").put("quotedAt",0).put("validUntil",10000)
            .put("channelKey","sample").put("accountLinked",true).put("prices",source).put("products",JSONArray())
            .put("promotions",offers).put("authority",JSONArray().put(JSONObject().put("channel","sample").put("minCentavos","0").put("maxCentavos","9999999").put("selfLimitCentavos","9999999")))
        val lines=(0 until source.length()).map { source.getJSONObject(it) }.map { l ->
            OrderDraftLine(l.getString("productId"),"SAMPLE","Sample product",l.getString("uom"),l.getInt("quantity"),l.getLong("unitPriceCentavos"))
        }
        return OrderDraft(draftId=UUID.randomUUID().toString(),clientVisitId="sample-call",checkInRequestId="sample-checkin",plannedVisitId=null,
            outletId="sample-store",serviceDate="2026-10-21",customerId=null,customerCode=null,territoryId=null,territoryCode=null,routeId=null,
            catalogRevision=1,lines=lines,createdAt=1000,updatedAt=1000,priceList=OrderPriceList("sample-list","SAMPLE","Sample prices","PHP",true),schemesJson=context.toString())
    }
    private fun fixtures()=JSONArray(checkNotNull(javaClass.getResourceAsStream("/scheme-v1-parity.json")).bufferedReader().use { it.readText() })
    @Test fun f502FieldReviewUsesCanonicalNetAllocationsFreeGoodsAndDeferredRebates() {
        val fixtures=fixtures()
        for(i in 0 until fixtures.length()) {
            val row=fixtures.getJSONObject(i);val draft=draft(row);val totals=OrderSubmission.totals(draft)
            assertNull(row.getString("name"),totals.schemeProblem)
            val expected=row.getJSONObject("expected")
            assertEquals(row.getString("name"),expected.getLong("totalCentavos"),totals.totalMinor)
            assertEquals(expected.getLong("subtotalCentavos")-expected.getLong("totalCentavos"),totals.discountMinor)
            val promotions=expected.getJSONArray("promotionsApplied");var earned=0L
            for(j in 0 until promotions.length()) earned+=promotions.getJSONObject(j).getLong("earnedCentavos")
            assertEquals(earned,totals.earnedMinor)
            assertEquals(totals.totalMinor,totals.lineTotals.filterNotNull().sum())
            val terms=OrderTerms(draft.outletId,draft.priceList,draft.lines.map { OrderUnit(it.productId,it.uom,it.unitPriceMinor) },draft.schemesJson)
            val decoded=OrderTermsCodec.decode(OrderTermsCodec.encode(terms))
            assertEquals(JSONObject(draft.schemesJson!!).getInt("engineVersion"),JSONObject(decoded.schemesJson!!).getInt("engineVersion"))
            assertEquals(totals,OrderSubmission.totals(OrderDraftCodec.decode(OrderDraftCodec.encode(draft))))
            // The handset never sends price/discount money as financial authority.
            val activity=OrderSubmission.activity(draft)
            assertEquals(setOf("kind","clientOrderId","lines"),activity.keys().asSequence().toSet())
            assertTrue((0 until activity.getJSONArray("lines").length()).all { activity.getJSONArray("lines").getJSONObject(it).keys().asSequence().toSet()==setOf("productId","uom","quantity") })
        }
    }
    @Test fun f503ExpiredDifferentOutletAndChangedPricesNeverProduceAKnownNetQuote() {
        val original=draft(fixtures().getJSONObject(2))
        for(draft in listOf(original.copy(outletId="other-store"),original.copy(lines=original.lines.map { it.copy(unitPriceMinor=999) }),original.copy(updatedAt=10001))) {
            val total=OrderSubmission.totals(draft)
            assertNull(total.totalMinor);assertNotNull(total.schemeProblem)
        }
        val missing=JSONObject(original.schemesJson!!).put("authority",JSONArray())
        assertTrue(OrderSubmission.totals(original.copy(schemesJson=missing.toString())).approvalRequired)
    }
}
