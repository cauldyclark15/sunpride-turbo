package com.sunpride.field.census

import com.sunpride.field.auth.AuthFailure
import com.sunpride.field.auth.ServerError
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.Base64
import java.util.UUID

/** SP-0163 proxy client against a stub NativeApi: contract shapes, and graceful degradation on old servers. */
class CensusPlacesTest {
    private val paths = mutableListOf<String>()
    private fun api(get: (String) -> JSONObject, post: (String, JSONObject) -> JSONObject = { _, _ -> error("no post") }) =
        CensusPlaces({ paths += it; get(it) }, { p, b -> paths += p; post(p, b) })

    @Test fun autocompleteSendsSessionBiasAndEncodedInputOnlyToOurProxy() {
        val places = api({ JSONObject("""{"predictions":[{"placeId":"P1","primary":"SM Seaside","secondary":"Cebu City","description":"SM Seaside, Cebu City"}]}""") })
        val r = places.autocomplete("sm sea & co", "s-1", 10.3, 123.9) as CensusPlaces.Result.Ok
        assertEquals("SM Seaside", r.value.single().primary)
        assertEquals("/api/v1/places/autocomplete?input=sm+sea+%26+co&session=s-1&lat=10.3&lng=123.9", paths.single())
        assertTrue(paths.none { it.contains("googleapis") || it.contains("key=") })
        assertEquals(CensusPlaces.Result.Ok(emptyList<CensusPlaces.Prediction>()), places.autocomplete("sm", "s-1", null, null))
        assertEquals(1, paths.size) // fewer than 3 characters never calls the server
    }
    @Test fun detailsAndReverseParseTheContract() {
        val places = api({ p -> if (p.startsWith("/api/v1/places/details")) JSONObject("""{"placeId":"P1","formattedAddress":"Cebu South Coastal Rd","latitude":10.28,"longitude":123.88,"components":{"street":null,"barangay":"Mambaling","city":"Cebu City","province":"Cebu","region":"Central Visayas","postalCode":"6000"}}""")
            else JSONObject("""{"formattedAddress":"12 Colon St","components":{"city":"Cebu City"}}""") })
        val d = (places.details("P1", "s") as CensusPlaces.Result.Ok).value
        assertEquals(10.28, d.latitude!!, 0.0); assertEquals("Mambaling, Cebu City", d.components.line()); assertFalse(d.components.json().has("street"))
        assertEquals("12 Colon St", (places.reverse(10.0, 123.0) as CensusPlaces.Result.Ok).value.formattedAddress)
    }
    @Test fun oldServerOrMissingKeyIsUnavailableAndNoSignalIsOffline() {
        val notFound = api({ throw ServerError(null) }, { _, _ -> throw ServerError("not_found") })
        assertEquals(CensusPlaces.Result.Unavailable, notFound.autocomplete("aling", "s", null, null))
        assertEquals(CensusPlaces.Result.Unavailable, notFound.reverse(10.0, 123.0))
        assertEquals(CensusPlaces.Result.Unavailable, notFound.duplicateCheck("A", null, null, null, null))
        val down = api({ throw AuthFailure(AuthFailure.Kind.SERVER) })
        assertEquals(CensusPlaces.Result.Unavailable, down.details("P", "s"))
        val offline = api({ throw AuthFailure(AuthFailure.Kind.OFFLINE) })
        assertEquals(CensusPlaces.Result.Offline, offline.autocomplete("aling", "s", null, null))
    }
    @Test fun duplicateCheckPostsTheContractBody() {
        var sent: JSONObject? = null
        val places = api({ error("no get") }, { _, b -> sent = b; JSONObject("""{"candidates":[{"kind":"capture","id":"c1","code":null,"name":"Nena","address":"x","latitude":null,"longitude":null,"distanceMeters":null,"reasons":["phone"],"score":90}],"truncated":false}""") })
        val c = (places.duplicateCheck("Nena", "0917", 10.0, 123.0, null) as CensusPlaces.Result.Ok).value.single()
        assertEquals("/api/v1/masters/census/duplicate-check", paths.single())
        assertEquals(setOf("name", "phone", "latitude", "longitude"), sent!!.keys().asSequence().toSet())
        assertEquals("capture", c.kind); assertNull(c.distanceMeters); assertEquals(listOf("phone"), c.reasons)
    }

    private val photo = Base64.getEncoder().encodeToString(byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0xd9.toByte()))
    private fun u() = UUID.randomUUID().toString()
    @Test fun placesPayloadHasNoAccuracyRulesAndOmitsBatchWhenDefault() {
        val p = CensusRules.payload(u(), null, "Store", "Addr", "Owner", "09171234567", u(), u(), "C", 1000L, null,
            CensusRules.Place("P1", 10.28, 123.88, "Formatted", JSONObject().put("city", "Cebu City")), " beside the chapel ", null, listOf("a", "a", "b"), photo)
        CensusRules.validate(p)
        assertEquals("places", p.getString("locationSource")); assertFalse(p.has("batchId"))
        assertEquals(setOf("latitude", "longitude"), p.getJSONObject("location").keys().asSequence().toSet())
        assertEquals("beside the chapel", p.getString("landmark")); assertEquals(2, p.getJSONArray("acknowledgedDuplicateIds").length())
        assertEquals("Cebu City", p.getJSONObject("addressComponents").getString("city"))
        p.remove("placeId"); assertThrows(IllegalArgumentException::class.java) { CensusRules.validate(p) }
    }
    @Test fun gpsPayloadKeepsTodaysRulesAndCarriesTheReverseAddress() {
        val fix = JSONObject().put("latitude", 10.32).put("longitude", 123.9).put("accuracyMeters", 12.0).put("fixTime", 1000L).put("provider", "gps").put("mockSignal", false)
        val batch = u()
        val p = CensusRules.payload(u(), batch, "Store", "Addr", "Owner", "09171234567", u(), u(), "C", 1000L, fix, null, "",
            "12 Colon St" to JSONObject().put("barangay", "Kalubihan"), emptyList(), photo)
        CensusRules.validate(p)
        assertEquals("gps", p.getString("locationSource")); assertEquals(batch, p.getString("batchId")); assertFalse(p.has("landmark"))
        assertEquals("12 Colon St", p.getString("formattedAddress")); assertFalse(p.has("acknowledgedDuplicateIds"))
        p.getJSONObject("location").put("accuracyMeters", 60.0); assertThrows(IllegalArgumentException::class.java) { CensusRules.validate(p) }
    }
    @Test fun batchPickerAndSearchFollowCensusConfig() {
        assertTrue(CensusRules.showBatchPicker(JSONObject("""{"batches":[{"id":"a"}]}"""))) // old server
        assertFalse(CensusRules.showBatchPicker(JSONObject("""{"batches":[{"id":"a"}],"defaultBatch":{"id":"d","name":"Ongoing"}}""")))
        assertFalse(CensusRules.showBatchPicker(JSONObject("""{"batches":[],"defaultBatch":{"id":"d","name":"Ongoing"}}""")))
        assertTrue(CensusRules.showBatchPicker(JSONObject("""{"batches":[{"id":"a"},{"id":"b"}],"defaultBatch":{"id":"d","name":"Ongoing"}}""")))
        assertFalse(CensusRules.addressSearch(JSONObject("{}"))); assertTrue(CensusRules.addressSearch(JSONObject("""{"addressSearch":true}""")))
    }
}
