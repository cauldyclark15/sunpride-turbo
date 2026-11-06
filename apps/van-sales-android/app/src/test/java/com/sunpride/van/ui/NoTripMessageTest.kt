package com.sunpride.van.ui

import com.sunpride.van.data.HandheldInfo
import org.junit.Assert.*
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime

class NoTripMessageTest {
    private val zone = ZoneId.of("Asia/Manila")
    private fun at(h: Int, m: Int, day: Int = 6) = ZonedDateTime.of(2026,11,day,h,m,0,0,zone).toInstant().toEpochMilli()
    private val full = HandheldInfo("VAN-01","ABC-1234","Juan Dela Cruz","0917 123 4567")

    @Test fun namesTheVanTheSupervisorAndTheLastSync() {
        assertEquals("No trip for today on van ABC-1234. Your supervisor is Juan Dela Cruz (0917 123 4567). Last synced 05:12.",
            NoTripMessage.sentence("No trip",full,at(5,12),at(9,0),zone))
    }
    @Test fun leavesOutWhatTheOfficeHasNotSent() {
        assertEquals("No trip for today. Ask your supervisor. Not synced yet.",NoTripMessage.sentence("No trip",null,null,at(9,0),zone))
        assertEquals("No load sheet for today on van VAN-01. Your supervisor is Juan. Last synced 05:12.",
            NoTripMessage.sentence("No load sheet",HandheldInfo(vehicleCode = "VAN-01",supervisorName = "Juan"),at(5,12),at(9,0),zone))
        assertEquals("No trip for today. Your supervisor's number is 0917. Last synced 05:12.",
            NoTripMessage.sentence("No trip",HandheldInfo(supervisorPhone = "0917"),at(5,12),at(9,0),zone))
    }
    @Test fun anOlderSyncShowsItsDate() {
        assertEquals("Last synced Nov 4, 17:30.",NoTripMessage.lastSynced(at(17,30,4),at(9,0),zone))
    }
    @Test fun dialerGetsOnlyDigitsAndAPlus() {
        assertEquals("tel:09171234567",NoTripMessage.dialUri("0917 123-4567"))
        assertEquals("tel:+639171234567",NoTripMessage.dialUri("+63 917 123 4567"))
        assertNull(NoTripMessage.dialUri(null)); assertNull(NoTripMessage.dialUri("call me")); assertNull(NoTripMessage.dialUri("12"))
        assertNull(NoTripMessage.dialUri("1234+5678"))
    }
}
