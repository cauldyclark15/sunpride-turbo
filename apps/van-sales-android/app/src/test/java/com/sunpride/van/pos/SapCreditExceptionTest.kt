package com.sunpride.van.pos

import com.sunpride.van.data.*
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test

class SapCreditExceptionTest {
    @Test fun F404_actualProviderReceiptAllowsOnlyItsExactInvoiceAndNeverRaisesTheOrdinaryLimit(){
        val receipt=JSONObject(checkNotNull(javaClass.classLoader!!.getResourceAsStream("sap-credit-exception-v1.json")).bufferedReader().use{it.readText()}).getJSONObject("approved")
        val at=receipt.getJSONObject("exposure").getLong("checkedAt")+1000
        val buyer=Customer("SAMPLE-outlet","SAMPLE","SAMPLE buyer",null,1,"route",credit=CustomerCredit(30,999999),priceListId="SAMPLE")
        val product=Product("SAMPLE-product","SAMPLE","SAMPLE product","EA",1,emptyList())
        val request=CheckoutRequest(receipt.getString("sourceId"),buyer.outletId,listOf(CartLine(product.productId,2)),PaymentInput("credit"))
        // Explicit test policy/stock, surrounding the verbatim real API receipt (not a fabricated provider response).
        fun context(withReceipt:Boolean=true,localLimit:Long=5000):CheckoutContext{
            val account=JSONObject().put("version",1).put("status","over").put("freshness","live").put("source","sample").put("customerCode",receipt.getString("customerCode"))
                .put("checkedAt",at).put("expiresAt",at+120000).put("limitMinor","1000").put("exposureMinor","900").put("availableMinor","0").put("termsDays",30).put("localLimitMinor",localLimit.toString())
            val rule=JSONObject().put("id","SAMPLE-test-policy").put("kind","credit").put("channel",receipt.getJSONObject("exposure").getString("channel")).put("minMinor","0").put("maxMinor","1000000").put("selfLimitMinor","0").put("offlineAllowed",false).put("effectiveFrom",0).put("effectiveTo",JSONObject.NULL)
            val fiscal=JSONObject().put("creditSnapshots",JSONObject().put(buyer.outletId,account)).put("authority",JSONObject().put("orgUnitId",receipt.getJSONObject("exposure").getString("orgUnitId")).put("rules",JSONArray().put(rule)))
                .put("customerChannels",JSONObject().put(buyer.outletId,receipt.getJSONObject("exposure").getString("channel")))
                .put("sapCreditRequests",if(withReceipt)JSONObject().put(request.saleId,receipt)else JSONObject())
                .put("taxVersion",1).put("taxQuotes",JSONArray().put(JSONObject().put("priceListId","SAMPLE").put("productId",product.productId).put("uomCode","EA").put("treatment","vatable").put("taxCode","SAMPLE-VAT12").put("taxBasisPoints",1200).put("sourceTaxInclusive",true).put("effectiveFrom",0).put("effectiveTo",JSONObject.NULL)))
            return CheckoutContext(true,listOf(buyer),listOf(product),listOf(TruckStock(product.productId,10,0)),listOf(PriceLine("SAMPLE",product.productId,"EA",1000,"PHP",0,null)),VanPolicy(paymentMethods=listOf(PaymentMethod("credit","Credit",PaymentKind.CREDIT,false,null)),fiscalJson=fiscal.toString()),at,"2026-10-21")
        }
        assertFalse(CheckoutRules.evaluate(request,context(false)).ok)
        assertTrue(CheckoutRules.evaluate(request,context()).ok)
        assertEquals(1000L,CreditExposure.view(buyer,context())?.limitMinor)
        assertFalse(CheckoutRules.evaluate(request,context(localLimit=1000)).ok)
        assertFalse(CheckoutRules.evaluate(request,context().copy(creditUsedMinor=mapOf(buyer.outletId to 1L))).ok)
        assertFalse(CheckoutRules.evaluate(request.copy(lines=listOf(CartLine(product.productId,1))),context()).ok)
        assertFalse(CheckoutRules.evaluate(request,context().copy(now=receipt.getLong("expiresAt")+1)).ok)
    }
}
