package com.sunpride.field.census

import com.sunpride.field.storage.StoreScope
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.Base64
import java.util.UUID

class CensusRulesTest {
    @Test fun f011CensusAcquisitionDoesNotStopAtOrdinaryVisitAccuracy() {
        val ordinary=com.sunpride.field.ui.diagnosticvisit.LocationFix(10.32,123.9,50.0,1000L,"fused",false)
        val selector=com.sunpride.field.ui.diagnosticvisit.FixSelector
        assertTrue(selector.reliable(ordinary,1000L))
        assertFalse(selector.reliable(ordinary,1000L,50.0))
        assertFalse(selector.reliable(ordinary.copy(accuracyMeters=50.0),1000L,50.0))
        assertTrue(selector.reliable(ordinary.copy(accuracyMeters=49.9),1000L,50.0))
        assertFalse(selector.reliable(ordinary.copy(accuracyMeters=5.0,mockSignal=true),1000L,50.0))
    }
    private fun payload() = JSONObject().put("captureId", UUID.randomUUID().toString()).put("batchId", UUID.randomUUID().toString())
        .put("channelId", UUID.randomUUID().toString()).put("subchannelId", UUID.randomUUID().toString())
        .put("name", "F-011 sample storefront").put("address", "Invented census test address")
        .put("ownerName", "Sample contact").put("ownerPhone", "09171234567").put("estimatedClass", "C").put("deviceTime", 1000L)
        .put("location", JSONObject().put("latitude", 10.32).put("longitude", 123.9).put("accuracyMeters", 12.0)
            .put("fixTime", 1000L).put("provider", "gps").put("mockSignal", false))
        .put("photoJpegBase64", Base64.getEncoder().encodeToString(byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0xd9.toByte())))
    @Test fun f011CompleteCaptureBecomesOneStableSelfContainedOfflineIntent() {
        val p = payload(); val scope = StoreScope("account", "device", "scope")
        val a = CensusRules.intent(scope, p, 1000); val b = CensusRules.intent(scope, JSONObject(p.toString()), 1000)
        assertEquals(a, b); assertEquals("census.capture", a.kind)
        val operation = JSONObject(a.serializedOperation)
        assertEquals(0, operation.getJSONArray("dependsOn").length())
        assertEquals(p.getString("photoJpegBase64"), operation.getJSONObject("payload").getString("photoJpegBase64"))
    }
    @Test fun f011AccuracyMustBeStrictlyBelow50AndFreshWithoutMockLocation() {
        for (accuracy in listOf(0.0, 50.0, 51.0)) {
            val p = payload(); p.getJSONObject("location").put("accuracyMeters", accuracy)
            assertThrows(IllegalArgumentException::class.java) { CensusRules.validate(p) }
        }
        for (change in listOf("mockSignal" to true, "fixTime" to 999999L, "provider" to "unknown")) {
            val p = payload(); p.getJSONObject("location").put(change.first, change.second)
            assertThrows(IllegalArgumentException::class.java) { CensusRules.validate(p) }
        }
    }
    @Test fun f011RequiresARealPhotoEnvelopeAndPreservesLeadingZeroPhoneDigits() {
        val p = payload(); CensusRules.validate(p); assertEquals("09171234567", p.getString("ownerPhone"))
        p.put("photoJpegBase64", ""); assertThrows(IllegalArgumentException::class.java) { CensusRules.validate(p) }
    }
    @Test fun f011BadIdentityAndIncompleteOwnerCannotEnterTheQueue() {
        for ((key, value) in listOf("captureId" to "1-1-1-1-1", "ownerName" to "", "ownerPhone" to "123", "estimatedClass" to "E")) {
            val p = payload().put(key, value); assertThrows(IllegalArgumentException::class.java) { CensusRules.validate(p) }
        }
    }

    // Live test 2026-11-09: Save names every missing field, top first.
    @Test fun missingListsEveryRequiredFieldInFormOrder() {
        val all = CensusRules.missing("", "", "", "", "", "", false, false, "", false)
        assertEquals(CensusRules.Field.entries.toList(), all)
        val ch = UUID.randomUUID().toString()
        val some = CensusRules.missing("Nena", "", "0917 123 4567", ch, "", "gps", true, false, "Colon St", true)
        assertEquals(listOf(CensusRules.Field.OWNER, CensusRules.Field.SUBCHANNEL), some)
        assertEquals("Choose a channel", CensusRules.Field.CHANNEL.message)
        assertEquals(listOf(CensusRules.Field.LOCATION), CensusRules.missing("N", "O", "09171234567", ch, ch, "places", true, false, "A", true))
        assertEquals(listOf(CensusRules.Field.PHONE), CensusRules.missing("N", "O", "123", ch, ch, "gps", true, false, "A", true))
        assertTrue(CensusRules.missing("N", "O", "09171234567", ch, ch, "gps", true, false, "A", true).isEmpty())
        assertEquals("Fill in the 2 fields marked above", CensusRules.missingSummary(2))
        assertEquals("Fill in the field marked above", CensusRules.missingSummary(1))
    }
    @Test fun staleFixUsesTheSameTwoMinuteAndAccuracyRules() {
        val fix = JSONObject().put("latitude", 10.3157).put("longitude", 123.8854).put("accuracyMeters", 12.0).put("fixTime", 1_000L).put("mockSignal", false)
        assertFalse(CensusRules.fixIsStale(fix, 121_000L)); assertTrue(CensusRules.fixIsStale(fix, 121_001L))
        assertFalse(CensusRules.fixIsStale(null, 999_999L))
        assertTrue(CensusRules.fixUsable(fix))
        assertFalse(CensusRules.fixUsable(JSONObject(fix.toString()).put("accuracyMeters", 50.0)))
        assertFalse(CensusRules.fixUsable(JSONObject(fix.toString()).put("mockSignal", true)))
        assertFalse(CensusRules.fixUsable(null))
    }
    @Test fun addressIsKeptUnlessTheFreshPointMovedMoreThan50m() {
        val a = JSONObject().put("latitude", 10.3157).put("longitude", 123.8854)
        assertFalse(CensusRules.movedTooFar(a, JSONObject().put("latitude", 10.3160).put("longitude", 123.8854))) // ~33 m
        assertTrue(CensusRules.movedTooFar(a, JSONObject().put("latitude", 10.3163).put("longitude", 123.8854)))  // ~67 m
    }
}
