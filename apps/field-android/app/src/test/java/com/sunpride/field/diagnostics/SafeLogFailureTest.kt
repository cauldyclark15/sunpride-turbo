package com.sunpride.field.diagnostics

import org.junit.Assert.*
import org.junit.Test

/** NF-4: a swallowed photo failure is described for Logcat by type and masked message only. */
class SafeLogFailureTest {
    @Test fun describesTheCauseWithoutPersonalData() {
        val line = SafeLog.describe("photo_save_failed",
            IllegalStateException("Missing verified person name", IllegalArgumentException("owner a.b@example.com at 10.25283,123.84588")))
        assertTrue(line, line.startsWith("photo_save_failed IllegalStateException: Missing verified person name"))
        assertTrue(line, line.contains("IllegalArgumentException"))
        assertFalse(line, line.contains("example.com"))
        assertFalse(line, line.contains("10.25283"))
    }
    @Test fun photoSaveFailureIsAnAdmittedCode() = assertTrue("photo_save_failed" in SafeLog.codes)
}
