package com.sunpride.field.ui.diagnosticvisit

import com.sunpride.field.storage.ConfiguredFieldCalls
import com.sunpride.field.storage.IntentRow
import com.sunpride.field.storage.PhotoFailureText
import com.sunpride.field.storage.QueueFailureText
import com.sunpride.field.storage.RecordingClosed
import com.sunpride.integrity.EvidenceLocationUnavailable
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

/** SP-0169 r5 lane fieldmore2: FLD-080 FLD-147 FLD-102 FLD-105 FLD-146. */
class FieldMore2Test {
    @After fun clean() = RetailDrafts.reset()

    @Test fun FLD080_aLocationLessStartSaysWhyThereIsNoFix() {
        assertEquals("location_off", LocationCapture.Unavailable(UnavailableReason.LOCATION_OFF).unavailableWire)
        assertEquals("permission_off", LocationCapture.Unavailable(UnavailableReason.PERMISSION_DENIED).unavailableWire)
        assertEquals("no_signal", LocationCapture.Unavailable(UnavailableReason.NO_FIX).unavailableWire)
        assertNull(LocationCapture.Captured(LocationFix(10.0, 123.0, 5.0, 1, "gps", false)).unavailableWire)
    }

    @Test fun FLD146_afterDayCloseStartGivesTheRealReasonNotRequiredFields() {
        val closed = QueueFailureText.of(RecordingClosed(held = false))
        assertTrue(closed.startsWith("Day closed"))
        assertFalse(closed.contains("required fields"))
        assertTrue(QueueFailureText.of(RuntimeException(RecordingClosed(held = true))).contains("held for office review"))
        assertEquals(QueueFailureText.GENERIC, QueueFailureText.of(IllegalStateException("boom")))
    }

    @Test fun FLD147_aPhotoWithoutAFreshFixTellsThePersonWhatToDo() {
        val text = PhotoFailureText.of(EvidenceLocationUnavailable(EvidenceLocationUnavailable.NO_FIX))
        assertTrue(text.startsWith("No fresh location yet"))
        assertTrue(PhotoFailureText.of(EvidenceLocationUnavailable(EvidenceLocationUnavailable.PERMISSION)).startsWith("Allow location"))
        assertTrue(PhotoFailureText.of(RecordingClosed(false)).startsWith("Day closed"))
        assertEquals(PhotoFailureText.GENERIC, PhotoFailureText.of(IllegalArgumentException("type")))
    }

    @Test fun FLD102_typedRetailFieldsSurviveLeavingThePanelUntilSaved() {
        RetailDrafts.setKind("call-1", "competitor")
        RetailDrafts.put("call-1", "competitor", RetailDraft(first = "Brand X", note = "Price cut"))
        // The panel is disposed for the photo screen and composed again:
        assertEquals("competitor", RetailDrafts.kind("call-1"))
        assertEquals("Brand X", RetailDrafts.get("call-1", "competitor").first)
        assertEquals("freezer", RetailDrafts.kind("call-2"))
        assertEquals(RetailDraft(), RetailDrafts.get("call-2", "competitor"))
        RetailDrafts.clear("call-1", "competitor")
        assertEquals(RetailDraft(), RetailDrafts.get("call-1", "competitor"))
    }

    @Test fun FLD102_eachKindHasItsOwnHelpAndTheErrorNamesTheMissingField() {
        val planogram = RetailFormCheck.help("planogram")
        for (kind in listOf("posm", "promotion", "competitor", "issue_log", "freezer", "expiry"))
            assertNotEquals(kind, planogram, RetailFormCheck.help(kind))
        assertEquals("Enter Total shelf facings · all brands.",
            RetailFormCheck.missing("planogram", RetailDraft(facings = listOf("4"), positions = listOf("eye")), null, false, listOf("Corned beef")))
        assertEquals("Enter Actual facings for Corned beef.",
            RetailFormCheck.missing("planogram", RetailDraft(facings = listOf(""), positions = listOf("")), null, false, listOf("Corned beef")))
        assertEquals("Enter the Incident details, or tick No incident observed.",
            RetailFormCheck.missing("issue_log", RetailDraft(), "incident category", true))
        assertNull(RetailFormCheck.missing("issue_log", RetailDraft(none = true), null, false))
        assertEquals("Enter the Temperature °C as a number, for example -18.5.",
            RetailFormCheck.missing("freezer", RetailDraft(first = "SN-1", second = "cold"), "freezer or cooler", true))
        assertTrue(RetailFormCheck.missing("promotion", RetailDraft(), "campaign", false)!!.startsWith("No campaign"))
        assertNull(RetailFormCheck.missing("freezer", RetailDraft(first = "SN-1", second = "-18.5", third = "60"), "freezer or cooler", true))
    }

    @Test fun FLD105_endTellsYouToPickANoOrderReasonBeforeTheReviewSheet() {
        val config = JSONObject().put("reasons", org.json.JSONArray().put(JSONObject().put("code", "no_demand").put("label", "No demand today")))
        fun row(kind: String, p: JSONObject) = IntentRow("a", "d", "s", kind + p.hashCode(), "call", kind,
            JSONObject().put("payload", p).toString(), 1)
        val start = row("visit.checkIn", JSONObject())
        assertTrue(ConfiguredFieldCalls.needsNoOrderReason(config, listOf(start to "pending"), "call", ""))
        assertFalse(ConfiguredFieldCalls.needsNoOrderReason(config, listOf(start to "pending"), "call", "no_demand"))
        val order = row("visit.activity", JSONObject().put("activity", JSONObject().put("kind", "order_intent")))
        assertFalse(ConfiguredFieldCalls.needsNoOrderReason(config, listOf(start to "pending", order to "pending"), "call", ""))
        assertFalse(ConfiguredFieldCalls.needsNoOrderReason(null, listOf(start to "pending"), "call", ""))
    }
}
