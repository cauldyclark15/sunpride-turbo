package com.sunpride.van.pos
import com.sunpride.van.data.*
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
class PriceAuthorityTest {
 @Test fun F124_exactServerGrantsBindProposedPricesAndOnlyRaiseTheLocalCreditCeiling(){
  val w=JSONObject(checkNotNull(javaClass.classLoader?.getResourceAsStream("price-authority-v1.json")).bufferedReader().use{it.readText()})
  val at=w.getLong("at");val buyer=Customer(w.getString("customerId"),"SAMPLE","SAMPLE buyer",null,1,"route",credit=CustomerCredit(30,999999),priceListId=w.getString("listId"))
  val product=Product(w.getString("productId"),"SAMPLE-PRICE","SAMPLE price item","EA",1,emptyList())
  val fiscal=JSONObject().put("authority",w.getJSONObject("authority")).put("customerChannels",JSONObject().put(buyer.outletId,"general_trade"))
   .put("creditSnapshots",JSONObject().put(buyer.outletId,JSONObject().put("version",1).put("customerCode","SAMPLE").put("status","within").put("freshness","cached").put("source","sample").put("checkedAt",at).put("expiresAt",at+60000).put("limitMinor","100000").put("exposureMinor","0").put("availableMinor","10000").put("termsDays",30)))
   .put("taxVersion",1).put("taxQuotes",JSONArray().put(JSONObject().put("priceListId",w.getString("listId")).put("productId",product.productId).put("uomCode","EA").put("treatment","vatable").put("taxCode","SAMPLE-VAT12").put("taxBasisPoints",1200).put("sourceTaxInclusive",true).put("effectiveFrom",0).put("effectiveTo",JSONObject.NULL)))
  val context=CheckoutContext(true,listOf(buyer),listOf(product),listOf(TruckStock(product.productId,10,0)),listOf(PriceLine(w.getString("listId"),product.productId,"EA",12000,"PHP",0,null)),VanPolicy(paymentMethods=listOf(PaymentMethod("credit","Credit",PaymentKind.CREDIT,false,null)),fiscalJson=fiscal.toString()),at,"2026-10-21")
  fun grant(kind:String):FinancialOverride{val g=w.getJSONObject("grants").getJSONObject(kind);return FinancialOverride(w.getString("reason"),g.getString("id"),g.getString("grant"))}
  val request=CheckoutRequest(w.getString("saleId"),buyer.outletId,listOf(CartLine(product.productId,2)),PaymentInput("credit"),priceOverride=SalePriceOverride(mapOf(product.productId to 10000L),grant("price")),creditOverride=grant("credit"))
  val quote=checkNotNull(CheckoutRules.cartQuote(request,context))
  assertEquals(w.getString("amount").toLong(),SaleAdjustments.priceAmount(request,quote.lines,context))
  assertTrue(com.sunpride.integrity.OfflineApproval.factsHash(w.getJSONObject("grants").getJSONObject("price").getJSONObject("facts"))==com.sunpride.integrity.OfflineApproval.factsHash(SaleAdjustments.facts("price",request,quote.lines,context)))
  assertTrue(CheckoutRules.evaluate(request,context).ok)
  assertFalse(CheckoutRules.evaluate(request.copy(creditOverride=null),context).ok)
  assertFalse(CheckoutRules.evaluate(request.copy(priceOverride=request.priceOverride!!.copy(unitMinor=mapOf(product.productId to 10001L))),context).ok)
  val lower=JSONObject(fiscal.toString());lower.getJSONObject("creditSnapshots").getJSONObject(buyer.outletId).put("limitMinor","15000")
  assertTrue(CheckoutRules.evaluate(request,context.copy(policy=context.policy!!.copy(fiscalJson=lower.toString()))).issues.any{it.problem==CheckoutProblem.CREDIT_LIMIT_EXCEEDED})
  val stale=JSONObject(fiscal.toString());stale.getJSONObject("creditSnapshots").getJSONObject(buyer.outletId).put("freshness","stale")
  assertFalse(CheckoutRules.evaluate(request,context.copy(policy=context.policy!!.copy(fiscalJson=stale.toString()))).ok)
  assertEquals(grant("price").requestId,SaleAdjustments.json(grant("price")).getString("overrideId"))
 }
}
