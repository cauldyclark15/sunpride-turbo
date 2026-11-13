package com.sunpride.van.pos
import com.sunpride.van.data.*
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID
class PickupCustodyTest {
 @Test fun F113_unlinkedPickupRetainsFactsButDoesNotCreateOwnedStock(){
  val product=Product("sample-product","SAMPLE","SAMPLE item","EA",1,emptyList())
  val buyer=Customer("sample-buyer","SAMPLE","SAMPLE buyer",null,1,"route")
  val request=ReturnRequest(UUID.randomUUID().toString(),buyer.outletId,null,listOf(ReturnLineInput(product.productId,"EA",1,"quality_complaint",ReturnDisposition.BAD_STOCK,"SAMPLE-BATCH")))
  val quote=checkNotNull(ReturnRules.evaluate(request,ReturnContext(true,listOf(buyer),listOf(product),emptyList(),emptyMap())).quote)
  assertTrue(quote.approvalRequired)
  val held=quote.heldCapture();assertTrue(held.stockChanges.isEmpty());assertEquals(quote.lines[0].quantityBase,held.lines[0].quantityBase);assertEquals("SAMPLE-BATCH",held.lines[0].lotNumber)
 }
 @Test fun VAN061_storeDisposalIsHeldForOfficeOnEveryTripVersion(){
  val product=Product("sample-product","SAMPLE","SAMPLE item","EA",1,emptyList())
  val buyer=Customer("sample-buyer","SAMPLE","SAMPLE buyer",null,1,"route")
  val request=ReturnRequest(UUID.randomUUID().toString(),buyer.outletId,null,listOf(ReturnLineInput(product.productId,"EA",1,"damaged",ReturnDisposition.DISPOSED_AT_OUTLET,null)))
  val quote=checkNotNull(ReturnRules.evaluate(request,ReturnContext(true,listOf(buyer),listOf(product),emptyList(),emptyMap())).quote)
  assertTrue(quote.approvalRequired)
  assertTrue(ReturnRules.custodyOnly(quote,0));assertTrue(ReturnRules.custodyOnly(quote,1))
 }
}
