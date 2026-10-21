package com.sunpride.van.storepos

import com.sunpride.van.data.*
import com.sunpride.van.pos.*
import com.sunpride.van.storage.OutboxRow
import com.sunpride.van.printing.*
import com.sunpride.van.printing.escpos.EscPosEncoder
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import org.junit.Assert.*
import java.util.UUID

class StoreGovernedCheckoutTest {
    private val fixtures:List<JSONObject> get() {
        val text=checkNotNull(javaClass.classLoader?.getResourceAsStream("store-tpm-v1.json")).bufferedReader().use {it.readText()}
        val rows=JSONArray(text);return (0 until rows.length()).map(rows::getJSONObject)
    }
    private fun context(f:JSONObject,freeStock:Long=10):Pair<CheckoutRequest,CheckoutContext>{
        val raw=StoreCheckout.objects(f.getJSONArray("lines"))
        val products=raw.map {Product(it.getString("productId"),it.getString("productId"),"Sample ${it.getString("productId")}","PC",1,emptyList())}
        val customer=Customer("store","SAMPLE","Sample store",null,null,"unplanned",priceListId="quote")
        val prices=raw.map {PriceLine("quote",it.getString("productId"),"PC",it.getLong("unitPriceCentavos"),"PHP",1,null)}
        val meta=JSONObject().put("schemes",f.getJSONArray("schemes")).put("priceLists",JSONObject().put("a","base").put("b","base"))
        val context=CheckoutContext(true,listOf(customer),products,products.map {TruckStock(it.productId,if(it.productId=="b")freeStock else 10,0)},prices,VanPolicy(),100,governedPromotionsJson=meta.toString())
        val request=CheckoutRequest(UUID.randomUUID().toString(),"store",raw.map {CartLine(it.getString("productId"),it.getLong("quantity"))},PaymentInput("cash",10000))
        return request to context
    }
    @Test fun F_R03_TPM_v1_matches_canonical_server_golden_cases(){
        for(f in fixtures){
            val (request,context)=context(f)
            val result=CheckoutRules.evaluate(request,context)
            assertTrue("${f.getString("name")}: ${result.issues}",result.ok)
            val quote=checkNotNull(result.quote)
            val expected=f.getJSONObject("expected")
            assertEquals(f.getString("name"),expected.getLong("total"),quote.totalMinor)
            val discount=expected.getJSONArray("discounts")
            for(i in 0 until discount.length())assertEquals("${f.getString("name")} line $i",discount.getLong(i),quote.lines[i].discountMinor)
            val gifts=StoreCheckout.objects(expected.getJSONArray("free"))
            assertEquals(gifts.sumOf {it.getLong("quantity")},quote.lines.sumOf {it.freeBase})
        }
    }
    @Test fun F_R03_paid_and_gift_quantities_cannot_double_spend_the_same_stock(){
        val (request,context)=context(fixtures.single {it.getString("name")=="gift"},2)
        val result=CheckoutRules.evaluate(request,context)
        assertFalse(result.ok)
        assertTrue(result.issues.any {it.problem==CheckoutProblem.INSUFFICIENT_STOCK})
    }
    @Test fun F_R07_acknowledgement_does_not_make_a_cached_points_balance_spendable_again(){
        val phone="639170000001"
        val lookup=JSONObject().put("phone",phone).put("points","10").put("lookupId","verified-lookup")
        val config=StorePosConfig("store","mode","register","Register","Store","SAMPLE",null,null,JSONObject().put("customerLookup",lookup))
        val payload=JSONObject().put("customerPhone",phone).put("redeemPoints","6").put("loyaltyLookupId","verified-lookup")
        val row=OutboxRow("sample-subject","sample-device","sample-sale","register","store.sale",JSONObject().put("payload",payload).toString(),1,status="pending")
        assertEquals(10L-6,StoreCheckout.availablePoints(config,listOf(row)))
        assertEquals(10L-6,StoreCheckout.availablePoints(config,listOf(row.copy(status="done"))))
        lookup.put("points","4").put("lookupId","fresh-verification")
        assertEquals(4L,StoreCheckout.availablePoints(config,listOf(row.copy(status="done"))))
        assertEquals(phone,StoreCheckout.normalizePhone("+63 (917) 000-0001"))
    }
    @Test fun F_R03_frozen_58mm_receipt_bytes_include_sample_series_tax_tender_and_reprint(){
        val r=JSONObject().put("store","Sample Cebu store").put("register","Register one").put("terminal","SAMPLE-01")
            .put("receiptNumber","SAMPLE-SI-000000001").put("cashier","Sample cashier").put("customer","Walk-in")
            .put("soldAt",1).put("totalMinor","11200")
            .put("fiscal",JSONObject().put("sample",true).put("entityName","SAMPLE company").put("tin","SAMPLE TIN").put("address","Sample Cebu address"))
            .put("tax",JSONObject().put("vatMinor","1200").put("vatableSalesMinor","10000").put("vatExemptMinor","0"))
            .put("lines",JSONArray().put(JSONObject().put("description","Frozen sample item").put("quantity",1).put("uom","PC").put("lineTotalCentavos","11200")))
            .put("tenders",JSONArray().put(JSONObject().put("method","cash").put("label","Cash").put("amountCentavos","11200").put("tenderedCentavos","12000").put("changeCentavos","800")))
        val doc=StoreTransactions.document(r,true)
        val layout=ReceiptLayoutFormatter().format(doc).filterIsInstance<ReceiptCommand.Line>()
        assertTrue(layout.all {it.text.codePointCount(0,it.text.length)<=32})
        val text=layout.joinToString(""){it.text}
        assertTrue(text.contains("SAMPLE SERIES"));assertTrue(text.contains("NOT A BIR TAX INVOICE"));assertTrue(text.contains("REPRINT"))
        assertTrue(text.contains("SAMPLE TIN"));assertTrue(text.contains("P112.00"));assertTrue(text.contains("P8.00"));assertTrue(text.contains("VAT"))
        val bytes=EscPosEncoder().encode(doc)
        assertTrue(bytes.isNotEmpty());assertTrue(String(bytes,Charsets.ISO_8859_1).contains("REPRINT"))
    }
}
