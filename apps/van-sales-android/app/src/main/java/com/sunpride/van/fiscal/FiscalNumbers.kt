package com.sunpride.van.fiscal

import com.sunpride.van.storage.*
import org.json.JSONObject
import java.math.BigInteger
import java.util.UUID

/** F-018/F-019: reserved on the server, consumed ONLY in the checkout Room transaction.
 * The counter is independent of the downloaded snapshot and never reset by rebootstrap. */
object FiscalNumbers {
    data class Issued(val number: String, val allocationId: String, val serial: Long, val registration: JSONObject)
    fun ranges(policy: JSONObject): List<JSONObject> = policy.optJSONObject("fiscal")?.getJSONArray("ranges")?.let { a ->
        (0 until a.length()).map { a.getJSONObject(it) }.also { rows ->
            require(rows.size <= 2 && rows.map { it.getString("documentType") }.distinct().size == rows.size)
            rows.forEach { r ->
                UUID.fromString(r.getString("allocationId")); UUID.fromString(r.getString("seriesId"))
                require(r.getString("firstSerial").toLong() > 0 && r.getString("lastSerial").toLong() >= r.getString("firstSerial").toLong())
                require(r.getString("prefix").matches(Regex("[A-Z0-9-]{1,50}")))
                val registration = r.getJSONObject("registration")
                require(registration.getInt("taxBasisPoints") in 0..10000)
                require(if(registration.getBoolean("sample")) registration.getString("status") == "sample_not_filed" else registration.getString("status") == "approved")
            }
        }
    } ?: emptyList()
    suspend fun issue(db: VanDatabase, scope: StoreScope, policy: JSONObject, type: String, now: Long): Issued {
        val range = ranges(policy).singleOrNull { it.getString("documentType") == type }
            ?: error("Download an authorized document range before selling")
        check(range.getString("deviceId") == scope.deviceId) { "Document range belongs to another handheld" }
        check(range.isNull("effectiveTo") || now < range.getLong("effectiveTo")) { "Fiscal authorization expired" }
        val id = range.getString("allocationId")
        val counterKey = "fiscal:$id"
        val dao = db.rows()
        val local = dao.counter(scope.fullAuthSubject,scope.deviceId,counterKey)?.lastSequence
        val serial = maxOf(local?.let { Math.addExact(it,1) } ?: range.getString("firstSerial").toLong(),range.getString("nextSerial").toLong())
        check(serial <= range.getString("lastSerial").toLong()) { "Document range exhausted; sync before issuing again" }
        dao.insertSequenceCounter(SequenceCounterRow(scope.fullAuthSubject,scope.deviceId,counterKey,serial))
        return Issued("${range.getString("prefix")}-${serial.toString().padStart(9,'0')}",id,serial,range.getJSONObject("registration"))
    }
    fun snapshot(issued: Issued, total: Long, documentType: String = "sales_invoice",providedTax:JSONObject? = null): String {
        require(total>=0)
        val base=JSONObject().put("documentType",documentType).put("documentNumber",issued.number)
            .put("registration",issued.registration).put("allocationId",issued.allocationId).put("serial",issued.serial.toString())
        if(documentType=="official_receipt")return base.put("tax",JSONObject.NULL).put("taxRecognition","payment_application_only").toString()
        if(providedTax!=null){require(providedTax.getString("totalMinor")==total.toString());return base.put("tax",providedTax).toString()}
        val bps = issued.registration.getInt("taxBasisPoints")
        val denominator = BigInteger.valueOf(10000L+bps)
        require(total >= 0)
        val netExact = BigInteger.valueOf(total).multiply(BigInteger.valueOf(10000)).add(denominator.divide(BigInteger.valueOf(2))).divide(denominator)
        check(netExact.bitLength() < 63)
        val net = netExact.toLong()
        return base
            .put("tax",JSONObject().put("rateBasisPoints",bps).put("vatableSalesMinor",if(bps>0) net.toString() else "0")
                .put("vatMinor",if(bps>0) Math.subtractExact(total,net).toString() else "0")
                .put("vatExemptMinor",if(bps==0) total.toString() else "0").put("zeroRatedMinor","0")).toString()
    }
}
