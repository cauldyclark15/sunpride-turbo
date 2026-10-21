package com.sunpride.van.pos

import com.sunpride.van.data.Customer
import com.sunpride.van.data.CustomerCredit
import org.json.JSONObject

/** F-404: SAP's exact one-document exception is distinct from the ordinary account limit. */
object SapCreditExceptions {
    fun state(saleId:String,context:CheckoutContext):JSONObject?=runCatching{
        context.policy?.fiscalJson?.let(::JSONObject)?.optJSONObject("sapCreditRequests")?.optJSONObject(saleId)
    }.getOrNull()
    fun approved(request:CheckoutRequest,context:CheckoutContext,total:Long):JSONObject?=runCatching{
        val customer=context.customers.single{it.outletId==request.customerId}
        val fiscal=JSONObject(checkNotNull(context.policy?.fiscalJson));val authority=fiscal.getJSONObject("authority")
        val row=state(request.saleId,context)?:return null
        require(row.getString("phase")=="approved"&&row.getString("status")=="approved")
        require(row.getString("sourceType")=="van_sale"&&row.getString("sourceId")==request.saleId&&row.getLong("amountCentavos")==total)
        require(row.getString("source") in setOf("sample","sap")&&row.getLong("expiresAt")>context.now&&row.getString("reference").isNotBlank())
        require(row.getString("customerCode")==CreditExposure.view(customer,context)?.customerCode)
        require(row.getJSONObject("exposure").getString("orgUnitId")==authority.getString("orgUnitId"))
        val channel=fiscal.getJSONObject("customerChannels").getString(customer.outletId)
        require(ManualDiscounts.rule(authority,"credit",channel,total,context.now)!=null)
        row
    }.getOrNull()
    fun credit(request:CheckoutRequest,context:CheckoutContext,total:Long):CustomerCredit?=runCatching{
        approved(request,context,total)?:return null
        val buyer=context.customers.single{it.outletId==request.customerId}
        // Sync existing credit first: a provider approval does not cover still-unreported invoices.
        require((context.creditUsedMinor[buyer.outletId]?:0L)==0L)
        val row=JSONObject(checkNotNull(context.policy?.fiscalJson)).getJSONObject("creditSnapshots").getJSONObject(buyer.outletId)
        val days=row.getInt("termsDays");require(days in 1..180)
        val local=row.getString("localLimitMinor").toLong();require(local>=0)
        CustomerCredit(days,local)
    }.getOrNull()
}
