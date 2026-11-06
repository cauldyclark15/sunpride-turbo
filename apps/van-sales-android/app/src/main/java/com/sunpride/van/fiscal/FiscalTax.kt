package com.sunpride.van.fiscal

import com.sunpride.van.pos.QuotedLine
import org.json.JSONArray
import org.json.JSONObject
import java.math.BigInteger

/** F-109: fiscal reporting of the governed selling quote, never a second price engine. */
object FiscalTax {
    /** IP-HH2: how each quoted line is taxed, from the downloaded selling tax rows (same lookup as [snapshot]); null when no row matches. */
    fun facts(fiscal: JSONObject, at: Long): (QuotedLine, String?) -> com.sunpride.van.selling.TaxFact? {
        val rows = fiscal.optJSONArray("taxQuotes") ?: return { _, _ -> null }
        val all = (0 until rows.length()).map { rows.getJSONObject(it) }
        return { line, customerPriceListId ->
            val listId = line.priceListId ?: customerPriceListId
            all.filter { q -> q.getString("priceListId") == listId && q.getString("productId") == line.product.productId && q.getString("uomCode") == line.product.uomCode &&
                q.getLong("effectiveFrom") <= at && (q.isNull("effectiveTo") || at < q.getLong("effectiveTo")) }.singleOrNull()
                ?.let { com.sunpride.van.selling.TaxFact(it.getString("treatment"), it.getInt("taxBasisPoints")) }
        }
    }

    /**
     * IP-HH2: the tax snapshot of a sale with a statutory discount. Buckets are shown BEFORE the discount (BIR convention), so
     * vatable + vat + exempt + zero = amount payable + privilege discount. `totalMinor` is what the customer pays.
     */
    fun snapshotWithDiscount(lines: List<QuotedLine>, facts: (QuotedLine, String?) -> com.sunpride.van.selling.TaxFact?, customerPriceListId: String?): JSONObject {
        var vatable = 0L; var vat = 0L; var exempt = 0L; var zero = 0L; var total = 0L; var priv = 0L; var removed = 0L
        val rates = mutableSetOf<Int>(); val details = JSONArray()
        lines.forEachIndexed { index, line ->
            val r = checkNotNull(line.legal) { "Discount lines are missing" }
            val tax = facts(line, customerPriceListId)
            vatable += r.vatable; vat += r.vat; exempt += r.vatExempt; zero += r.zeroRated; total += r.net; priv += r.privilegeDiscount; removed += r.vatRemoved
            if (tax?.treatment == "vatable") rates += tax.vatBps
            details.put(JSONObject().put("lineNumber", index + 1).put("treatment", tax?.treatment ?: "vatable").put("rateBasisPoints", tax?.vatBps ?: 0)
                .put("totalMinor", r.net.toString()).put("privilegeDiscountMinor", r.privilegeDiscount.toString()).put("vatRemovedMinor", r.vatRemoved.toString()))
        }
        check(vatable + vat + exempt + zero == total + priv) { "Discount tax buckets do not add up" }
        return JSONObject().put("inclusive", true).put("rateBasisPoints", if (rates.size == 1) rates.single() else if (rates.isEmpty()) 0 else JSONObject.NULL)
            .put("vatableSalesMinor", vatable.toString()).put("vatMinor", vat.toString()).put("vatExemptMinor", exempt.toString()).put("zeroRatedMinor", zero.toString())
            .put("privilegeDiscountMinor", priv.toString()).put("vatRemovedMinor", removed.toString()).put("totalMinor", total.toString()).put("lines", details)
    }
    fun snapshot(lines:List<QuotedLine>,fiscal:JSONObject,customerPriceListId:String?,at:Long):JSONObject {
        require(fiscal.getInt("taxVersion")==1&&lines.isNotEmpty()&&lines.size<=100)
        val rows=fiscal.getJSONArray("taxQuotes");require(rows.length()<=600)
        var vatable=BigInteger.ZERO;var vat=BigInteger.ZERO;var exempt=BigInteger.ZERO;var zero=BigInteger.ZERO;var total=BigInteger.ZERO
        val rates=mutableSetOf<Int>();val details=JSONArray()
        lines.forEachIndexed {index,line->
            val listId=line.priceListId?:customerPriceListId
            val quote=(0 until rows.length()).map{rows.getJSONObject(it)}.filter{q->
                q.getString("priceListId")==listId&&q.getString("productId")==line.product.productId&&q.getString("uomCode")==line.product.uomCode&&
                    q.getLong("effectiveFrom")<=at&&(q.isNull("effectiveTo")||at<q.getLong("effectiveTo"))}.single()
            val kind=quote.getString("treatment");val bps=quote.getInt("taxBasisPoints")
            require(kind in listOf("vatable","exempt","zero_rated")&&bps in 0..10000&&(kind=="vatable")== (bps>0))
            val gross=BigInteger.valueOf(line.totalMinor);require(gross.signum()>=0)
            var net=gross
            if(kind=="vatable"){
                if(!quote.getBoolean("sourceTaxInclusive")){
                    val sourceGross=quote.getString("sourceSellingUnitMinor").toBigInteger();val sourceNet=quote.getString("sourceNetUnitMinor").toBigInteger()
                    require(sourceGross.signum()>=0&&sourceNet.signum()>=0&&sourceNet<=sourceGross&&(sourceGross.signum()>0||sourceNet.signum()==0&&gross.signum()==0))
                    net=if(sourceGross.signum()==0)BigInteger.ZERO else (gross*sourceNet+sourceGross/BigInteger.valueOf(2))/sourceGross
                }else{
                    val denominator=BigInteger.valueOf(10000L+bps)
                    net=(gross*BigInteger.valueOf(10000)+denominator/BigInteger.valueOf(2))/denominator
                }
                vatable+=net;vat+=gross-net;rates+=bps
            }else if(kind=="exempt")exempt+=gross else zero+=gross
            total+=gross
            details.put(JSONObject().put("lineNumber",index+1).put("treatment",kind).put("taxCode",quote.getString("taxCode"))
                .put("rateBasisPoints",bps).put("netMinor",net.toString()).put("vatMinor",if(kind=="vatable")(gross-net).toString() else "0")
                .put("totalMinor",gross.toString()).put("sourceKey",quote.opt("sourceKey")?:JSONObject.NULL).put("sourceVersion",quote.opt("sourceVersion")?:JSONObject.NULL))
        }
        require(vatable+vat+exempt+zero==total)
        return JSONObject().put("inclusive",true).put("rateBasisPoints",if(rates.size==1)rates.single() else if(rates.isEmpty())0 else JSONObject.NULL)
            .put("vatableSalesMinor",vatable.toString()).put("vatMinor",vat.toString()).put("vatExemptMinor",exempt.toString()).put("zeroRatedMinor",zero.toString())
            .put("totalMinor",total.toString()).put("lines",details)
    }
}
