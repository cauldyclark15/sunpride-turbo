package com.sunpride.van.fiscal

import com.sunpride.integrity.OfflineApproval
import com.sunpride.van.data.*
import com.sunpride.van.pos.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.util.Base64
import java.util.UUID

class ManualDiscountTest {
    @Test fun lineThenBasketReductionHasExactDeterministicCentavos(){
        fun line(id:String,n:Int,total:Long)=QuotedLine(n,Product(id,"SAMPLE-$n","SAMPLE $n","EA",1,emptyList()),1,total,total,emptyList())
        val original=listOf(line("one",1,1000),line("two",2,2000))
        val reduced=ManualDiscounts.apply(original,ManualDiscountInput(mapOf("one" to 100L),300,"SAMPLE reason"))
        assertEquals(listOf(807L,1793L),reduced.map{it.totalMinor});assertEquals(400L,ManualDiscounts.amount(reduced))
        assertEquals(1000L,original[0].totalMinor)
        val unmodified=ManualDiscounts.apply(original,null).toMutableList();unmodified.clear();assertEquals(2,original.size)
        assertThrows(IllegalArgumentException::class.java){ManualDiscounts.apply(original,ManualDiscountInput(mapOf("one" to 1001L)))}
        assertThrows(IllegalArgumentException::class.java){ManualDiscounts.apply(original,ManualDiscountInput(basketMinor=3001))}
    }
    @Test fun actualApiCertificateVerifiesExactUnicodeFactsAndRefusesChangedExpiredOrPreviouslyDeniedCart(){
        val path=System.getenv("SP_NATIVE_OVERRIDE_WIRE");assumeTrue("Run the tiny finish-discount API source fixture first",path!=null)
        val wire=JSONObject(File(path!!).readText());val facts=wire.getJSONObject("facts");val l=facts.getJSONArray("lines").getJSONObject(0)
        val product=Product(l.getString("productId"),l.getString("productCode"),l.getString("productName"),l.getString("uomCode"),l.getString("quantityScale").toLong(),emptyList())
        val line=QuotedLine(1,product,l.getString("quantityBase").toLong(),l.getString("unitPriceMinor").toLong(),l.getString("totalMinor").toLong(),emptyList(),grossMinor=l.getString("grossMinor").toLong(),discountMinor=l.getString("discountMinor").toLong(),manualDiscountMinor=l.getString("discountMinor").toLong())
        val nativeFacts=ManualDiscounts.facts(facts.getString("saleId"),facts.getString("customerId"),listOf(line))
        val token=wire.getString("grant");val authority=wire.getJSONObject("authority");val reason=wire.getString("reason");val at=wire.getLong("at")
        val grant=OfflineApproval.verify(token,authority.getJSONObject("verification"),nativeFacts,authority.getString("profileId"),authority.getString("orgUnitId"),"discount",wire.getString("channel"),wire.getLong("amountMinor"),at,reason,wire.getString("ruleId"))
        assertEquals("offline",grant.mode);assertEquals(OfflineApproval.factsHash(facts),OfflineApproval.factsHash(nativeFacts))
        val fiscal=JSONObject().put("authority",authority).put("customerChannels",JSONObject().put(facts.getString("customerId"),wire.getString("channel")))
        val input=ManualDiscountInput(mapOf(product.productId to line.discountMinor),reason=reason,requestId=grant.requestId,approval=token)
        val request=CheckoutRequest(facts.getString("saleId"),facts.getString("customerId"),emptyList(),PaymentInput("cash"),input)
        val context=CheckoutContext(true,emptyList(),listOf(product),emptyList(),emptyList(),VanPolicy(fiscalJson=fiscal.toString()),at)
        assertNull(ManualDiscounts.authorize(request,listOf(line),context))
        assertEquals(CheckoutProblem.DISCOUNT_APPROVAL_INVALID,ManualDiscounts.authorize(request.copy(manualDiscount=input.copy(denied=true)),listOf(line),context))
        assertEquals(CheckoutProblem.DISCOUNT_APPROVAL_INVALID,ManualDiscounts.authorize(request.copy(manualDiscount=input.copy(requestId=UUID.randomUUID().toString())),listOf(line),context))
        assertEquals(CheckoutProblem.DISCOUNT_APPROVAL_INVALID,ManualDiscounts.authorize(request.copy(manualDiscount=input.copy(reason="Different reason")),listOf(line),context))
        assertEquals(CheckoutProblem.DISCOUNT_APPROVAL_INVALID,ManualDiscounts.authorize(request,listOf(line),context.copy(now=grant.expiresAt)))
        val parts=token.split('.').toMutableList();val claims=JSONObject(Base64.getUrlDecoder().decode(parts[1]).toString(Charsets.UTF_8)).put("amountCentavos","1")
        parts[1]=Base64.getUrlEncoder().withoutPadding().encodeToString(claims.toString().toByteArray())
        assertEquals(CheckoutProblem.DISCOUNT_APPROVAL_INVALID,ManualDiscounts.authorize(request.copy(manualDiscount=input.copy(approval=parts.joinToString("."))),listOf(line),context))
    }
}
