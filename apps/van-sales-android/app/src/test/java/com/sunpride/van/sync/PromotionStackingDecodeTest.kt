package com.sunpride.van.sync

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** The office saves a stackable promotion as `stack`; the van bootstrap must decode it, not fail the sync. */
class PromotionStackingDecodeTest {
    private fun wire(stacking: String) = JSONObject("""{"promotionId":"bd7aa709-7731-4e27-8465-4dfcf35f62ef","code":"SAMPLE-STACK",
        "name":"SAMPLE","priceListId":null,"effectiveFrom":1767225600000,"effectiveTo":null,
        "rule":{"kind":"percent_off","item":{"productId":"00000000-0000-4000-8000-000000000101","uomCode":"EA","quantity":1},"percentOffBasisPoints":500},
        "engineVersion":1,"precedence":30,"exclusionGroup":null,"excludes":[],"outletIds":["00000000-0000-4000-8000-000000000201"]}""")
        .put("stacking", stacking)
    @Test fun officeStackValueDecodes() {
        for (s in listOf("exclusive", "stack", "stackable"))
            assertEquals(s, VanBootstrapCodec.promotion(wire(s)).stacking)
        assertTrue(runCatching { VanBootstrapCodec.promotion(wire("nonsense")) }.isFailure)
        assertNotNull(JSONArray())
    }
}
