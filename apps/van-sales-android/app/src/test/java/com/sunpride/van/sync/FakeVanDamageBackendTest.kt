package com.sunpride.van.sync

import com.sunpride.van.storage.OutboxRow
import com.sunpride.van.device.*
import kotlinx.coroutines.runBlocking
import org.json.*
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class FakeVanDamageBackendTest {
    private fun backend(scale: Long = 1): FakeVanBackend {
        val o = JSONObject(FakeVanBackend.FIXTURE)
        o.getJSONObject("trip").put("status","active")
        val product = o.getJSONArray("products").getJSONObject(0); product.put("quantityScale",scale.toString())
        o.put("truckStock",JSONArray().put(JSONObject().put("productId",product.getString("productId")).put("availableBase",(48*scale).toString()).put("damagedBase","0")))
        return FakeVanBackend(o.toString())
    }
    private fun row(qty: Long, reason: String, sha: String? = null): OutboxRow {
        val id = UUID.randomUUID().toString(); val b = VanBootstrapCodec.decode(FakeVanBackend.FIXTURE)
        val payload = JSONObject().put("tripId",b.trip!!.tripId).put("productId",b.products.first().productId).put("quantityBase",qty.toString()).put("reason",reason).put("deviceTime",1)
        sha?.let { payload.put("photoSha256",it) }
        return OutboxRow("issuer|seller","device",id,b.trip.tripId,"truck.damage",JSONObject().put("kind","truck.damage").put("clientRequestId",id).put("payload",payload).toString(),1)
    }
    private fun jpeg(): ByteArray = java.util.Base64.getDecoder().decode(JSONObject(javaClass.classLoader!!.getResourceAsStream("evidence-request.json")!!.bufferedReader().readText()).getString("dataBase64"))
    @Test fun requiredMissingOrNotUploadedPhotoIsRejected() = runBlocking {
        val backend = backend()
        assertEquals("photo_required",backend.push(listOf(row(1,"crushed"))).single().code)
        assertEquals("photo_required",backend.push(listOf(row(12,"expired","a".repeat(64)))).single().code)
        assertEquals("0",JSONObject(backend.bootstrap()).getJSONArray("truckStock").getJSONObject(0).getString("damagedBase")); Unit
    }
    @Test fun evidenceIsIdempotentAndDamageAckIdentifiesRecordAndScaledApproval() = runBlocking {
        val backend = backend(1000); val jpeg = jpeg(); val sha = hex(sha256(jpeg))
        backend.evidence(sha,jpeg); backend.evidence(sha,jpeg)
        val row = row(12000,"expired",sha); val result = backend.push(listOf(row)).single()
        assertEquals("accepted",result.status); assertNotEquals(row.tripId,result.ack!!.entityId)
        assertEquals(result,backend.push(listOf(row)).single())
        val history = VanBootstrapCodec.decode(backend.bootstrap()).damageRecords
        assertEquals(history.sortedByDescending { it.recordedAt },history)
        val record = history.first()
        assertEquals(result.ack.entityId,record.damageId); assertEquals("pending_approval",record.status)
        assertEquals(12000L,record.quantityBase); Unit
    }
}
