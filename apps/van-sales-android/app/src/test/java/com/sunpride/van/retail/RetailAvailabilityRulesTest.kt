package com.sunpride.van.retail

import com.sunpride.retail.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** F-211/212/213/217/218/219: the same production DTO/rules are compiled into both native apps. */
class RetailAvailabilityRulesTest {
    private fun snapshot() = JSONObject("""{
      "version":"availability/2026-10-v1","setupNeeded":false,"snapshotId":"snapshot-test",
      "outletId":"outlet-test","serviceDate":"2026-10-20","sample":true,
      "msl":{"id":"msl-test","label":"Sample neighbourhood MSL"},
      "lines":[
        {"productId":"absent","code":"MSL-1","name":"Must-stock one","uom":"PC","quantityScale":1,
         "required":true,"minimumBase":3,"quantityBase":0,"reasons":["MSL minimum: 3 base units","Focus SKU: launch priority"],
         "objective":"Build first order","barcodes":["4800000000001"]},
        {"productId":"present","code":"MSL-2","name":"Must-stock two","uom":"PC","quantityScale":1,
         "required":true,"minimumBase":1,"quantityBase":6,"reasons":["Days of cover: replenish 6 base units"],"barcodes":["4800000000002"]},
        {"productId":"optional","code":"FOCUS","name":"Optional focus","uom":"PC","quantityScale":1,
         "required":false,"minimumBase":1,"quantityBase":2,"reasons":["Open promotion: introductory pack"],"barcodes":[]}
      ]} """)
    private fun call() = requireNotNull(RetailAvailability.decode(snapshot()))
    private fun answers() = listOf(ShelfAnswer("absent","absent",shelfBase=0,backroomBase=2),
        ShelfAnswer("present","present","scan",shelfBase=4,backroomBase=7))

    @Test fun F212_everyRequiredSkuNeedsAnExplicitPresentOrAbsentAnswer() {
        val c = call()
        assertFalse(RetailAvailability.complete(c,emptyList()))
        assertFalse(RetailAvailability.complete(c,listOf(ShelfAnswer("absent","absent"))))
        assertFalse(RetailAvailability.complete(c,listOf(ShelfAnswer("absent","absent"),ShelfAnswer("present"))))
        assertFalse(RetailAvailability.complete(c,answers()+answers().first()))
        assertTrue(RetailAvailability.complete(c,answers())) // optional focus is not an MSL obligation
        assertThrows(IllegalArgumentException::class.java) { RetailAvailability.validate(c,answers().take(1)) }
        assertFalse(RetailAvailability.complete(c.copy(lines=c.lines.filterNot { it.required }),emptyList()))
    }
    @Test fun F217_invalidCountsMethodsAndForeignAnswersCannotBeSaved() {
        val c=call()
        val bad=listOf(
            answers().map { if(it.productId=="absent")it.copy(shelfBase=1)else it },
            answers().map { if(it.productId=="present")it.copy(shelfBase=0)else it },
            answers().map { it.copy(method="keyboard") },
            answers().map { it.copy(backroomBase=-1) },
            answers().map { it.copy(backroomBase=1_000_000_001) },
            answers()+ShelfAnswer("foreign","present"))
        bad.forEach { a -> assertThrows(IllegalArgumentException::class.java) { RetailAvailability.validate(c,a) } }
        RetailAvailability.validate(c,answers().map { it.copy(backroomBase=1_000_000_000) })
    }
    @Test fun F213_absentSkuUsesMinimumEvenWhenServerSuggestionIsZero() {
        val c=call(); val absent=c.required.first()
        assertEquals(3L,RetailAvailability.proposed(absent,answers().first()))
        assertEquals(9L,RetailAvailability.proposed(absent.copy(suggestedBase=9),answers().first()))
        assertEquals(0L,RetailAvailability.proposed(absent,ShelfAnswer("absent","present")))
        assertEquals(6L,RetailAvailability.proposed(c.required.last(),answers().last()))
    }
    @Test fun F212_scanOnlyResolvesUniqueRequiredProducts() {
        val c=call()
        assertEquals("absent",RetailAvailability.scan(c,"4800000000001")?.productId)
        assertEquals("present",RetailAvailability.scan(c,"MSL-2")?.productId)
        assertNull(RetailAvailability.scan(c,"FOCUS")); assertNull(RetailAvailability.scan(c,"unknown"))
        val ambiguous=c.copy(lines=c.lines.map { it.copy(barcodes=listOf("same")) })
        assertNull(RetailAvailability.scan(ambiguous,"same"))
    }
    @Test fun F218_F219_recommendationReasonsAndObjectivesSurviveSnapshotDecoding() {
        val c=call()
        assertEquals("availability/2026-10-v1",snapshot().getString("version"))
        assertTrue(c.sample); assertEquals("Sample neighbourhood MSL",c.label)
        assertEquals(listOf("MSL minimum: 3 base units","Focus SKU: launch priority"),c.lines.first().reasons)
        assertEquals("Build first order",c.lines.first().objective)
        assertEquals("Days of cover: replenish 6 base units",c.lines[1].reasons.single())
        assertEquals("Open promotion: introductory pack",c.lines[2].reasons.single())
    }
    @Test fun F212_F217_completePayloadRetainsShelfBackroomAndCaptureMethod() {
        val p=RetailAvailability.payload(call(),answers(),"check-id","call-key",123)
        assertEquals("snapshot-test",p.getString("snapshotId")); assertEquals("check-id",p.getString("checkId"))
        assertEquals("call-key",p.getString("callKey")); assertEquals(123L,p.getLong("deviceTime")); assertTrue(p.getBoolean("complete"))
        val a=p.getJSONArray("lines")
        assertEquals(2,a.length()); assertEquals(0L,a.getJSONObject(0).getLong("shelfBase"))
        assertEquals(2L,a.getJSONObject(0).getLong("backroomBase")); assertEquals("scan",a.getJSONObject(1).getString("method"))
        val unknown=RetailAvailability.payload(call(),answers().map { it.copy(backroomBase=null) },"c","k",123)
        assertTrue(unknown.getJSONArray("lines").getJSONObject(0).isNull("backroomBase"))
    }
    @Test fun F211_setupNeededAndMissingMslDoNotInventAnAssignment() {
        assertNull(RetailAvailability.decode(snapshot().put("setupNeeded",true)))
        assertNull(RetailAvailability.decode(snapshot().put("msl",JSONObject.NULL)))
        assertThrows(IllegalArgumentException::class.java) { RetailAvailability.decode(snapshot().put("version","availability/future")) }
    }
    @Test fun F211_malformedSnapshotCannotEnterTheChecklist() {
        val empty=snapshot().put("lines",JSONArray())
        assertThrows(IllegalArgumentException::class.java) { RetailAvailability.decode(empty) }
        val duplicate=snapshot().also { it.getJSONArray("lines").getJSONObject(1).put("productId","absent") }
        assertThrows(IllegalArgumentException::class.java) { RetailAvailability.decode(duplicate) }
        for ((key,value) in listOf("quantityScale" to 0,"minimumBase" to 0,"quantityBase" to -1)) {
            val invalid=snapshot().also { it.getJSONArray("lines").getJSONObject(0).put(key,value) }
            assertThrows(IllegalArgumentException::class.java) { RetailAvailability.decode(invalid) }
        }
    }
}
