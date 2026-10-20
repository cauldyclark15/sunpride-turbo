package com.sunpride.van.storage

import androidx.room.withTransaction
import com.sunpride.van.ledger.StockProjection
import com.sunpride.van.sync.VanBootstrapCodec
import org.json.JSONArray
import org.json.JSONObject

/** F-122 compose the authorized office baseline with ONLY unreflected immutable local operations. */
class DailyScorecardStore(private val store: RoomVanStore) {
    suspend fun snapshot(): JSONObject = store.db.withTransaction {
        val dao=store.db.rows()
        val s=store.scope.fullAuthSubject
        val d=store.scope.deviceId
        val trip=checkNotNull(dao.trip(s,d))
        val result=JSONObject(RouteOpsStore(store).snapshot()?.optJSONObject("scorecard")?.toString()?:"{}")
        var sales=result.optString("salesCentavos","0").toLong()
        var collected=result.optString("collectedCentavos","0").toLong()
        var refunds=result.optString("refundsCentavos","0").toLong()
        var returns=result.optInt("returnDocuments",0)
        var monthSales=result.optString("monthSalesCentavos","0").toLong()
        val called=mutableSetOf<String>()
        result.optJSONArray("calledOutletIds")?.let {a->for(i in 0 until a.length()) called.add(a.getString(i))}
        val buyers=mutableMapOf<String,Int>()
        result.optJSONArray("productiveOutletCounts")?.let(VanBootstrapCodec::objects)?.forEach {buyers[it.getString("outletId")]=it.getInt("count")}
        val baselineAt=dao.meta(s,d)?.lastBootstrapTime?:0
        val acks=dao.ackRows(s,d).associateBy {it.clientRequestId}
        val rows=dao.outboxRows(s,d).filter {it.tripId==trip.tripId && it.status in setOf("pending","sending","done") && !StockProjection.reflected(acks[it.clientRequestId]?.serverTime,baselineAt)}.sortedBy {it.createdAt}
        val savedSales=dao.saleRows(s,d).associateBy {it.saleId}
        val payments=dao.paymentRows(s,d).associateBy {it.saleId}
        for(row in rows) {
            val p=JSONObject(row.operationJson).getJSONObject("payload")
            when(row.kind) {
                "sale.record" -> {
                    val amount=p.getString("totalMinor").toLong()
                    sales=Math.addExact(sales,amount);monthSales=Math.addExact(monthSales,amount)
                    if(amount>0) {val outlet=p.getJSONObject("customer").getString("outletId");buyers[outlet]=(buyers[outlet]?:0)+1}
                    val payment=p.getJSONObject("payment")
                    if(payment.getString("kind")!="credit") collected=Math.addExact(collected,payment.getString("amountMinor").toLong())
                }
                "sale.void" -> savedSales[p.getString("saleId")]?.let {sale->
                    val amount=checkNotNull(sale.totalMinor)
                    sales=Math.subtractExact(sales,amount);monthSales=Math.subtractExact(monthSales,amount)
                    if(amount>0) buyers[sale.customerId]=(buyers[sale.customerId]?:0)-1
                    payments[sale.saleId]?.takeIf {it.method!="credit"}?.let {collected=Math.subtractExact(collected,it.amountMinor?:amount)}
                }
                "return.record" -> {
                    returns++
                    p.optJSONObject("payment")?.let {payment->val amount=payment.getString("amountMinor").toLong();refunds=Math.addExact(refunds,amount);collected=Math.subtractExact(collected,amount)}
                }
                "payment.record" -> if(p.optString("method")!="credit") collected=Math.addExact(collected,p.getString("amountMinor").toLong())
                "stop.record" -> if(p.getString("phase")=="arrival") called.add(p.getString("outletId"))
            }
        }
        val buying=buyers.filterValues {it>0}.keys
        val complete=buying.all {it in called}
        result.put("salesCentavos",sales.toString()).put("monthSalesCentavos",monthSales.toString()).put("collectedCentavos",collected.toString())
            .put("returnDocuments",returns).put("refundsCentavos",refunds.toString()).put("calls",called.size).put("productiveCalls",buying.count {it in called})
            .put("callFactsComplete",complete).put("strikeRateBasisPoints",if(called.isNotEmpty() && complete) kotlin.math.round(buying.count {it in called}*10000.0/called.size).toInt() else JSONObject.NULL)
            .put("dropSizeCentavos",if(buying.isNotEmpty()) (sales/buying.size).toString() else JSONObject.NULL)
            .put("cashVarianceCentavos",dao.cashReconciliation(s,d,trip.tripId)?.varianceMinor?.toString()?:JSONObject.NULL)
            .put("stockVarianceLines",dao.stockReconciliation(s,d,trip.tripId)?.varianceLines?:JSONObject.NULL)
            .put("calledOutletIds",JSONArray(called.toList())).put("localProjection",rows.isNotEmpty())
        result
    }
}
