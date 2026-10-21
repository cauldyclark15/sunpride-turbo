package com.sunpride.van.pos

import com.sunpride.van.data.Customer
import com.sunpride.van.data.CustomerCredit
import org.json.JSONObject

/** F-112: display last-known SAP facts separately from permission to capture credit. */
data class CreditFacts(val status:String,val freshness:String,val source:String,val customerCode:String?,val checkedAt:Long?,val expiresAt:Long?,
    val limitMinor:Long?,val exposureMinor:Long?,val availableMinor:Long?,val termsDays:Int?) {
    fun fresh(now:Long)=freshness in listOf("live","cached")&&checkedAt!=null&&checkedAt<=now+60_000&&expiresAt!=null&&expiresAt>now
}
object CreditExposure {
    fun view(customer:Customer,context:CheckoutContext):CreditFacts?=runCatching {
        val root=context.policy?.fiscalJson?.let(::JSONObject)?:return@runCatching null
        val row=root.optJSONObject("creditSnapshots")?.optJSONObject(customer.outletId)?:return@runCatching null
        require(row.getInt("version")==1)
        fun minor(key:String)=if(row.isNull(key))null else row.getString(key).toLong().also{require(it>=0)}
        fun time(key:String)=if(row.isNull(key))null else row.getLong(key).also{require(it>=0)}
        val status=row.getString("status");require(status in listOf("within","over","no_limit","unknown"))
        val freshness=row.getString("freshness");require(freshness in listOf("live","cached","stale","unknown"))
        val source=row.getString("source");require(source in listOf("sample","sap"))
        val days=if(row.isNull("termsDays"))null else row.getInt("termsDays").also{require(it in 1..180)}
        CreditFacts(status,freshness,source,if(row.isNull("customerCode"))null else row.getString("customerCode"),time("checkedAt"),time("expiresAt"),minor("limitMinor"),minor("exposureMinor"),minor("availableMinor"),days)
    }.getOrNull()
    fun credit(customer:Customer,context:CheckoutContext):CustomerCredit? {
        if(customer.localOnly)return null
        val governed=runCatching{context.policy?.fiscalJson?.let(::JSONObject)?.has("creditSnapshots")==true}.getOrDefault(true)
        if(!governed)return customer.credit
        val v=view(customer,context)?:return null
        if(!v.fresh(context.now)||v.status !in listOf("within","no_limit")||v.customerCode.isNullOrBlank())return null
        return CustomerCredit(v.termsDays?:return null,(v.availableMinor?:return null).coerceAtMost(CheckoutRules.MAX_MINOR))
    }
    fun problem(customer:Customer?,context:CheckoutContext):CheckoutProblem {
        val v=customer?.let{view(it,context)}?:return CheckoutProblem.CREDIT_TERMS_UNAVAILABLE
        if(v.termsDays==null)return CheckoutProblem.CREDIT_TERMS_UNAVAILABLE
        if(!v.fresh(context.now))return if(v.checkedAt!=null)CheckoutProblem.CREDIT_EXPOSURE_STALE else CheckoutProblem.CREDIT_EXPOSURE_UNKNOWN
        if(v.status=="over")return CheckoutProblem.CREDIT_LIMIT_EXCEEDED
        return if(v.freshness=="stale"||v.expiresAt?.let{it<=context.now}==true)CheckoutProblem.CREDIT_EXPOSURE_STALE else CheckoutProblem.CREDIT_EXPOSURE_UNKNOWN
    }
}
