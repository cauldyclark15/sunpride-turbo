package com.sunpride.van.pos
import com.sunpride.van.data.*
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID
class CreditExposureTest {
 @Test fun F112_APIFramesExpireAndNeverFallBackToLegacyCredit_ActualCheckoutBlocksStale(){
  val wire=JSONObject(checkNotNull(javaClass.classLoader?.getResourceAsStream("credit-exposure-v1.json")).bufferedReader().use{it.readText()})
  val at=wire.getLong("at");val buyer=Customer(wire.getString("outletId"),"SAMPLE","SAMPLE buyer",null,1,"route",credit=CustomerCredit(30,999999),priceListId="SAMPLE")
  val product=Product("sample-product","SAMPLE","SAMPLE product","EA",1,emptyList())
  fun context(frame:String):CheckoutContext{
   val fiscal=JSONObject().put("creditSnapshots",JSONObject().put(buyer.outletId,wire.getJSONObject("frames").getJSONObject(frame)))
    .put("taxVersion",1).put("taxQuotes",JSONArray().put(JSONObject().put("priceListId","SAMPLE").put("productId",product.productId).put("uomCode","EA").put("treatment","vatable").put("taxCode","SAMPLE-VAT12").put("taxBasisPoints",1200).put("sourceTaxInclusive",true).put("effectiveFrom",0).put("effectiveTo",JSONObject.NULL)))
   return CheckoutContext(true,listOf(buyer),listOf(product),listOf(TruckStock(product.productId,10,0)),listOf(PriceLine("SAMPLE",product.productId,"EA",100,"PHP",0,null)),VanPolicy(paymentMethods=listOf(PaymentMethod("credit","Credit",PaymentKind.CREDIT,false,null)),fiscalJson=fiscal.toString()),at,"2026-10-21",creditUsedMinor=mapOf(buyer.outletId to 1000L))
  }
  assertEquals(4000L,CheckoutRules.creditLeft(buyer,context("fresh")))
  val request=CheckoutRequest(UUID.randomUUID().toString(),buyer.outletId,listOf(CartLine(product.productId,1)),PaymentInput("credit"))
  assertTrue(CheckoutRules.evaluate(request,context("fresh")).ok)
  val expired=context("fresh").copy(now=wire.getJSONObject("frames").getJSONObject("fresh").getLong("expiresAt")+1)
  assertNull(CheckoutRules.creditLeft(buyer,expired));assertTrue(CheckoutRules.evaluate(request,expired).issues.any{it.problem==CheckoutProblem.CREDIT_EXPOSURE_STALE})
  for(frame in listOf("stale","unknown")){assertNull(CheckoutRules.creditLeft(buyer,context(frame)));assertFalse(CheckoutRules.evaluate(request,context(frame)).ok)}
 }
}
