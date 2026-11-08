package com.sunpride.field.census

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** SP-0163: every vector of the shared fixture mobile-v1/census-duplicates.json (read-only, test resource). */
class DuplicateRulesTest {
    private val fixture = JSONObject(javaClass.classLoader!!.getResourceAsStream("census-duplicates.json")!!
        .bufferedReader().use { it.readText() })
    private fun JSONObject.d(k: String): Double? = if (isNull(k)) null else getDouble(k)
    private fun JSONObject.s(k: String): String? = if (isNull(k)) null else getString(k)

    @Test fun stopwordsMatchTheFixture() {
        val a = fixture.getJSONObject("rules").getJSONArray("stopwords")
        assertEquals((0 until a.length()).map(a::getString).toSet(), DuplicateRules.STOPWORDS)
    }
    @Test fun nameTokenVectors() {
        val v = fixture.getJSONArray("nameTokenVectors"); assertTrue(v.length() > 0)
        for (i in 0 until v.length()) { val o = v.getJSONObject(i); val t = o.getJSONArray("tokens")
            assertEquals(o.getString("name"), (0 until t.length()).map(t::getString).toSet(), DuplicateRules.nameTokens(o.getString("name"))) }
    }
    @Test fun phoneKeyVectors() {
        val v = fixture.getJSONArray("phoneKeyVectors"); assertTrue(v.length() > 0)
        for (i in 0 until v.length()) { val o = v.getJSONObject(i); assertEquals(o.getString("phone"), o.s("key"), DuplicateRules.phoneKey(o.getString("phone"))) }
    }
    @Test fun pairVectors() {
        val v = fixture.getJSONArray("pairVectors"); assertEquals(9, v.length())
        for (i in 0 until v.length()) {
            val o = v.getJSONObject(i); val label = o.getString("label"); val q = o.getJSONObject("query"); val e = o.getJSONObject("existing")
            val x = o.getJSONObject("expect")
            val query = DuplicateRules.Store("", q.getString("name"), q.s("phone"), q.d("latitude"), q.d("longitude"), q.s("placeId"))
            val existing = DuplicateRules.Store("x$i", e.getString("name"), e.s("phone"), e.d("latitude"), e.d("longitude"), e.optString("placeId").ifEmpty { null })
            assertEquals(label, x.d("distanceMeters"), DuplicateRules.distanceMeters(query.latitude, query.longitude, existing.latitude, existing.longitude))
            assertEquals(label, x.getDouble("nameSimilarity"), DuplicateRules.nameSimilarity(query.name, existing.name), 0.0)
            val c = DuplicateRules.evaluate(query, existing)
            assertEquals(label, x.getBoolean("isCandidate"), c != null)
            val r = x.getJSONArray("reasons")
            assertEquals(label, (0 until r.length()).map(r::getString), c?.reasons.orEmpty())
        }
    }
    @Test fun scoreSortAndMergeFollowTheRules() {
        val q = DuplicateRules.Store("", "Aling Nena Sari-Sari Store", "0917 123 4567", 10.3157, 123.8854)
        val near = DuplicateRules.Store("a", "ALING NENA STORE", null, 10.31585, 123.88545)       // nearby(<=25) 80 + name 30
        val phone = DuplicateRules.Store("b", "Nena's Mini Mart", "+63 917-123-4567", 10.4, 123.95) // 90
        val nextDoor = DuplicateRules.Store("c", "JM Trading", null, 10.3162, 123.8856)            // nearby 60
        val found = DuplicateRules.find(q, listOf(nextDoor, phone, near))
        assertEquals(listOf("a", "b", "c"), found.map { it.id }); assertEquals(listOf(110, 90, 60), found.map { it.score })
        val server = DuplicateRules.Candidate("capture", "z", "Zed", null, null, null, null, listOf("place"), 100)
        assertEquals(listOf("a", "z", "b", "c"), DuplicateRules.merge(found, found.take(1) + server).map { it.id })
        assertEquals(10, DuplicateRules.find(q, (1..15).map { near.copy(id = "n$it") }).size)
        assertEquals("Same phone number · Very close by", DuplicateRules.reasonText(listOf("phone", "nearby")))
    }
}
