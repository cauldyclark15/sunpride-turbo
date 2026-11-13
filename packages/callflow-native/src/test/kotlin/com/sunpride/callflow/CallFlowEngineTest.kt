package com.sunpride.callflow

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** F-006: these SAME tests run in each app's JVM suite. Native storage is tested separately on phones. */
class CallFlowEngineTest {
    private fun step(adapter: String, required: Boolean = false, condition: String = "always") = JSONObject()
        .put("key",adapter).put("adapter",adapter).put("label",adapter.replace('_',' ')).put("required",required).put("condition",condition)
    private fun config() = JSONObject().put("definition",JSONObject().put("id","sample-definition").put("version",1).put("label","Sample field flow")
        .put("steps",JSONArray().put(step("check_in",true)).put(step("stock_check",true)).put(step("order_build"))
            .put(step("invoice",true,"has_order")).put(step("note")).put(step("check_out",true))))
        .put("policy",JSONObject().put("radiusMeters",100).put("maxAccuracyMeters",50).put("maxFixAgeMs",60000).put("minDwellMs",180000))
        .put("pin",JSONObject().put("latitude",10.33).put("longitude",123.94))
        .put("reasons",JSONArray().put(JSONObject().put("code","no_demand").put("label","No demand today")))
    private fun fix(at: Long = 1_000_000) = JSONObject().put("latitude",10.33).put("longitude",123.94).put("accuracyMeters",5)
        .put("fixTime",at).put("mockSignal",false).put("provider","gps")
    private fun refused(block: () -> Unit) { try { block(); fail("Expected a call-flow refusal") } catch (_: CallFlowRefused) {} }
    // agent1 SMP-C0293: a merchandiser call takes no order, so End never waits for a no-order reason (its frozen list
    // may even be empty); a selling call still needs one.
    @Test fun `merchandiser call ends without a no-order reason`() {
        val merch = config().apply { getJSONObject("definition").put("channelProfile","merchandiser"); put("reasons",JSONArray()) }
        assertTrue(CallFlowEngine.executionOnly(merch))
        assertFalse(CallFlowEngine.missingNoOrderReason(merch,false,null))
        assertTrue(CallFlowEngine.missingNoOrderReason(config(),false,null))
        assertFalse(CallFlowEngine.executionOnly(null))
    }
    @Test fun `F-106 verified in-radius fresh fix works offline`() { CallFlowEngine.location(config(),fix(),1_000_000) }
    @Test fun `F-106 outside radius requires prior approval`() {
        refused { CallFlowEngine.location(config(),fix().put("latitude",11),1_000_000) }
        CallFlowEngine.location(config(),fix().put("latitude",11),1_000_000,true)
    }
    @Test fun `FLD-084 only the outside-radius refusal offers the supervisor request`() {
        val outside = try { CallFlowEngine.location(config(),fix().put("latitude",11),1_000_000); null } catch (e: CallFlowRefused) { e.message }
        org.junit.Assert.assertTrue(CallFlowEngine.outsideRadius(outside))
        val stale = try { CallFlowEngine.location(config(),fix(1),1_000_000); null } catch (e: CallFlowRefused) { e.message }
        org.junit.Assert.assertFalse(CallFlowEngine.outsideRadius(stale))
    }
    @Test fun `F-106 mock and unknown integrity flags never use an outside exception`() {
        refused { CallFlowEngine.location(config(),fix().put("mockSignal",true),1_000_000,true) }
        refused { CallFlowEngine.location(config(),fix().put("integrityBlocked",true),1_000_000,true) }
        refused { CallFlowEngine.location(config(),fix().apply { remove("mockSignal") },1_000_000,true) }
    }
    @Test fun `NF-3 a reported mock is refused unless the dev bench switch is on`() {
        val mock = AndroidCallLocation.fixJson(10.33,123.94,5.0,1_000_000,"gps",reportedMock = true,benchTestProvider = false)
        refused { CallFlowEngine.location(config(),mock,1_000_000) }
        val bench = AndroidCallLocation.fixJson(10.33,123.94,5.0,1_000_000,"gps",reportedMock = true,benchTestProvider = true)
        CallFlowEngine.location(config(),bench,1_000_000)
        assertEquals(false,AndroidCallLocation.fixJson(10.33,123.94,5.0,1,"fused",false,false).get("mockSignal"))
        assertEquals("unknown",AndroidCallLocation.fixJson(10.33,123.94,5.0,1,"test",false,false).getString("provider"))
    }
    @Test fun `F-106 bad accuracy old fix and absent pin fail closed`() {
        refused { CallFlowEngine.location(config(),fix().put("accuracyMeters",51),1_000_000) }
        refused { CallFlowEngine.location(config(),fix(1),1_000_000) }
        refused { CallFlowEngine.location(config().apply { remove("pin") },fix(),1_000_000) }
    }
    @Test fun `FLD-080 no fix at all starts the call for supervisor review, a mock still does not`() {
        assertFalse("No fix uses no radius exception", CallFlowEngine.location(config(),null,1_000_000))
        assertFalse(CallFlowEngine.location(config(),null,1_000_000,true))
        refused { CallFlowEngine.location(config(),fix().put("mockSignal",true),1_000_000) }
        refused { CallFlowEngine.location(config(),fix().put("latitude",11),1_000_000) }
    }
    @Test fun `FLD-105 a call without an order needs a listed no-order reason before End`() {
        assertTrue(CallFlowEngine.missingNoOrderReason(config(),false,""))
        assertTrue(CallFlowEngine.missingNoOrderReason(config(),false,"made_up"))
        assertFalse(CallFlowEngine.missingNoOrderReason(config(),false,"no_demand"))
        assertFalse(CallFlowEngine.missingNoOrderReason(config(),true,null))
    }
    @Test fun `F-107 required stock check blocks later order adapter`() { refused { CallFlowEngine.advance(config(),setOf("check_in"),"order_build",true) } }
    @Test fun `F-107 optional steps may be skipped while required conditional invoice cannot`() {
        refused { CallFlowEngine.advance(config(),setOf("check_in","stock_check","order_build"),"check_out",true) }
        CallFlowEngine.advance(config(),setOf("check_in","stock_check"),"check_out",false)
    }
    @Test fun `F-107 authoritative repeated adapter is stable`() { CallFlowEngine.advance(config(),setOf("check_in","stock_check"),"stock_check",false) }
    @Test fun `F-107 future merchandiser uses same progression engine`() {
        val c=config(); c.getJSONObject("definition").getJSONArray("steps").put(1,step("planogram",true))
        refused { CallFlowEngine.advance(c,setOf("check_in"),"order_build",true) }
        CallFlowEngine.advance(c,setOf("check_in"),"planogram",false)
    }
    @Test fun `F-120 zero orders require controlled reason even completed outcome`() {
        val p=JSONObject().put("deviceTime",1_180_000).put("outcome","completed")
        refused { CallFlowEngine.close(config(),setOf("check_in","stock_check"),false,1_000_000,p) }
        p.put("zeroSaleReason","invented"); refused { CallFlowEngine.close(config(),setOf("check_in","stock_check"),false,1_000_000,p) }
        p.put("zeroSaleReason","no_demand"); CallFlowEngine.close(config(),setOf("check_in","stock_check"),false,1_000_000,p)
    }
    @Test fun `F-207 short call needs reason under snapshotted dwell policy`() {
        val p=JSONObject().put("deviceTime",1_001_000).put("zeroSaleReason","no_demand")
        refused { CallFlowEngine.close(config(),setOf("check_in","stock_check"),false,1_000_000,p) }
        p.put("shortCallReason","Buyer left"); CallFlowEngine.close(config(),setOf("check_in","stock_check"),false,1_000_000,p)
    }
    @Test fun `F-207 negative dwell never accepted`() { refused { CallFlowEngine.close(config(),setOf("check_in","stock_check"),false,1_000_000,JSONObject().put("deviceTime",1)) } }
    @Test fun `F-106 end approval stays bound to the open call policy after publication`() {
        val renewed=config();renewed.getJSONObject("policy").put("id","new-policy")
        renewed.put("geofenceApprovals",JSONArray().put(JSONObject().put("id","grant").put("policyId","old-policy").put("kind","geofence_end").put("approvedAt",900_000).put("expiresAt",1_100_000)))
        assertNull(CallFlowEngine.approval(renewed,"geofence_end",1_000_000))
        assertEquals("grant",CallFlowEngine.approval(renewed,"geofence_end",1_000_000,emptySet(),"old-policy"))
        assertNull(CallFlowEngine.approval(renewed,"geofence_end",1_000_000,setOf("grant"),"old-policy"))
        assertFalse("An in-radius call must not consume an unused exception",CallFlowEngine.location(config(),fix(),1_000_000,true))
        assertTrue(CallFlowEngine.location(config(),fix().put("latitude",11),1_000_000,true))
    }
}
