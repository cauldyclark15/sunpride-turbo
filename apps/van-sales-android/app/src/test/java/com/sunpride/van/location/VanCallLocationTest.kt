package com.sunpride.van.location

import com.sunpride.callflow.AndroidCallLocation
import com.sunpride.callflow.CallFlowEngine
import com.sunpride.callflow.CallFlowRefused
import com.sunpride.van.BuildConfig
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** NF-3: the van call-flow Check in reads the same dev-only bench switch as every other van location reader. */
class VanCallLocationTest {
    private fun step(adapter: String) = JSONObject().put("key",adapter).put("adapter",adapter).put("label",adapter).put("required",true).put("condition","always")
    private val config = JSONObject().put("definition",JSONObject().put("id","d").put("version",1).put("label","Van")
        .put("steps",JSONArray().put(step("check_in")).put(step("check_out"))))
        .put("policy",JSONObject().put("radiusMeters",100).put("maxAccuracyMeters",50).put("maxFixAgeMs",60000).put("minDwellMs",0))
        .put("pin",JSONObject().put("latitude",10.33).put("longitude",123.94)).put("reasons",JSONArray().put(JSONObject().put("code","no_demand").put("label","No demand today")))
    private fun benchFix() = AndroidCallLocation.fixJson(10.33,123.94,5.0,1_000_000,"gps",reportedMock = true,
        benchTestProvider = VanCallLocation.benchTestProvider)

    @Test fun usesTheBuildsBenchSwitch() = assertEquals(BuildConfig.E2E_MOCK_LOCATION, VanCallLocation.benchTestProvider)

    @Test fun releaseFlavorsStillRefuseAMockCheckIn() {
        if (BuildConfig.FLAVOR == "dev") return
        assertFalse("${BuildConfig.FLAVOR} must never accept a mock location", VanCallLocation.benchTestProvider)
        try { CallFlowEngine.location(config, benchFix(), 1_000_000); fail("mock check-in accepted") } catch (_: CallFlowRefused) {}
    }

    @Test fun aRawMockWithoutTheBenchSwitchIsRefusedInEveryFlavor() {
        val mock = AndroidCallLocation.fixJson(10.33,123.94,5.0,1_000_000,"gps",reportedMock = true,benchTestProvider = false)
        try { CallFlowEngine.location(config, mock, 1_000_000); fail("mock check-in accepted") } catch (_: CallFlowRefused) {}
        CallFlowEngine.location(config, AndroidCallLocation.fixJson(10.33,123.94,5.0,1_000_000,"gps",false,false), 1_000_000)
    }

    @Test fun anOptedInBenchBuildChecksInWithTheTestProvider() {
        if (!BuildConfig.E2E_MOCK_LOCATION) return
        assertEquals("dev", BuildConfig.FLAVOR)
        CallFlowEngine.location(config, benchFix(), 1_000_000)
    }
}
