package com.sunpride.field.census

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CustomerPostalPackTest {
    private val old = """{"postalCodes":[{"code":"6000"}]}"""
    private val current = """{"postalAreasVersion":1,"postalCodes":[{"code":"6000","area":"Apas"}]}"""

    @Test fun oldPackIsUpgradedAndSavedBeforeTheAreaIsUsed() = runBlocking {
        var saved: String? = null
        val result = CustomerPostalPack.upgrade(old, { current }, { saved = it })
        assertEquals(current, result)
        assertEquals(current, saved)
        assertEquals("Apas", JSONObject(result).getJSONArray("postalCodes").getJSONObject(0).getString("area"))
    }

    @Test fun currentPackDoesNotCauseAnotherDownloadOrWrite() = runBlocking {
        var downloads = 0
        var writes = 0
        assertEquals(current, CustomerPostalPack.upgrade(current,
            { downloads++; current }, { writes++ }))
        assertEquals(0, downloads)
        assertEquals(0, writes)
    }

    @Test fun offlineOrOldServerKeepsTheAvailablePack() = runBlocking {
        var writes = 0
        for (fetch in listOf<() -> String>({ throw java.io.IOException("offline") }, { old }, { "not json" })) {
            assertEquals(old, CustomerPostalPack.upgrade(old, fetch, { writes++ }))
        }
        assertEquals(0, writes)
    }

    @Test fun failedCacheWriteStillUsesTheFreshAreaNames() = runBlocking {
        assertEquals(current, CustomerPostalPack.upgrade(old, { current }, { throw java.io.IOException("cache unavailable") }))
    }

    @Test fun cancellationIsNotConvertedToAnOfflineFallback() = runBlocking {
        for (duringSave in listOf(false, true)) {
            var cancelled = false
            try {
                CustomerPostalPack.upgrade(old,
                    { if (!duringSave) throw CancellationException("cancelled") else current },
                    { throw CancellationException("cancelled") })
            } catch (_: CancellationException) {
                cancelled = true
            }
            assertTrue(cancelled)
        }
    }
}
