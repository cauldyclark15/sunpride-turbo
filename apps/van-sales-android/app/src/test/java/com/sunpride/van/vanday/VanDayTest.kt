package com.sunpride.van.vanday

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class VanDayTest {
    private val sentJuice = SentLine("p1", "SP-PJ", "Pineapple Juice 1L", "lot1", "B-17", null, 12, 48, null, false)
    private val sentChunks = SentLine("p2", "SP-PC", "Pineapple Chunks", null, null, null, 24, 30, null, true)
    private val reasons = VanDayCodec.DEFAULT_REASONS

    private fun facts(status: String? = "loading", load: VanDayLoad? = null, vararg tweak: (DayFacts) -> DayFacts): DayFacts =
        tweak.fold(DayFacts(true, status, false, "planned", false, VanDayInfo("ABC-1234", null, emptyList(), "t1", load, "d1"), false, false, false, false, false, null, 0, false)) { f, t -> t(f) }
    private fun load(state: String, accept: Boolean = false, clerk: Boolean = false, sup: Boolean = false, start: Boolean = false) =
        VanDayLoad("pl", "ld", state, "label", "TRF-1", "Ana (clerk)", accept, clerk, sup, start, listOf(sentJuice), reasons)

    @Test fun differenceIsShortOrOverInCasesAndPieces() {
        assertEquals("Matches", LoadAccept.difference(sentJuice, 48))
        assertEquals("Short 2 PC", LoadAccept.difference(sentJuice, 46))
        assertEquals("Short 1 CS + 2 PC", LoadAccept.difference(sentJuice, 34))
        assertEquals("Over 1 CS", LoadAccept.difference(sentJuice, 60))
        assertEquals("Count this line", LoadAccept.difference(sentJuice, null))
        assertEquals("4 CS", LoadAccept.label(48, 12)); assertEquals("7 PC", LoadAccept.label(7, 12)); assertEquals("5 PC", LoadAccept.label(5, 0))
    }

    @Test fun everyLineMustBeCountedAndEveryDifferenceNeedsAReasonFromTheOfficesList() {
        val lines = listOf(sentJuice, sentChunks)
        assertFalse(LoadAccept.ready(lines, emptyMap(), reasons))
        assertEquals("2 lines are not counted yet.", LoadAccept.problem(lines, emptyMap(), reasons))
        val counts = mapOf(sentJuice.key to AcceptCount(48), sentChunks.key to AcceptCount(28))
        assertFalse(LoadAccept.ready(lines, counts, reasons))
        assertEquals("Say why the count is different on 1 line.", LoadAccept.problem(lines, counts, reasons))
        assertFalse(LoadAccept.ready(lines, counts + (sentChunks.key to AcceptCount(28, "not_a_reason")), reasons))
        val ok = counts + (sentChunks.key to AcceptCount(28, "short_loaded"))
        assertTrue(LoadAccept.ready(lines, ok, reasons)); assertNull(LoadAccept.problem(lines, ok, reasons))
    }

    @Test fun theAcceptPayloadCountsEveryBatchAndOnlyDifferingLinesCarryAReason() {
        val counts = mapOf(sentJuice.key to AcceptCount(48), sentChunks.key to AcceptCount(28, "short_loaded"))
        val p = LoadAccept.payload("trip-1", "load-1", listOf(sentJuice, sentChunks), counts, " all ok ", 1700L)
        assertEquals("trip-1", p.getString("tripId")); assertEquals("load-1", p.getString("loadId")); assertEquals(1700L, p.getLong("deviceTime")); assertEquals("all ok", p.getString("note"))
        val a = p.getJSONArray("lines").getJSONObject(0); val b = p.getJSONArray("lines").getJSONObject(1)
        assertEquals("lot1", a.getString("lotId")); assertEquals("48", a.getString("actualBase")); assertFalse(a.has("reason"))
        assertTrue(b.isNull("lotId")); assertEquals("28", b.getString("actualBase")); assertEquals("short_loaded", b.getString("reason"))
    }

    @Test fun SP0169_VAN011_routeControlTripsGetTheSettlementVersionOnLoadAcceptAndCrewSwitch() {
        // The lane's refused op: TRIP-...-VAN3-2 is on operations version 1 and the phone sent no settlementVersion -> invalid_request.
        val counts = mapOf(sentJuice.key to AcceptCount(48))
        val v1 = OperationsVersion.stamp(LoadAccept.payload("trip-1", "load-1", listOf(sentJuice), counts, null, 1700L), 1)
        assertEquals(1, v1.getInt("settlementVersion")); assertEquals(1700L, v1.getLong("deviceTime"))
        val v0 = OperationsVersion.stamp(LoadAccept.payload("trip-1", "load-1", listOf(sentJuice), counts, null, 1700L), 0)
        assertFalse(v0.has("settlementVersion"))
        val member = CrewMember("u2", "Ben", "helper", "p1", "aa", "bb")
        assertEquals(1, OperationsVersion.stamp(CrewSwitch.payload("trip-1", member, "proof", 1800L), 1).getInt("settlementVersion"))
    }

    @Test fun decodesTheServersVanDayObjectAndToleratesItsAbsence() {
        assertNull(VanDayCodec.decode(null)); assertNull(VanDayCodec.decode(JSONObject("{\"version\":2}")))
        val o = JSONObject("""{"version":1,"device":{"deviceId":"d1","vehicle":{"vehicleId":"v","vehicleCode":"V-1","plateNumber":"ABC-1234"}},
            "crew":{"onDevice":{"sessionId":"s","profileId":"u1","name":"Ana","role":"seller","since":5,"tripId":"t1"},
              "members":[{"profileId":"u1","name":"Ana","role":"seller","pinId":"p1","salt":"aa","hash":"bb"},{"profileId":"u2","name":"Ben","role":"helper","pinId":null,"salt":null,"hash":null}]},
            "tripId":"t1","load":{"plannedLoadId":"pl","loadId":"ld","state":"dispatched","label":"Sent","document":{"number":"TRF-1"},"clerkName":"Cy","canAccept":true,"waitingForClerk":false,
              "waitingForSupervisor":false,"canStartTrip":false,"agreement":null,
              "lines":[{"productId":"p1","productCode":"SP","productName":"Juice","lotId":"l1","lotNumber":"B1","expiresAt":null,"caseBase":12,"sentBase":"48","countedBase":null,"shipFirst":true}],
              "planned":[],"differenceReasons":["short_loaded","other"]}}""")
        val d = VanDayCodec.decode(o)!!
        assertEquals("ABC-1234", d.vehicleLabel); assertEquals("Phone is on van ABC-1234", CrewSwitch.phoneLine(d)); assertEquals("Ana", d.onDevice?.name)
        assertTrue(d.load!!.canAccept); assertEquals(48L, d.load!!.lines.single().sentBase); assertEquals(listOf("short_loaded", "other"), d.load!!.reasons)
        assertEquals(1, d.members.count { it.hasPin })
        assertEquals(listOf("u2"), CrewSwitch.candidates(d).map { it.profileId })
    }

    @Test fun todayShowsOneStepForEachMomentOfTheDay() {
        assertEquals(StepKind.SYNC, VanDaySteps.next(facts().copy(hasTrip = false)).kind)
        assertEquals(StepKind.ACCEPT_LOAD, VanDaySteps.next(facts("loading", load("dispatched", accept = true))).kind)
        assertEquals(StepKind.WAIT, VanDaySteps.next(facts("loading", load("recount", clerk = true))).kind)
        assertTrue(VanDaySteps.next(facts("loading", load("recount", clerk = true))).title.contains("clerk"))
        assertTrue(VanDaySteps.next(facts("loading", load("disputed", sup = true)).copy(supervisorName = "Rey")).detail.contains("Rey"))
        assertEquals(StepKind.START_TRIP, VanDaySteps.next(facts("loaded", load("accepted", start = true))).kind)
        assertEquals(StepKind.CHECK_LOAD, VanDaySteps.next(facts("loading", null)).kind)
        assertEquals(StepKind.START_TRIP, VanDaySteps.next(facts("loaded", null)).kind)
        assertEquals(StepKind.WAIT, VanDaySteps.next(facts("loading", load("dispatched", accept = true)).copy(acceptWaitingToSync = true)).kind)
        val onRoute = facts("active", null).copy(nextStore = "Sample store 3", storesLeft = 4)
        assertEquals("Next store: Sample store 3", VanDaySteps.next(onRoute).title)
        assertEquals(StepKind.LOAD_IN, VanDaySteps.next(onRoute.copy(nextStore = null, storesLeft = 0, routeOps = true)).kind)
        assertEquals(StepKind.COUNT_CASH, VanDaySteps.next(onRoute.copy(nextStore = null, storesLeft = 0)).kind)
        assertEquals(StepKind.COUNT_STOCK, VanDaySteps.next(onRoute.copy(nextStore = null, cashCounted = true)).kind)
        assertEquals(StepKind.CLOSE_TRIP, VanDaySteps.next(onRoute.copy(nextStore = null, cashCounted = true, stockCounted = true)).kind)
        assertEquals("a start saved on this phone is already on the road", StepKind.NEXT_STORE, VanDaySteps.next(facts("loaded", null).copy(startPending = true, nextStore = "S1", storesLeft = 1)).kind)
        assertEquals(StepKind.WAIT, VanDaySteps.next(facts("planned", null)).kind)
        assertEquals(StepKind.DONE, VanDaySteps.next(onRoute.copy(tripClosed = true)).kind)
        assertEquals("See the trip close", VanDaySteps.next(onRoute.copy(tripClosed = true)).button)
    }
}
