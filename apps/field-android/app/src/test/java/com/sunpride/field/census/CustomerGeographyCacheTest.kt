package com.sunpride.field.census

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CustomerGeographyCacheTest {
    private fun pack(postal: Boolean) = JSONObject().put("regions", JSONArray())
        .put("provinces", JSONArray()).put("municipalities", JSONArray())
        .put("postalCodes", JSONArray().apply {
            if (postal) put(JSONObject().put("municipalityCode", "0702210000").put("code", "6036"))
        }).toString()

    @Test fun freshThirtyDayCacheDoesNotHideNewPostalEntries() = runBlocking {
        val old = pack(false); val updated = pack(true)
        var saved: String? = null; var calls = 0
        val loaded = CustomerGeographyCache.load("pack", 1000, old, 999,
            fetch = { calls++; updated }, save = { saved = it })
        assertEquals(1, calls)
        assertEquals(updated, saved)
        val geography = CustomerCapture.Geography.parse(JSONObject(loaded!!))
        assertEquals(listOf("6036"), geography.postalCodesOf("0702210000"))
        assertEquals("6036", CustomerCapture.Form().withMunicipality("0702210000", geography).postalCode)
        assertTrue(geography.postalCodesOf("0702243000").isEmpty())
    }

    @Test fun correctedPostalPackRemainsUsableOffline() = runBlocking {
        val updated = pack(true)
        val loaded = CustomerGeographyCache.load("pack", 1000, updated, 999,
            fetch = { throw IllegalStateException("offline") }, save = { fail("No download to save") })
        assertEquals(updated, loaded)
        assertNull(CustomerGeographyCache.load("pack", 1000, null, null,
            fetch = { throw IllegalStateException("offline") }, save = {}))
    }

    @Test fun barangaysKeepTheirCacheAndRefreshOnlyWhenExpired() = runBlocking {
        assertEquals("cached", CustomerGeographyCache.load("brgy:0702200000", 1000, "cached", 999,
            fetch = { fail("Do not download every barangay list"); "unused" }, save = {}))
        assertEquals("updated", CustomerGeographyCache.load("brgy:0702200000", 31L * 24 * 3600_000, "cached", 0,
            fetch = { "updated" }, save = {}))
    }

    @Test fun cacheWriteFailureDoesNotHideTheDownloadedPostalEntries() = runBlocking {
        assertEquals("updated", CustomerGeographyCache.load("pack", 1000, "old", 999,
            fetch = { "updated" }, save = { throw IllegalStateException("disk full") }))
    }

    @Test fun cancellationDoesNotContinueWithAnOldPack() = runBlocking {
        try {
            CustomerGeographyCache.load("pack", 1000, "old", 999,
                fetch = { throw CancellationException("cancelled") }, save = {})
            fail("Cancellation must propagate")
        } catch (_: CancellationException) { /* expected */ }
    }
}
