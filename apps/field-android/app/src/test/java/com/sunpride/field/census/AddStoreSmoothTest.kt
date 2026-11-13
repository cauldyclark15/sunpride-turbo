package com.sunpride.field.census

import com.sunpride.field.auth.AuthFailure
import com.sunpride.field.auth.ServerError
import com.sunpride.field.storage.StoreScope
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

/** SP-0176 (R6F3 add-store friction): offline lists, kept draft, decisions with the final code, searchable pickers. */
class AddStoreSmoothTest {
    private val scope = StoreScope("v2:dev|agent1", "device-1", "scope-a")

    @Test fun offlineListsKeyIsTheSignedInPersonNotTheBootstrapGeneration() {
        // Old key was "<activeGeneration>:<session>": every sync made the saved lists unreadable offline.
        val before = CensusConfigCache.grantFor(scope, cacheValid = true)
        val afterSync = CensusConfigCache.grantFor(scope.copy(), cacheValid = true)
        assertNotNull(before); assertEquals(before, afterSync)
        assertNotEquals(before, CensusConfigCache.grantFor(scope.copy(account = "v2:dev|agent2"), true))
        assertNull(CensusConfigCache.grantFor(scope, cacheValid = false)) // held/expired partition reads nothing
        assertNull(CensusConfigCache.grantFor(null, true))
    }

    @Test fun savedListsSurviveANewSyncGenerationOffline() {
        var row: String? = null
        var generationOfSnapshot = "gen-1"
        fun load(fetch: () -> String) = CensusConfigCache.load(100L, { 0L },
            { CensusConfigCache.grantFor(scope, generationOfSnapshot.isNotEmpty()) }, { row }, { row = null }, { row = it },
            fetch, CensusConfigCache::isUnreachable)
        load { "{\"customerMaster\":{}}" }
        generationOfSnapshot = "gen-2" // a sync re-bootstrapped the phone
        assertNotNull(load { throw AuthFailure(AuthFailure.Kind.OFFLINE) })
    }

    @Test fun everyCannotReachTheOfficeFailureUsesTheSavedLists() {
        listOf<Throwable>(AuthFailure(AuthFailure.Kind.OFFLINE), AuthFailure(AuthFailure.Kind.SERVER),
            AuthFailure(AuthFailure.Kind.RATE_LIMITED), ConnectException("refused"), SocketTimeoutException(),
            UnknownHostException("dns"), IOException(), org.json.JSONException("captive portal page"))
            .forEach { assertTrue(it.toString(), CensusConfigCache.isUnreachable(it)) }
        listOf<Throwable>(ServerError("forbidden"), AuthFailure(AuthFailure.Kind.SESSION_EXPIRED),
            AuthFailure(AuthFailure.Kind.REFUSED), IllegalStateException())
            .forEach { assertFalse(it.toString(), CensusConfigCache.isUnreachable(it)) }
    }

    @Test fun draftKeepsEveryFieldTheFixAndThePhoto() {
        val form = CustomerCapture.Form(registeredName = "Nena Store Inc", tradeName = "Nena's", customerName = "Nena Sari-sari",
            email = "n@x.ph", mobileNo = "09171234567", telNo = "02 1234", tin = "123-456-789", regionCode = "07",
            provinceCode = "0722", municipalityCode = "072225", barangayCode = "0722250001", houseNo = "12", street1 = "Rizal",
            street2 = "Purok 3", floor = "1", roomStallNo = "A", postalCode = "6000", salesOrgCode = "1000",
            distributionChannelCode = "41", customerGroup1Code = "RSF", customerGroup2Code = "RSS", customerGroupCode = "74",
            typeOfBusiness = "Sole Proprietor", contactPerson = "Nena")
        val fix = JSONObject().put("latitude", 10.3).put("longitude", 123.9).put("accuracyMeters", 8.0)
        val photo = byteArrayOf(-1, -40, 1, 2, -1, -39)
        val back = CustomerCapture.parseDraft(CustomerCapture.draftJson(CustomerCapture.Draft(form, fix, photo)))!!
        assertEquals(form, back.form)
        assertEquals(10.3, back.fix!!.getDouble("latitude"), 0.0)
        assertArrayEquals(photo, back.photo)
        assertFalse(back.isEmpty())
        assertNull(CustomerCapture.parseDraft("not json")); assertNull(CustomerCapture.parseDraft(null))
    }

    @Test fun anUntouchedFormIsNoDraft() {
        assertTrue(CustomerCapture.Draft(CustomerCapture.Form(customerName = "From search", salesOrgCode = "1000"), null, null).isEmpty())
        assertFalse(CustomerCapture.Draft(CustomerCapture.Form(tradeName = "T"), null, null).isEmpty())
        assertFalse(CustomerCapture.Draft(CustomerCapture.Form(), JSONObject(), null).isEmpty())
    }

    @Test fun tradeNameAndEveryAgentFieldGoInThePayload() {
        val form = CustomerCapture.Form(registeredName = "R", tradeName = "Trade X", customerName = "C", email = "e@x.ph",
            mobileNo = "09170000000", telNo = "1", tin = "123-456-789", houseNo = "1", street1 = "S1", street2 = "S2", floor = "F",
            roomStallNo = "R1", postalCode = "6000", contactPerson = "P")
        val c = CustomerCapture.payload("00000000-0000-4000-8000-000000000000", form, null, 1L, JSONObject(), "").getJSONObject("customer")
        mapOf("registeredName" to "R", "tradeName" to "Trade X", "email" to "e@x.ph", "telNo" to "1", "tin" to "123-456-789",
            "houseNo" to "1", "street1" to "S1", "street2" to "S2", "floor" to "F", "roomStallNo" to "R1", "postalCode" to "6000")
            .forEach { (k, v) -> assertEquals(k, v, c.optString(k)) }
    }

    @Test fun decidedStoreShowsApprovedWithTheFinalCodeAndDecidedChangesStopWaiting() {
        val newCapture = "11111111-1111-4111-8111-111111111111"; val change = "22222222-2222-4222-8222-222222222222"
        val outlet = "33333333-3333-4333-8333-333333333333"
        val wire = JSONObject()
            .put("customers", JSONArray().put(JSONObject().put("captureId", newCapture).put("outletId", outlet)
                .put("decision", "accepted").put("reason", JSONObject.NULL).put("code", "SP000002")))
            .put("items", JSONArray().put(JSONObject().put("captureId", change).put("targetOutletId", outlet)
                .put("decision", "rejected").put("reason", "Wrong address")))
        val d = CensusRules.allDecisions(wire)
        assertEquals("Approved · SP000002", CensusRules.savedLabel(CensusRules.Saved("Nena", "done", d[newCapture])))
        assertEquals("Not accepted: Wrong address", CensusRules.savedLabel(CensusRules.Saved("Nena", "done", d[change])))
        // A provisional code is never shown as the final code.
        val prov = CensusRules.customerDecisions(JSONObject().put("customers", JSONArray().put(JSONObject()
            .put("captureId", newCapture).put("decision", "accepted").put("code", "PROV-000002"))))
        assertEquals("Accepted by office", CensusRules.savedLabel(CensusRules.Saved("Nena", "done", prov[newCapture])))
    }

    @Test fun longPickersSearchByAnyWordIgnoringCaseAndAccents() {
        assertTrue(pickerMatches("Sto. Niño (Pob.)", "nino sto"))
        assertTrue(pickerMatches("NO GROUP (74)", "group"))
        assertTrue(pickerMatches("Anything", "  "))
        assertFalse(pickerMatches("Lahug", "mabolo"))
    }
}
