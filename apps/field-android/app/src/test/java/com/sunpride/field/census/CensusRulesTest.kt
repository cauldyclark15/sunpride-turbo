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
    @Test fun f011OptionalPhotoPreservesLeadingZeroPhoneDigits() {
        val p = payload(); CensusRules.validate(p); assertEquals("09171234567", p.getString("ownerPhone"))
        p.put("photoJpegBase64", ""); CensusRules.validate(p)
        p.put("photoJpegBase64", JSONObject.NULL); CensusRules.validate(p)
        p.remove("photoJpegBase64"); CensusRules.validate(p)
        p.put("photoJpegBase64", "not-a-photo"); assertThrows(IllegalArgumentException::class.java) { CensusRules.validate(p) }
    }
    @Test fun f011BadIdentityAndIncompleteOwnerCannotEnterTheQueue() {
        for ((key, value) in listOf("captureId" to "1-1-1-1-1", "ownerName" to "", "ownerPhone" to "123", "estimatedClass" to "E")) {
            val p = payload().put(key, value); assertThrows(IllegalArgumentException::class.java) { CensusRules.validate(p) }
        }
    }

    // Live test 2026-11-09: Save names every missing field, top first.
    @Test fun missingListsEveryRequiredFieldInFormOrder() {
        val all = CensusRules.missing("", "", "", "", "", "", false, false, "", false)
        assertEquals(CensusRules.Field.entries.filter { it != CensusRules.Field.PHOTO }, all)
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

    // Field "Edit store": a change request linked to the existing store.
    private val target = UUID.randomUUID().toString()
    private fun change(name: String = "Nena Mini Mart") = CensusRules.changePayload(UUID.randomUUID().toString(), target, name,
        "5 Rizal St", "Nena Cruz", "0917 555 0101", 1000L, null, null, "", null)
    /** E2E-010: a searched pin ~5 km away is sent as the proposal, and the agent's own fix as the capture location
     * (it used to send the searched point as the location, so the place check measured 0 m and no pin decision came). */
    @Test fun storeEditSendsTheAgentsFixSeparatelyFromTheSearchedPin() {
        val fix = JSONObject().put("latitude", 10.2732).put("longitude", 123.8673).put("accuracyMeters", 6.0)
            .put("fixTime", 1000L).put("mockSignal", false).put("provider", "gps")
        val place = CensusRules.Place("ChIJ-mango", 10.3126, 123.8937, "Mango Avenue, Cebu City", null)
        val p = CensusRules.changePayload(UUID.randomUUID().toString(), target, "Nena Mini Mart", "Mango Avenue, Cebu City",
            "Nena Cruz", "0917 555 0101", 1000L, fix, place, "", null)
        assertEquals("places", p.getString("locationSource")); assertEquals("ChIJ-mango", p.getString("placeId"))
        val l = p.getJSONObject("location")
        assertEquals(10.2732, l.getDouble("latitude"), 0.0); assertEquals(123.8673, l.getDouble("longitude"), 0.0)
        assertEquals(6.0, l.getDouble("accuracyMeters"), 0.0)
        CensusRules.validate(p)
        // No fix at all: the searched point stands in (the office still confirms the moved pin).
        val only = CensusRules.changePayload(UUID.randomUUID().toString(), target, "Nena Mini Mart", "Mango Avenue, Cebu City",
            "Nena Cruz", "0917 555 0101", 1000L, null, place, "", null)
        assertEquals(10.3126, only.getJSONObject("location").getDouble("latitude"), 0.0)
    }
    /** SP-0255/SP-0241: Edit customer accepts optional Street 1 and incomplete address parts. */
    @Test fun storeEditSendsTheStructuredAddress() {
        val saved = mapOf("houseNo" to "5", "street1" to "Rizal St", "municipalityCode" to "0702230000")
        val form = CensusRules.formFromParts(saved)
        assertEquals("Rizal St", form.street1); assertEquals("0702230000", form.municipalityCode)
        assertFalse(CensusRules.addressPartsChanged(saved, form))
        val moved = form.copy(street1 = "Mabini St")
        assertTrue(CensusRules.addressPartsChanged(saved, moved))
        assertEquals("5 Mabini St", CensusRules.addressLine(moved, null))
        val p = CensusRules.changePayload(UUID.randomUUID().toString(), target, "Nena Mini Mart", "5 Mabini St",
            "Nena Cruz", "0917 555 0101", 1000L, null, null, "", null, CensusRules.addressPartsJson(moved))
        val parts = p.getJSONObject("addressParts")
        assertEquals("Mabini St", parts.getString("street1")); assertTrue(parts.isNull("barangayCode"))
        assertEquals(CensusRules.ADDRESS_PART_KEYS.toSet(), parts.keys().asSequence().toSet())
        CensusRules.validate(p)
        for (street in listOf(null, JSONObject.NULL, "", " \t ")) {
            val blank = CensusRules.changePayload(UUID.randomUUID().toString(), target, "Nena Mini Mart", "5",
                "Nena Cruz", "0917 555 0101", 1000L, null, null, "", null, CensusRules.addressPartsJson(form.copy(street1 = "")))
            if (street == null) blank.getJSONObject("addressParts").remove("street1") else blank.getJSONObject("addressParts").put("street1", street)
            CensusRules.validate(blank)
            val intent = CensusRules.intent(StoreScope("account", "device", "scope"), blank, 1000L)
            CensusRules.validate(JSONObject(intent.serializedOperation).getJSONObject("payload"))
        }
        assertFalse(CensusRules.missingForChange("Nena Mini Mart", "Nena Cruz").contains(CensusRules.Field.ADDRESS))
    }
    @Test fun storeEditRetainsTypedPlacesWithoutGeographyAndAcrossOutboxSerialization() {
        val form = CustomerCapture.Form(street1 = "Mabini St", provinceCode = "Sample province",
            municipalityCode = "Sample town", barangayCode = "Sample barangay", postalCode = "0123")
        assertEquals("Mabini St, Sample barangay, Sample town, Sample province 0123", CensusRules.addressLine(form, null))
        val p = CensusRules.changePayload(UUID.randomUUID().toString(), target, "Sample Store",
            CensusRules.addressLine(form, null), "Ana", "", 5000L, null, null, "", null, CensusRules.addressPartsJson(form))
        CensusRules.validate(p)
        val queued = CensusRules.intent(StoreScope("account", "device", "scope"), p, 5000L)
        val restored = JSONObject(queued.serializedOperation).getJSONObject("payload")
        val parts = restored.getJSONObject("addressParts")
        val reopened = CensusRules.formFromParts(CensusRules.ADDRESS_PART_KEYS.associateWith { key ->
            if (parts.isNull(key)) "" else parts.getString(key)
        })
        assertEquals(CensusRules.addressParts(form), CensusRules.addressParts(reopened))
        assertEquals("0123", parts.getString("postalCode"))
        assertEquals(restored.getString("address"), CensusRules.addressLine(reopened, null))
        CensusRules.validate(restored)
    }
    @Test fun storeEditPayloadIsAChangeForTheStoreWithoutNewStoreFields() {
        val p = change()
        assertEquals("change", p.getString("kind")); assertEquals(target, p.getString("targetOutletId"))
        assertFalse(p.has("channelId")); assertFalse(p.has("location")); assertFalse(p.has("photoJpegBase64")); assertFalse(p.has("batchId"))
        CensusRules.validate(p) // no channel, location or photo needed
        val intent = CensusRules.intent(StoreScope("account", "device", "scope"), p, 1000)
        assertEquals(CensusRules.KIND, intent.kind)
        assertTrue(CensusRules.isChange(JSONObject(intent.serializedOperation).getJSONObject("payload")))
    }
    @Test fun storeEditChecksTheFieldsItSends() {
        assertThrows(IllegalArgumentException::class.java) { CensusRules.validate(change(name = " ")) }
        assertThrows(Exception::class.java) { CensusRules.validate(change().put("targetOutletId", "o1")) }
        assertThrows(IllegalArgumentException::class.java) { CensusRules.validate(change().put("channelId", UUID.randomUUID().toString())) }
        val stale = change().put("locationSource", "gps").put("location", JSONObject().put("latitude", 10.3).put("longitude", 123.9)
            .put("accuracyMeters", 900.0).put("fixTime", 1000L).put("provider", "gps").put("mockSignal", false))
        assertThrows(IllegalArgumentException::class.java) { CensusRules.validate(stale) }
        CensusRules.validate(stale.put("location", stale.getJSONObject("location").put("accuracyMeters", 80.0)))
        assertTrue(CensusRules.missingForChange("A", "B").isEmpty())
        assertEquals(listOf(CensusRules.Field.NAME, CensusRules.Field.OWNER), CensusRules.missingForChange(" ", "\t"))
    }
    @Test fun storeEditKeepsPartialPhoneAndAddressWithoutPhotoOrGps() {
        for (phone in listOf("", "0917")) {
            val p = CensusRules.changePayload(UUID.randomUUID().toString(), target, "Sample Store", "", "Ana", phone,
                5000L, null, null, "", null, CensusRules.addressPartsJson(CustomerCapture.Form()))
            CensusRules.validate(p)
            val queued = CensusRules.intent(StoreScope("account", "device", "scope"), p, 5000L)
            val restored = JSONObject(queued.serializedOperation).getJSONObject("payload")
            assertEquals(phone, restored.getString("ownerPhone"))
            assertEquals("", restored.getString("address"))
            assertFalse(restored.has("location")); assertFalse(restored.has("photoJpegBase64"))
            for (key in listOf("name", "ownerName")) {
                assertTrue(runCatching { CensusRules.validate(JSONObject(p.toString()).put(key, JSONObject.NULL)) }.isFailure)
            }
        }
        val old = JSONObject().put("latitude", 10.3).put("longitude", 123.9).put("accuracyMeters", 9.0)
            .put("fixTime", 1L).put("provider", "gps").put("mockSignal", false)
        val deferred = CensusRules.changePayload(UUID.randomUUID().toString(), target, "Store", "", "Ana", "",
            2_000_000L, old, null, "", null)
        assertFalse(deferred.has("location"))
        CensusRules.validate(deferred)
    }

    @Test fun storeEditKnowsWhenNothingChanged() {
        val now = CensusRules.Current("Aling Nena", "5 Rizal St", "Nena", "0917")
        assertFalse(CensusRules.changed(now, " Aling Nena", "5 Rizal St", "Nena", "0917", "", moved = false, photo = false))
        assertTrue(CensusRules.changed(now, "Nena Mini Mart", "5 Rizal St", "Nena", "0917", "", moved = false, photo = false))
        assertTrue(CensusRules.changed(now, "Aling Nena", "5 Rizal St", "Nena", "0917", "", moved = true, photo = false))
        assertTrue(CensusRules.changed(now, "Aling Nena", "5 Rizal St", "Nena", "0917", "", moved = false, photo = true))
    }
    @Test fun storeEditPendingLabelUntilTheOfficeApplies() {
        val p = change()
        val before = mapOf(target to CensusRules.Current("Aling Nena Store", "5 Rizal St", "Nena Cruz", "0917 555 0101"))
        // Approved: the store's name/address now match; the owner is not on the phone's store record.
        val applied = mapOf(target to CensusRules.Current("Nena Mini Mart", "5 Rizal St", "", ""))
        assertEquals(mapOf(target to "Change waiting for office · Saved on phone"),
            CensusRules.waitingChanges(listOf(Triple(p, "pending", 1000L)), before, 2000L))
        assertEquals(mapOf(target to "Change waiting for office"), CensusRules.waitingChanges(listOf(Triple(p, "done", 1000L)), before, 2000L))
        assertEquals(emptyMap<String, String>(), CensusRules.waitingChanges(listOf(Triple(p, "done", 1000L)), applied, 2000L))
        assertEquals(emptyMap<String, String>(), CensusRules.waitingChanges(listOf(Triple(p, "done", 1000L)), before,
            1000L + CensusRules.CHANGE_WAIT_MS + 1))
        assertEquals(mapOf(target to "Change waiting for office"), CensusRules.waitingChanges(listOf(Triple(p, "review", 1000L)), before, 2000L))
        // New-store captures never show as a change.
        assertEquals(emptyMap<String, String>(), CensusRules.waitingChanges(listOf(Triple(payload(), "pending", 1000L)), before, 2000L))
    }
    @Test fun storeEditOfficeDecisionsReachThePhone() {
        val p = change()
        val capture = p.getString("captureId")
        val before = mapOf(target to CensusRules.Current("Aling Nena Store", "5 Rizal St", "Nena Cruz", "0917 555 0101"))
        val sent = listOf(Triple(p, "done", 1000L))
        val wire = JSONObject().put("items", org.json.JSONArray()
            .put(JSONObject().put("captureId", capture).put("targetOutletId", target).put("decision", "rejected")
                .put("reason", "Owner did not confirm").put("decidedAt", 1500L))
            .put(JSONObject().put("captureId", "not-a-uuid").put("targetOutletId", target).put("decision", "rejected")))
        val rejected = CensusRules.decisions(wire)
        assertEquals(setOf(capture), rejected.keys)
        // Rejected: no longer "waiting"; says why, once.
        assertEquals(mapOf(target to "Change not approved: Owner did not confirm"),
            CensusRules.waitingChanges(sent, before, 2000L, rejected))
        assertEquals(setOf(capture), CensusRules.rejectionsToMark(sent, rejected, target, emptySet()))
        assertEquals(emptyMap<String, String>(), CensusRules.waitingChanges(sent, before, 2000L, rejected, setOf(capture)))
        assertEquals(emptySet<String>(), CensusRules.rejectionsToMark(sent, rejected, target, setOf(capture)))
        // No reason given: the plain line.
        val bare = mapOf(capture to CensusRules.Decision(capture, target, false, null))
        assertEquals(mapOf(target to "Change not approved"), CensusRules.waitingChanges(sent, before, 2000L, bare))
        // Accepted: the waiting label clears even before the store record shows the new name.
        val accepted = CensusRules.decisions(JSONObject().put("items", org.json.JSONArray().put(JSONObject()
            .put("captureId", capture).put("targetOutletId", target).put("decision", "accepted").put("reason", JSONObject.NULL))))
        assertEquals(emptyMap<String, String>(), CensusRules.waitingChanges(sent, before, 2000L, accepted))
        assertEquals(emptySet<String>(), CensusRules.rejectionsToMark(sent, accepted, target, emptySet()))
        // A change still on the phone keeps its own label whatever the list says.
        assertEquals(mapOf(target to "Change waiting for office · Saved on phone"),
            CensusRules.waitingChanges(listOf(Triple(p, "pending", 1000L)), before, 2000L, rejected))
        assertEquals(emptyMap<String, CensusRules.Decision>(), CensusRules.decisions(null))
    }
    /** E2E-101 (2cb81db7 rejected "Owner phone not confirmed" while 7d9e4175 was still waiting): the rejection is
     * shown beside the later change, and still once after that change is accepted, never silently dropped. */
    @Test fun `E2E-101 a rejected change is shown even when a later change exists`() {
        val first = change(); val second = change("Nena Mini Mart 2")
        val before = mapOf(target to CensusRules.Current("Aling Nena Store", "5 Rizal St", "Nena Cruz", "0917 555 0101"))
        val sent = listOf(Triple(first, "done", 1000L), Triple(second, "done", 1100L))
        val one = first.getString("captureId"); val two = second.getString("captureId")
        val rejectedOnly = mapOf(one to CensusRules.Decision(one, target, false, "Owner phone not confirmed"))
        assertEquals(mapOf(target to "Change waiting for office · Change not approved: Owner phone not confirmed"),
            CensusRules.waitingChanges(sent, before, 2000L, rejectedOnly))
        val both = rejectedOnly + (two to CensusRules.Decision(two, target, true, null))
        assertEquals(mapOf(target to "Change not approved: Owner phone not confirmed"),
            CensusRules.waitingChanges(sent, before, 2000L, both))
        assertEquals(setOf(one), CensusRules.rejectionsToMark(sent, both, target, emptySet()))
        // Once seen, it is gone.
        assertEquals(emptyMap<String, String>(), CensusRules.waitingChanges(sent, before, 2000L, both, setOf(one)))
    }
    /** E2E-008: a saved customer the office rejected reads "Not approved by office: <reason>", not "Sent to office". */
    @Test fun `E2E-008 a rejected saved customer says why`() {
        val capture = UUID.randomUUID().toString()
        val wire = JSONObject().put("items", org.json.JSONArray()).put("customers", org.json.JSONArray()
            .put(JSONObject().put("captureId", capture).put("decision", "rejected").put("reason", "Duplicate of an existing store"))
            .put(JSONObject().put("captureId", "x").put("decision", "maybe")))
        val decided = CensusRules.customerDecisions(wire)
        assertEquals(setOf(capture), decided.keys)
        assertEquals("Not approved by office: Duplicate of an existing store",
            CensusRules.savedLabel(CensusRules.Saved("R6F2 Sari-sari", "done", decided[capture])))
        assertEquals("Sent to office", CensusRules.savedLabel(CensusRules.Saved("R6F2 Sari-sari", "done", null)))
        assertEquals("Saved on phone", CensusRules.savedLabel(CensusRules.Saved("R6F2 Sari-sari", "pending", decided[capture])))
        assertEquals("Accepted by office", CensusRules.savedLabel(CensusRules.Saved("x", "done",
            CensusRules.CustomerDecision(capture, true, null))))
        assertEquals(emptyMap<String, CensusRules.CustomerDecision>(), CensusRules.customerDecisions(JSONObject().put("items", org.json.JSONArray())))
    }

    /** QA retest: Edit customer opens with the saved name, owner and phone; text the agent typed is kept. */
    @Test fun editPrefillsEverySavedValue() {
        val store = CensusRules.Current("Sample Santos Sari-sari 101", "Sample address", "Rosa Santos", "09179876543")
        assertEquals(store, CensusRules.prefill(store, CensusRules.Current("", "", "", "")))
        val typed = CensusRules.prefill(store, CensusRules.Current("New name", "", " ", ""))
        assertEquals("New name", typed.name); assertEquals("Rosa Santos", typed.ownerName)
    }
}
