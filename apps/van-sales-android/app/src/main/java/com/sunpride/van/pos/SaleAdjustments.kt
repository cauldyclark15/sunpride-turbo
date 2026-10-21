package com.sunpride.van.pos

import com.sunpride.integrity.OfflineApproval
import com.sunpride.van.data.PriceLine
import org.json.JSONObject
import java.util.UUID

/** F-124: the same fiscal rules/certificates as discounts; never a second approval authority. */
data class FinancialOverride(val reason:String="",val requestId:String=UUID.randomUUID().toString(),val approval:String?=null,val denied:Boolean=false)
data class SalePriceOverride(val unitMinor:Map<String,Long>,val authorization:FinancialOverride=FinancialOverride())
object SaleAdjustments {
    fun prices(request:CheckoutRequest,context:CheckoutContext):List<PriceLine>{
        val changes=request.priceOverride?.unitMinor.orEmpty()
        require(changes.keys.all{id->request.lines.any{it.productId==id}})
        require(changes.values.all{it in 0..CheckoutRules.MAX_MINOR})
        // Refuse missing/ambiguous original authority before replacing any quote value.
        val customer=context.customers.firstOrNull{it.outletId==request.customerId}
        for(id in changes.keys){val product=context.products.single{it.productId==id};require(PriceResolver.resolve(product,context.prices,context.now,customer)!=null)}
        return context.prices.map{p->changes[p.productId]?.let{p.copy(unitPriceMinor=it)}?:p}
    }
    private fun original(line:QuotedLine,request:CheckoutRequest,context:CheckoutContext)=checkNotNull(PriceResolver.resolve(line.product,context.prices,context.now,context.customers.firstOrNull{it.outletId==request.customerId})).unitPriceMinor
    fun facts(kind:String,request:CheckoutRequest,lines:List<QuotedLine>,context:CheckoutContext):JSONObject{
        val facts=ManualDiscounts.facts(request.saleId,checkNotNull(request.customerId),lines).put("version",3).put("kind",kind)
        if(kind=="price")lines.forEachIndexed{i,l->facts.getJSONArray("lines").getJSONObject(i).put("originalUnitPriceMinor",original(l,request,context).toString())}
        return facts
    }
    fun priceAmount(request:CheckoutRequest,lines:List<QuotedLine>,context:CheckoutContext):Long=lines.fold(0L){sum,l->
        val before=checkNotNull(CheckoutRules.lineTotal(original(l,request,context),l.paidBase,l.product.quantityScale))
        Math.addExact(sum,if(l.grossMinor>before)l.grossMinor-before else before-l.grossMinor)
    }
    fun authorize(kind:String,request:CheckoutRequest,lines:List<QuotedLine>,context:CheckoutContext):CheckoutProblem?=runCatching<CheckoutProblem?>{
        val input=if(kind=="price")request.priceOverride?.authorization else request.creditOverride
        if(input==null||input.reason.trim().length !in 1..300)return CheckoutProblem.OVERRIDE_REASON_REQUIRED
        if(input.denied)return CheckoutProblem.OVERRIDE_INVALID
        val amount=if(kind=="price")priceAmount(request,lines,context)else lines.fold(0L){n,l->Math.addExact(n,l.totalMinor)}
        if(amount>CheckoutRules.MAX_MINOR)return CheckoutProblem.TOTAL_TOO_LARGE
        val fiscal=JSONObject(checkNotNull(context.policy?.fiscalJson));val authority=fiscal.getJSONObject("authority")
        val channel=fiscal.getJSONObject("customerChannels").getString(checkNotNull(request.customerId))
        val rule=ManualDiscounts.rule(authority,kind,channel,amount,context.now)?:return CheckoutProblem.OVERRIDE_POLICY_NOT_READY
        if(input.approval.isNullOrBlank())return if(amount>rule.getString("selfLimitMinor").toLong())CheckoutProblem.OVERRIDE_APPROVAL_REQUIRED else null
        val grant=OfflineApproval.verify(input.approval,authority.getJSONObject("verification"),facts(kind,request,lines,context),authority.getString("profileId"),authority.getString("orgUnitId"),kind,channel,amount,context.now,input.reason.trim(),rule.getString("id"))
        require(grant.requestId==input.requestId&&(grant.mode!="offline"||rule.getBoolean("offlineAllowed")))
        null
    }.getOrElse{CheckoutProblem.OVERRIDE_INVALID}
    fun creditWithinSap(request:CheckoutRequest,lines:List<QuotedLine>,context:CheckoutContext,needed:Long):Boolean{
        val customer=context.customers.firstOrNull{it.outletId==request.customerId}?:return false
        if(SapCreditExceptions.credit(request,context,needed)!=null)return authorize("credit",request,lines,context)==null
        val view=CreditExposure.view(customer,context)?:return false
        if(!view.fresh(context.now)||view.status !in listOf("within","no_limit"))return false
        val available=if(view.status=="no_limit"&&view.limitMinor==null)CheckoutRules.MAX_MINOR else {
            val limit=view.limitMinor?:return false;val exposure=view.exposureMinor?:return false;(limit-exposure).coerceAtLeast(0)
        }
        return needed<=available&&authorize("credit",request,lines,context)==null
    }
    fun json(input:FinancialOverride)=JSONObject().put("overrideId",input.requestId).put("reason",input.reason.trim()).apply{input.approval?.let{put("offlineCode",it)}}
}
