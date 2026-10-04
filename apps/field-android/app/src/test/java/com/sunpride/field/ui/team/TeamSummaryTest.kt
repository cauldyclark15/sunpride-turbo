package com.sunpride.field.ui.team

import com.sunpride.field.auth.AuthFailure
import com.sunpride.field.auth.ConvexFunctionError
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class TeamSummaryTest {
    private val day = "2026-09-28"
    // 11:00 Manila; the day closes at 22:00 Manila.
    private val now = 1_790_564_400_000L
    private val close = 1_790_604_000_000L

    private fun person(name: String = "Ana", extra: JSONObject.() -> Unit = {}) = JSONObject()
        .put("profileId", "p-$name").put("name", name).put("employeeCode", JSONObject.NULL)
        .put("positionLabel", "Route Salesman").put("channel", "PMOT").put("orgUnitId", "u1").put("direct", true)
        .put("planned", 3).put("plannedDone", 2).put("done", 2).put("productive", 1).put("nonproductive", 1)
        .put("unplanned", 1).put("inProgress", true).put("outOfSequence", 1).put("openExceptions", 2)
        .put("lateSync", 1).put("firstCheckInAt", now - 3_600_000).put("lastCheckOutAt", now - 1_800_000)
        .put("lastActivityAt", now).apply(extra)

    private fun exception(kind: String, open: Boolean = false, extra: JSONObject.() -> Unit = {}) = JSONObject()
        .put("id", "$kind:1").put("kind", kind).put("open", open).put("profileId", "p-Ana").put("personName", "Ana")
        .put("outletCode", "O1").put("outletName", "Outlet 1").put("at", now).put("event", JSONObject.NULL)
        .put("result", JSONObject.NULL).put("distanceMeters", JSONObject.NULL).put("sequence", JSONObject.NULL)
        .put("after", JSONObject.NULL).put("reason", JSONObject.NULL).put("decisionStatus", JSONObject.NULL).apply(extra)

    private fun summary(directOnly: Boolean = true, people: List<JSONObject> = listOf(person()),
                        exceptions: List<JSONObject> = listOf(
                            exception("location", true) { put("result", "outside_radius"); put("distanceMeters", 320.4) },
                            exception("out_of_sequence") { put("sequence", 1); put("after", 2) })) = JSONObject()
        .put("serviceDate", day).put("generatedAt", now).put("dayCloseAt", close).put("directOnly", directOnly)
        .put("truncated", false).put("people", JSONArray(people)).put("openExceptions", 1)
        .put("totalExceptions", exceptions.size).put("exceptions", JSONArray(exceptions)).toString()

    private class MemoryCache : TeamCache {
        val rows = mutableMapOf<String, Pair<String, Long>>()
        override fun read(key: String) = rows[key]
        override fun write(key: String, json: String, savedAt: Long) { rows[key] = json to savedAt }
    }

    @Test fun decodesTheServerSummary() {
        val s = TeamCodec.decode(summary())
        assertEquals(day, s.serviceDate)
        assertTrue(s.directOnly)
        val ana = s.people.single()
        assertEquals(TeamPerson("p-Ana", "Ana", "Route Salesman", "PMOT", true, 3, 2, 2, 1, 1, 1, true, 1, 2, 1,
            now - 3_600_000, now - 1_800_000, now), ana)
        assertEquals(320.4, s.exceptions[0].distanceMeters!!, 0.0)
        assertEquals(1, s.exceptions[1].sequence)
        assertEquals(2, s.exceptions[1].after)
    }

    @Test fun rejectsMalformedSummaries() {
        for (bad in listOf("{}", "not json", summary().replace("\"Ana\"", "1"),
            JSONObject(summary()).put("people", JSONArray().put(person { put("planned", 1.5) })).toString(),
            JSONObject(summary()).put("people", JSONArray().put(person { put("planned", -1) })).toString(),
            JSONObject(summary()).put("people", JSONArray().put(person { remove("direct") })).toString()))
            assertThrows(bad, TeamWireFailure::class.java) { TeamCodec.decode(bad) }
    }

    @Test fun offersTheTeamPageOnlyToRolesTheServerCanAuthorize() {
        for (role in listOf("manager", "super_admin", "admin", "analyst", "viewer")) assertTrue(TeamRepository.offered(role))
        for (role in listOf("sales", "operations", "approver", null)) assertFalse(TeamRepository.offered(role))
    }

    @Test fun liveLoadSavesAndOfflineShowsTheSavedCopyForTheSameFilter() {
        val cache = MemoryCache()
        val live = TeamRepository.load(day, true, cache, now) { summary() }
        assertFalse(live.saved)
        assertEquals("Ana", live.summary!!.people.single().name)
        assertEquals(setOf("$day|direct"), cache.rows.keys)
        val offline = TeamRepository.load(day, true, cache, now + 60_000) { throw AuthFailure(AuthFailure.Kind.OFFLINE) }
        assertTrue(offline.saved)
        assertEquals(live.summary, offline.summary)
        assertEquals("Offline — showing team saved at 11:00 AM", offline.message)
        // A different filter has nothing saved: say so rather than show the wrong people.
        val other = TeamRepository.load(day, false, cache, now) { throw AuthFailure(AuthFailure.Kind.OFFLINE) }
        assertNull(other.summary)
        assertEquals("Offline. Connect and try again.", other.message)
    }

    @Test fun serverRefusalNeverShowsSavedData() {
        val cache = MemoryCache()
        TeamRepository.load(day, true, cache, now) { summary() }
        val refused = TeamRepository.load(day, true, cache, now) { throw ConvexFunctionError("Insufficient permission") }
        assertTrue(refused.notAllowed)
        assertNull(refused.summary)
        assertEquals("Team view isn't available for your account.", refused.message)
        val expired = TeamRepository.load(day, true, cache, now) { throw AuthFailure(AuthFailure.Kind.SESSION_EXPIRED) }
        assertNull(expired.summary)
    }

    @Test fun answerForAnotherDayOrFilterIsNotTrustedOrSaved() {
        val cache = MemoryCache()
        val wrongFilter = TeamRepository.load(day, true, cache, now) { summary(directOnly = false) }
        assertNull(wrongFilter.summary)
        assertTrue(cache.rows.isEmpty())
        val wrongDay = TeamRepository.load("2026-09-29", true, cache, now) { summary() }
        assertNull(wrongDay.summary)
        assertEquals("Couldn't read the latest team update. Connect and try again.", wrongDay.message)
    }

    @Test fun wordsCoverageStatusAndExceptions() {
        val s = TeamCodec.decode(summary())
        val ana = s.people.single()
        assertEquals("1 person · 2 of 3 planned calls done · 1 to review", TeamText.headline(s))
        assertEquals("In a call", TeamText.status(ana, now, close))
        assertEquals("Route done", TeamText.status(ana.copy(inProgress = false, plannedDone = 3), now, close))
        val idle = ana.copy(inProgress = false, done = 0, plannedDone = 0, firstCheckInAt = null)
        assertEquals("Not started", TeamText.status(idle, now, close))
        assertEquals("No calls", TeamText.status(idle, close, close))
        assertEquals("Between calls", TeamText.status(ana.copy(inProgress = false), now, close))
        assertEquals("2 of 3 planned · 1 productive · 1 unplanned", TeamText.coverage(ana))
        assertEquals("2 to review · 1 out of order · 1 nonproductive · 1 late sync", TeamText.flags(ana))
        assertEquals("", TeamText.flags(ana.copy(openExceptions = 0, outOfSequence = 0, nonproductive = 0, lateSync = 0)))
        val (location, order) = s.exceptions
        assertEquals("Outside the store radius", TeamText.kind(location, now, close))
        assertEquals("Ana · Outlet 1 · 320 m away · Needs review on the web", TeamText.detail(location))
        assertEquals("Out of MCP order", TeamText.kind(order, now, close))
        assertEquals("Ana · Outlet 1 · stop 1 after 2", TeamText.detail(order))
        assertEquals("Location unreliable", TeamText.kind(location.copy(result = "unreliable"), now, close))
        assertEquals("Ana · Outlet 1 · 320 m away · Approved",
            TeamText.detail(location.copy(open = false, decisionStatus = "approved_exception")))
        val missed = order.copy(kind = "not_visited", sequence = null)
        assertEquals("Not visited yet", TeamText.kind(missed, now, close))
        assertEquals("Not visited", TeamText.kind(missed, close, close))
        assertEquals("Exception", TeamText.kind(order.copy(kind = "something_new"), now, close))
    }
}
