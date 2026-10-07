package com.sunpride.van.scanning

import org.junit.Assert.*
import org.junit.Test

/** VAN-009 hardware scanner intents: the H10P action plus documented vendor defaults and a configurable action. */
class ScanIntentProfilesTest {
    private fun extras(vararg pairs: Pair<String, Any?>): (String) -> Any? = { key -> pairs.toMap()[key] }

    @Test fun senraiseH10pBroadcastIsTheVerifiedProfile() {
        assertEquals("4800000000017",ScanIntentProfiles.extract("android.scanner.scan",extras("result" to "4800000000017")))
        assertTrue(ScanIntentProfiles.SUPPORTED.single { it.action == "android.scanner.scan" }.verifiedOnDevice)
    }

    @Test fun vendorStringExtras() {
        assertEquals("A1",ScanIntentProfiles.extract("com.sunmi.scanner.ACTION_DATA_CODE_RECEIVED",extras("data" to "A1")))
        assertEquals("B2",ScanIntentProfiles.extract("nlscan.action.SCANNER_RESULT",extras("SCAN_BARCODE1" to "B2")))
        assertEquals("C3",ScanIntentProfiles.extract("android.intent.action.SCANRESULT",extras("value" to "C3")))
        assertEquals("D4",ScanIntentProfiles.extract("android.intent.ACTION_DECODE_DATA",extras("barcode_string" to "D4")))
    }

    @Test fun configuredActionAcceptsSunprideAndDataWedgeExtras() {
        assertEquals("E5",ScanIntentProfiles.extract(ScanIntentProfiles.SUNPRIDE_ACTION,extras(ScanIntentProfiles.SUNPRIDE_EXTRA to "E5")))
        assertEquals("F6",ScanIntentProfiles.extract(ScanIntentProfiles.SUNPRIDE_ACTION,extras("com.symbol.datawedge.data_string" to "F6")))
    }

    @Test fun byteArrayExtrasHonourTheDeclaredLength() {
        val bytes = "4800000000017\u0000\u0000JUNK".toByteArray()
        assertEquals("4800000000017",ScanIntentProfiles.extract("scan.rcv.message",extras("barocode" to bytes,"length" to 13)))
        // A bogus length falls back to the whole array (trailing NULs removed), never an out-of-range read.
        assertEquals("480",ScanIntentProfiles.extract("scan.rcv.message",extras("barocode" to "480\u0000".toByteArray(),"length" to 99)))
    }

    @Test fun unknownActionsWrongTypesAndEmptyValuesYieldNothing() {
        assertNull(ScanIntentProfiles.extract("com.example.OTHER",extras("result" to "X")))
        assertNull(ScanIntentProfiles.extract(null,extras("result" to "X")))
        assertNull(ScanIntentProfiles.extract("android.scanner.scan",extras("result" to 42)))
        assertNull(ScanIntentProfiles.extract("android.scanner.scan",extras("result" to "")))
        assertNull(ScanIntentProfiles.extract("android.scanner.scan") { throw RuntimeException("bad parcel") })
    }

    @Test fun actionsAreDistinctAndIncludeTheH10p() {
        val actions = ScanIntentProfiles.actions
        assertEquals(actions.distinct(),actions)
        assertTrue(SenraiseScanner.ACTION in actions)
    }
}
