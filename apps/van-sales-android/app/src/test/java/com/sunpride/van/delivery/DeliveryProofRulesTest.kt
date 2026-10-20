package com.sunpride.van.delivery

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class DeliveryProofRulesTest {
    private fun drop()=JSONObject().put("dropId","drop").put("outletId","store")
        .put("lines",JSONArray().put(JSONObject().put("lineId","line").put("expectedBase",10)))
        .put("reasons",JSONArray().put(JSONObject().put("code","buyer_rejected")))
    private fun payload()=JSONObject().put("dropId","drop").put("receiverName","Sample buyer")
        .put("signature",JSONArray("[[0.1,0.2],[0.8,0.7]]")).put("lines",DeliveryProofRules.fullLines(drop()))
        .put("photoSha256","a".repeat(64)).put("deviceTime",1)
        .put("watermark",JSONObject().put("version",1).put("outletId","store").put("capturedAt",1))
    @Test fun `F-303 full delivery requires signature and a watermarked photo reference`() {
        DeliveryProofRules.validate(drop(),payload())
        assertThrows(IllegalArgumentException::class.java) { DeliveryProofRules.validate(drop(),payload().put("signature",JSONArray())) }
        assertThrows(IllegalArgumentException::class.java) { DeliveryProofRules.validate(drop(),payload().put("photoSha256","not-a-digest")) }
    }
    @Test fun `F-304 short rejected and damaged quantities partition the exact allocated base pieces`() {
        val p=payload();p.getJSONArray("lines").getJSONObject(0).put("acceptedBase",7).put("shortBase",1).put("rejectedBase",1).put("damagedBase",1).put("reason","buyer_rejected")
        DeliveryProofRules.validate(drop(),p)
        p.getJSONArray("lines").getJSONObject(0).put("acceptedBase",8)
        assertThrows(IllegalArgumentException::class.java) { DeliveryProofRules.validate(drop(),p) }
    }
    @Test fun `F-304 a variance cannot use arbitrary reasons or negative pieces`() {
        val p=payload();p.getJSONArray("lines").getJSONObject(0).put("acceptedBase",9).put("rejectedBase",1).put("reason","free_text")
        assertThrows(IllegalArgumentException::class.java) { DeliveryProofRules.validate(drop(),p) }
        p.getJSONArray("lines").getJSONObject(0).put("rejectedBase",-1)
        assertThrows(IllegalArgumentException::class.java) { DeliveryProofRules.validate(drop(),p) }
    }
    @Test fun `F-308 departure stays available after proof and timings reject duplicates or reversed order`() {
        val d=drop().put("status","scheduled")
        assertThrows(IllegalArgumentException::class.java) { DeliveryProofRules.validateTiming(d,"unloading",2,"") }
        DeliveryProofRules.validateTiming(d,"arrival",1,"");d.put("arrivedAt",1)
        assertThrows(IllegalArgumentException::class.java) { DeliveryProofRules.validateTiming(d,"arrival",2,"") }
        DeliveryProofRules.validateTiming(d,"unloading",2,"");d.put("unloadingAt",2)
        assertThrows(IllegalArgumentException::class.java) { DeliveryProofRules.validateTiming(d,"departure",3,"") }
        d.put("status","saved_on_phone");DeliveryProofRules.validateTiming(d,"departure",3,"")
        d.put("departedAt",3)
        assertThrows(IllegalArgumentException::class.java) { DeliveryProofRules.validateTiming(d,"departure",4,"") }
    }
    @Test fun `F-308 an outside-window arrival requires a recorded reason`() {
        val d=drop().put("windowStart",10).put("windowEnd",20)
        assertThrows(IllegalArgumentException::class.java) { DeliveryProofRules.validateTiming(d,"arrival",9,"") }
        DeliveryProofRules.validateTiming(d,"arrival",9,"Buyer asked us to arrive early")
    }
    @Test fun `F-303 proof identity and capture time cannot switch drop or outlet`() {
        assertThrows(IllegalArgumentException::class.java) { DeliveryProofRules.validate(drop(),payload().put("dropId","another")) }
        val p=payload();p.getJSONObject("watermark").put("capturedAt",2)
        assertThrows(IllegalArgumentException::class.java) { DeliveryProofRules.validate(drop(),p) }
    }
}
