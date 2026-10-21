package com.sunpride.van.pos

import com.sunpride.integrity.OfflineApproval
import org.json.JSONArray
import org.json.JSONObject
import java.math.BigInteger
import java.util.UUID

/** F-110: exact minor units; a basket reduction is distributed deterministically, never a new price. */
data class ManualDiscountInput(val lineMinor:Map<String,Long> = emptyMap(),val basketMinor:Long = 0,
    val reason:String = "",val requestId:String = UUID.randomUUID().toString(),val approval:String? = null,val denied:Boolean = false)
object ManualDiscounts {
    fun apply(lines:List<QuotedLine>,input:ManualDiscountInput?):List<QuotedLine> {
        if(input==null)return lines.toList()
        require(input.basketMinor>=0&&input.lineMinor.values.all{it>=0})
        require(input.lineMinor.keys.all{id->lines.any{it.product.productId==id}})
        val remaining=lines.map{line->Math.subtractExact(line.totalMinor,input.lineMinor[line.product.productId]?:0L).also{require(it>=0)}}
        val sum=remaining.fold(0L,Math::addExact);require(input.basketMinor<=sum)
        val allocated=MutableList(lines.size){0L}
        if(input.basketMinor>0){
            val denominator=BigInteger.valueOf(sum)
            val fractions=remaining.mapIndexed{i,v->
                val qr=BigInteger.valueOf(input.basketMinor).multiply(BigInteger.valueOf(v)).divideAndRemainder(denominator)
                check(qr[0].signum()>=0&&qr[0].bitLength()<63)
                allocated[i]=qr[0].toLong();i to qr[1]
            }
            val residue=Math.subtractExact(input.basketMinor,allocated.fold(0L,Math::addExact))
            fractions.sortedWith(compareByDescending<Pair<Int,BigInteger>>{it.second}.thenBy{lines[it.first].lineNumber})
                .take(Math.toIntExact(residue)).forEach{allocated[it.first]++}
        }
        return lines.mapIndexed{i,line->val manual=Math.addExact(input.lineMinor[line.product.productId]?:0L,allocated[i])
            line.copy(totalMinor=Math.subtractExact(line.totalMinor,manual),discountMinor=Math.addExact(line.discountMinor,manual),manualDiscountMinor=manual)}
    }
    fun amount(lines:List<QuotedLine>)=lines.fold(0L){sum,line->Math.addExact(sum,line.discountMinor)}
    fun reason(input:ManualDiscountInput?)=input?.reason?.trim()?.takeIf{it.isNotEmpty()}?:"Applied governed promotion"
    fun facts(saleId:String,customerId:String,lines:List<QuotedLine>):JSONObject = JSONObject().put("version",2)
        .put("saleId",saleId).put("customerId",customerId)
        .put("lines",JSONArray(lines.map{line->JSONObject().put("productId",line.product.productId)
            .put("productCode",line.product.code).put("productName",line.product.name)
            .put("uomCode",line.product.uomCode).put("quantityScale",line.product.quantityScale.toString())
            .put("quantityBase",line.quantityBase.toString()).put("unitPriceMinor",line.unitPriceMinor.toString())
            .put("grossMinor",line.grossMinor.toString()).put("discountMinor",line.discountMinor.toString()).put("totalMinor",line.totalMinor.toString())}))
        .put("totalMinor",lines.fold(0L){sum,line->Math.addExact(sum,line.totalMinor)}.toString())
    fun rule(authority:JSONObject,kind:String,channel:String,amount:Long,at:Long):JSONObject? {
        val rules=authority.getJSONArray("rules");require(rules.length()<=200)
        val choices=(0 until rules.length()).map{rules.getJSONObject(it)}.filter{r->
            r.getString("kind")==kind&&r.getString("channel") in listOf(channel,"*")&&
                amount>=r.getString("minMinor").toLong()&&amount<=r.getString("maxMinor").toLong()&&
                at>=r.getLong("effectiveFrom")&&(r.isNull("effectiveTo")||at<r.getLong("effectiveTo"))}
        val exact=choices.filter{it.getString("channel")==channel}
        return (exact.ifEmpty{choices}).singleOrNull()
    }
    fun authorize(request:CheckoutRequest,lines:List<QuotedLine>,context:CheckoutContext):CheckoutProblem? {
        val amount=runCatching{amount(lines)}.getOrElse{return CheckoutProblem.TOTAL_TOO_LARGE}
        if(amount>CheckoutRules.MAX_MINOR)return CheckoutProblem.TOTAL_TOO_LARGE
        if(amount==0L)return null
        val raw=context.policy?.fiscalJson
        // Legacy debug fixtures are not upgraded into a fiscal authority by this client.
        if(raw==null&&request.manualDiscount==null)return null
        val input=request.manualDiscount
        if(input?.denied==true)return CheckoutProblem.DISCOUNT_APPROVAL_INVALID
        if(lines.any{it.manualDiscountMinor>0}&&(input==null||input.reason.trim().length !in 1..300))return CheckoutProblem.DISCOUNT_REASON_REQUIRED
        return runCatching<CheckoutProblem?> {
            val fiscal=JSONObject(checkNotNull(raw));val authority=fiscal.getJSONObject("authority")
            val customerId=checkNotNull(request.customerId)
            val channel=fiscal.getJSONObject("customerChannels").getString(customerId)
            val rule=rule(authority,"discount",channel,amount,context.now)?:return CheckoutProblem.DISCOUNT_POLICY_NOT_READY
            val token=input?.approval
            if(amount>rule.getString("selfLimitMinor").toLong()&&token.isNullOrBlank())return CheckoutProblem.DISCOUNT_APPROVAL_REQUIRED
            if(!token.isNullOrBlank()){
                val verified=OfflineApproval.verify(token,authority.getJSONObject("verification"),facts(request.saleId,customerId,lines),authority.getString("profileId"),authority.getString("orgUnitId"),"discount",channel,amount,context.now,reason(input),rule.getString("id"))
                require(verified.requestId==(input?.requestId?:request.saleId))
                require(verified.mode!="offline"||rule.getBoolean("offlineAllowed"))
            }
            null
        }.getOrElse{CheckoutProblem.DISCOUNT_APPROVAL_INVALID}
    }
}
