package com.sunpride.field.sync

import com.sunpride.callflow.CallFlowEngine
import com.sunpride.field.storage.StoreScope
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class DsrWireTest {
    @Test fun F407_exactSignedRequestResponseUsesTheSameEngineAndImmutableDomainEnvelope(){
        val wire=JSONObject(checkNotNull(javaClass.classLoader!!.getResourceAsStream("dsr-native-v2.json")).bufferedReader().use{it.readText()})
        val me=wire.getJSONObject("me");val response=wire.getJSONObject("response")
        val data=response.getJSONArray("bundles").getJSONObject(0).getJSONObject("data")
        val params=JSONObject().put("distributorId",data.getString("distributorId"))
        val bundle=V2Wire.bundle(response,me,"distributor.bundle",params)
        assertEquals("distributor",me.getJSONObject("profile").getString("role"))
        assertTrue(data.getJSONArray("agenda").length()>0)
        val outlet=data.getJSONArray("outlets").getJSONObject(0).getString("id")
        val config=data.getJSONObject("configuration").getJSONObject("configurations").getJSONObject(outlet)
        CallFlowEngine.validate(config)
        assertEquals("distributor_rep",config.getJSONObject("definition").getString("channelProfile"))
        CallFlowEngine.advance(config,emptySet(),"check_in",false)
        val first=checkNotNull(CallFlowEngine.keyFor(config,"check_in"))
        CallFlowEngine.advance(config,setOf(first),"stock_check",false)
        val all=data.getJSONObject("availability").getJSONObject(outlet)
        assertEquals(1,all.getJSONArray("lines").length())
        // Explicit local test partition surrounds the verbatim API response; /api/me was read without a native key header.
        val scope=StoreScope("test-account","test-device",bundle.getString("scopeFingerprint"))
        val row=DomainOutbox.intent(scope,"dsr.visit.activity",JSONObject().put("distributorId",data.getString("distributorId")).put("localVisitRequestId","test-parent").put("activity",JSONObject().put("kind","note").put("text","SAMPLE coaching")),"test-call",listOf("test-parent"),response.getLong("serverTime"))
        val before=row.serializedOperation
        val op=V2Wire.operation(JSONObject(before));assertEquals(row.requestId,op.getString("clientOpId"));assertEquals("dsr.visit.activity",op.getString("opType"))
        assertEquals("test-parent",op.getJSONArray("dependsOn").getString(0));assertEquals(before,row.serializedOperation)
        val older=DomainOutbox.begin();DomainOutbox.retire();assertFalse(DomainOutbox.current(older))
    }
}
