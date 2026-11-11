package com.sunpride.field.ui.customers

import com.sunpride.field.storage.CallSheetHeader
import com.sunpride.field.storage.IntentRow
import com.sunpride.field.storage.SnapshotItem
import com.sunpride.field.ui.VisitDisplay
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CustomerDirectoryTest {
    private fun outlet(id: String, name: String, code: String? = null, customerId: String? = null,
        address: String? = null, routeId: String? = null, lat: Double? = null, lng: Double? = null) =
        SnapshotItem(id, JSONObject().put("id", id).put("name", name).put("routeId", routeId ?: JSONObject.NULL).apply {
            code?.let { put("code", it) }; customerId?.let { put("customerId", it) }; address?.let { put("address", it) }
            lat?.let { put("latitude", it) }; lng?.let { put("longitude", it) }
        }.toString())

    private fun visit(id: String, outletId: String, day: String, vararg intents: String) =
        SnapshotItem(id, JSONObject().put("id", id).put("outletId", outletId).put("serviceDate", day)
            .put("planId", "plan").put("planVersion", 1).put("intents", org.json.JSONArray(intents.toList())).toString(), day)

    private fun intent(id: String, call: String, kind: String, payload: JSONObject, at: Long) =
        IntentRow("acct", "dev", "scope", id, call, kind,
            JSONObject().put("kind", kind).put("clientRequestId", id).put("payload", payload.put("deviceTime", at)).toString(), at)

    private val header = CallSheetHeader("Peña Sari-Sari", "12 Rizal Ave", "Ana Cruz", "0917 123 4567",
        "J. Santos", null, "North Dist", "Mon/Thu", null, null)

    private fun directory(): List<CustomerRecord> = CustomerDirectory.build(
        outlets = listOf(
            outlet("o1", "Peña Sari-Sari Store", "OUT-001", "c1", "12 Rizal Ave, Pasig", "r1", 14.5, 121.0),
            outlet("o2", "Sto. Niño Grocery", "OUT-002", null, null, "r2"),
            outlet("o3", "Cruz Minimart", "MIN-77", "c3", "Ortigas Ave", null, 14.5, null),
        ),
        customers = mapOf("c1" to "CUST-9", "c3" to " "),
        visits = listOf(visit("p1", "o1", "2026-10-04", "sell", "merchandise_check"),
            visit("p1b", "o1", "2026-10-05"), visit("p2", "o2", "2026-10-04")),
        routeJson = JSONObject().put("id", "r1").put("code", "PSG-01").toString(),
        accounts = mapOf("o1" to header),
        history = listOf(
            intent("q1", "call-1", "visit.checkIn", JSONObject().put("outletId", "o1").put("plannedVisitId", "p1"), 1_000) to "done",
            intent("q2", "call-1", "visit.activity", JSONObject().put("visitId", "@checkin:q1")
                .put("activity", JSONObject().put("kind", "note").put("text", "hi")), 2_000) to "pending",
            intent("q3", "call-1", "visit.checkOut", JSONObject().put("visitId", "@checkin:q1")
                .put("outcome", "nonproductive").put("reasonCode", "closed"), 3_000) to "review",
            intent("q4", "call-2", "visit.checkIn", JSONObject().put("outletId", "o3").put("plannedVisitId", JSONObject.NULL), 500) to "done",
        ),
        today = listOf(VisitDisplay("Sto. Niño Grocery", "Planned", "Scheduled", "o2", "p2", sequence = 1),
            VisitDisplay("Peña Sari-Sari Store", "Planned", "In progress", "o1", "p1", sequence = 2)),
    )

    @Test fun projectsSummaryRouteAndPlanFromTheCachedSnapshot() {
        val records = directory().associateBy { it.outletId }
        val peña = records.getValue("o1")
        assertEquals("OUT-001", peña.outletCode)
        assertEquals("CUST-9", peña.customerCode)
        assertEquals("PSG-01", peña.routeCode)
        assertEquals(header, peña.account)
        assertEquals(listOf("2026-10-04", "2026-10-05"), peña.planned.map { it.serviceDate })
        assertEquals(listOf("sell", "merchandise_check"), peña.planned.first().intents)
        assertEquals("p1", peña.today?.plannedVisitId)
        // Another route is not the person's downloaded route; a blank customer code is dropped.
        assertNull(records.getValue("o2").routeCode)
        assertNull(records.getValue("o3").customerCode)
        // Half a pin is no pin.
        assertNull(records.getValue("o3").latitude)
    }

    @Test fun historyIsGroupedByTheCallsOutletNewestFirstWithSendState() {
        val history = directory().first { it.outletId == "o1" }.history
        assertEquals(listOf("Call ended · Not productive (closed)", "Note added", "Call started"), history.map { it.label })
        assertEquals(listOf("Needs review", "Waiting to send", "Sent"), history.map { it.state })
        assertEquals(listOf("Unplanned call started"), directory().first { it.outletId == "o3" }.history.map { it.label })
        assertTrue(directory().first { it.outletId == "o2" }.history.isEmpty())
    }

    @Test fun searchIsAccentAndCaseInsensitiveAndMatchesEveryWord() {
        val records = directory()
        assertEquals(listOf("o1"), CustomerDirectory.search(records, "pena").map { it.outletId })
        assertEquals(listOf("o2"), CustomerDirectory.search(records, "STO NINO").map { it.outletId })
        assertEquals(listOf("o1"), CustomerDirectory.search(records, "rizal pasig").map { it.outletId })
        assertEquals(listOf("o1"), CustomerDirectory.search(records, "ana cruz").map { it.outletId }) // buyer
        assertEquals(listOf("o1"), CustomerDirectory.search(records, "cust-9").map { it.outletId })
        assertEquals(listOf("o1"), CustomerDirectory.search(records, "psg").map { it.outletId }) // route code
        assertTrue(CustomerDirectory.search(records, "pena ortigas").isEmpty())
    }

    @Test fun exactCodeRanksFirstThenTodaysRouteOrderThenName() {
        val records = directory()
        // "cruz" matches o1's buyer and o3's name; the name prefix ranks first.
        assertEquals(listOf("o3", "o1"), CustomerDirectory.search(records, "cruz").map { it.outletId })
        assertEquals("o3", CustomerDirectory.search(records, "min-77").first().outletId)
        // Blank query: today's stops in route order, then the rest by name.
        assertEquals(listOf("o2", "o1", "o3"), CustomerDirectory.search(records, "  ").map { it.outletId })
    }

    @Test fun storeCodeSearchMatchesTheOfficeCompactCodeRule() {
        // FLD-046 / EDGE-006: the phone must find a store under every spelling the web finds.
        val records = CustomerDirectory.build(
            outlets = listOf(outlet("t", "Target Store", "SMP-00069"), outlet("x", "Other Store", "SMP-00169"),
                outlet("y", "Next Store", "SMP-00070")),
            customers = emptyMap(), visits = emptyList(), routeJson = null, accounts = emptyMap(),
            history = emptyList(), today = emptyList())
        for (q in listOf("SMP-00069", "SMP-O0069", "smp00069", "smp o 0069", "SMP-O-0069", "smp\u201100069")) {
            assertEquals(q, "t", CustomerDirectory.search(records, q).firstOrNull()?.outletId)
        }
        assertEquals(listOf("y"), CustomerDirectory.search(records, "SMP-00070").map { it.outletId })
        assertTrue(CustomerDirectory.search(records, "SMP-690").isEmpty())
        assertEquals("smp69", CustomerDirectory.compactCode("SMP-O0069"))
    }

    @Test fun dialUriAcceptsPhoneNumbersOnly() {
        assertEquals("tel:09171234567", CustomerDirectory.dialUri("0917 123 4567"))
        assertEquals("tel:+6328123456", CustomerDirectory.dialUri("+63 (2) 812-3456"))
        assertNull(CustomerDirectory.dialUri("Ask the owner"))
        assertNull(CustomerDirectory.dialUri("123"))
        assertNull(CustomerDirectory.dialUri("12+3456789"))
        assertNull(CustomerDirectory.dialUri(null))
    }

    @Test fun labelsAreRelativeToTheManilaServiceDay() {
        val now = java.time.ZonedDateTime.parse("2026-10-04T09:00:00+08:00").toInstant().toEpochMilli()
        assertEquals("Today", CustomerDirectory.dayLabel("2026-10-04", now))
        assertEquals("Tomorrow", CustomerDirectory.dayLabel("2026-10-05", now))
        assertEquals("Tue, Oct 6", CustomerDirectory.dayLabel("2026-10-06", now))
        assertEquals("9:00 AM", CustomerDirectory.timeLabel(now, now))
        assertEquals("Oct 3, 9:00 AM", CustomerDirectory.timeLabel(now - 86_400_000, now))
        assertEquals("Merchandise check", CustomerDirectory.kindLabel("merchandise_check"))
    }

    @Test fun malformedRowsAreSkippedNotFatal() {
        val records = CustomerDirectory.build(listOf(SnapshotItem("bad", "{"), outlet("o1", "Ok")), emptyMap(),
            listOf(SnapshotItem("v", "nope", "2026-10-04")), "not json", emptyMap(), emptyList(), emptyList())
        assertEquals(listOf("o1"), records.map { it.outletId })
    }
    @Test fun storeOwnerContactWinsOverTheAccountHeader() {
        val withOwner = SnapshotItem("o1", JSONObject().put("id", "o1").put("name", "Peña").put("routeId", JSONObject.NULL)
            .put("ownerName", "New Owner").put("ownerPhone", "0917 555 0199").toString())
        val records = CustomerDirectory.build(listOf(withOwner, outlet("o2", "No owner")), emptyMap(), emptyList(), null,
            mapOf("o1" to header, "o2" to header), emptyList(), emptyList()).associateBy { it.outletId }
        // Approved Edit store owner/phone come back on the outlet and replace the account header's buyer/contact.
        assertEquals("New Owner", records.getValue("o1").contactName)
        assertEquals("0917 555 0199", records.getValue("o1").contactPhone)
        assertEquals("tel:09175550199", CustomerDirectory.dialUri(records.getValue("o1").contactPhone))
        // Without an owner contact the account header still works as before.
        assertEquals("Ana Cruz", records.getValue("o2").contactName)
        assertEquals("0917 123 4567", records.getValue("o2").contactPhone)
    }

    /** FLD-052 (r4): a sheet holding only the store's own name used to leave Summary with no account line at all. */
    @Test fun summaryAlwaysSaysSomethingAboutTheAccount() {
        val bare = CallSheetHeader("Sample Luz Sari-sari", null, null, null, null, null, null, null, null, null)
        val (rows, note) = CustomerDirectory.accountFacts(CustomerRecord("o1", "Sample Luz Sari-sari", account = bare))
        assertTrue(rows.isEmpty())
        assertEquals("No account details yet", note)
        assertEquals("No account sheet yet", CustomerDirectory.accountFacts(CustomerRecord("o1", "S")).second)
        val (full, none) = CustomerDirectory.accountFacts(CustomerRecord("o1", "Store", account = header, ownerName = "Lito"))
        assertEquals(listOf("Account", "Owner", "Contact", "Account in charge", "Distributor", "Delivery schedule"), full.map { it.first })
        assertNull(none)
    }

    /** FLD-207: an open UNPLANNED call has no today row, but the Stores row still says "In progress". */
    @Test fun openUnplannedCallMarksTheStoreInProgress() {
        val records = directory().associateBy { it.outletId }
        assertTrue(records.getValue("o3").callOpen)
        assertEquals("In progress", records.getValue("o3").visitStatus)
        assertEquals(false, records.getValue("o2").callOpen)
        assertNull(records.getValue("o2").visitStatus)
    }
}
