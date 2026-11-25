package com.sunpride.field.census

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID
import java.time.Instant

/** Pure production model/outbox proof; not airplane-mode or physical-device evidence. */
class CustomerOfflineSaveTest {
    private fun saved(form: CustomerCapture.Form) = CustomerCapture.payload(UUID.randomUUID().toString(),
        form, null, 5000L, null, "").put("allowIncomplete", true)

    @Test fun identityOnlyCanBeSavedWithoutSetupPhotoGpsOrNonessentialAnswers() {
        val form = CustomerCapture.Form(registeredName = "Sample Store", firstName = "Ana")
        assertTrue(CustomerCapture.saveMissing(form).isEmpty())
        assertTrue(CustomerCapture.saveErrors(form, null, null).isEmpty())
        val p = saved(form)
        CensusRules.validate(p)
        assertTrue(p.isNull("location"))
        assertEquals("", p.getString("photoJpegBase64"))
        for (key in listOf("registeredName", "customerName")) {
            val explicitNull = JSONObject(p.toString()).also { it.getJSONObject("customer").put(key, JSONObject.NULL) }
            assertTrue(runCatching { CensusRules.validate(explicitNull) }.isFailure)
        }
        // Submission remains a separate completeness boundary.
        assertTrue(runCatching { CensusRules.validate(JSONObject(p.toString()).apply { remove("allowIncomplete") }) }.isFailure)
        for (missing in listOf(form.copy(registeredName = " \t"), form.copy(firstName = " "))) {
            assertTrue(CustomerCapture.saveMissing(missing).isNotEmpty())
            assertTrue(runCatching { CensusRules.validate(saved(missing)) }.isFailure)
        }
    }

    @Test fun typedFallbacksAndPartlyEnteredOptionalValuesRemainInDraftAndImmutableOutbox() {
        val form = CustomerCapture.Form(registeredName = "Sample Store", firstName = "Ana", mobileNo = "0917",
            municipalityCode = "Town not downloaded", barangayCode = "New barangay", distributionChannelCode = "Unknown channel")
        val restored = CustomerCapture.parseDraft(CustomerCapture.draftJson(CustomerCapture.Draft(form, null, null)))!!.form
        assertEquals(form, restored)
        assertTrue(CustomerCapture.saveErrors(restored, null, null).isEmpty())
        val p = saved(restored)
        CensusRules.validate(p)
        assertEquals("Town not downloaded", p.getJSONObject("customer").getString("municipalityCode"))
        assertEquals("0917", p.getJSONObject("customer").getString("mobileNo"))
        assertTrue(runCatching { CensusRules.validate(JSONObject(p.toString()).put("photoJpegBase64", "not-jpeg")) }.isFailure)
    }

    @Test fun nationwideBarangaysAreAvailableOutsideTheAssignedProvince() {
        val pack = JSONObject().put("barangaysComplete", true)
            .put("provinces", JSONArray().put(JSONObject().put("code", "p1").put("name", "One").put("regionCode", "r"))
                .put(JSONObject().put("code", "p2").put("name", "Two").put("regionCode", "r")))
            .put("municipalities", JSONArray().put(JSONObject().put("code", "m2").put("name", "Town Two").put("provinceCode", "p2")))
            .put("barangays", JSONArray().put(JSONObject().put("code", "b2").put("name", "Barangay Two").put("municipalityCode", "m2")))
        val g = CustomerCapture.Geography.parse(JSONObject(pack.toString()))
        assertTrue(g.hasBarangays("p1")); assertTrue(g.hasBarangays("p2"))
        assertEquals("Barangay Two", g.barangaysOf("m2")!!.single().name)
    }

    @Test fun reminderUsesNextPhilippineMorningAndNeverRequiresNetwork() {
        val before = Instant.parse("2026-11-25T23:00:00Z").toEpochMilli() // 7 AM Manila
        assertEquals(3600000L, CustomerDraftReminders.morningDelay(before))
        assertEquals(86400000L, CustomerDraftReminders.morningDelay(before + 3600000L))
        val holder = CustomerDraftHolder()
        val draft = CustomerCapture.Draft(CustomerCapture.Form(firstName = "Ana"), null, null)
        holder.replace(CustomerDrafts().save(draft))
        assertEquals(1, holder.savedCount)
        val id = holder.customers.saved.single().id
        holder.replace(holder.customers.open(id)); assertEquals(1, holder.savedCount)
        holder.clear(); assertEquals(0, holder.savedCount)
        holder.restore(CustomerDrafts().save(draft).json()); assertEquals(1, holder.savedCount)
        holder.reset(); assertEquals(0, holder.savedCount)
    }
}
