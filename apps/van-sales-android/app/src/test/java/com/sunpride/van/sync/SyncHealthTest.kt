package com.sunpride.van.sync

import com.sunpride.van.data.SyncStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncHealthTest {
    private fun op(id: String, kind: String, status: String, at: Long, payload: String = "{}") =
        OutboxFacts(id, kind, status, at, """{"kind":"$kind","clientRequestId":"$id","payload":$payload}""", if (status == "rejected") "invalid_request" else null)

    @Test fun officeStateComesFromTheOutboxStatusOnly() {
        assertEquals(OfficeState.PHONE_ONLY, SyncHealth.office("parked", false))
        assertEquals(OfficeState.PHONE_ONLY, SyncHealth.office("parked", true))
        assertEquals(OfficeState.WAITING, SyncHealth.office("pending", false))
        assertEquals(OfficeState.SENDING, SyncHealth.office("sending", false))
        assertEquals(OfficeState.PAUSED, SyncHealth.office("pending", true))
        assertEquals(OfficeState.PAUSED, SyncHealth.office("sending", true))
        assertEquals(OfficeState.RECEIVED, SyncHealth.office("done", true))
        assertEquals(OfficeState.NEEDS_REVIEW, SyncHealth.office("rejected", false))
        assertEquals(OfficeState.NEEDS_REVIEW, SyncHealth.office("conflict", false))
    }

    @Test fun nothingIsEverShownAsPostedToSap() {
        listOf("sale.record", "sale.void", "return.record", "cash.reconcile", "load.confirm", "truck.damage").forEach {
            assertEquals(SapState.NOT_POSTED, SyncHealth.sap(it))
        }
        assertEquals(SapState.NOT_NEEDED, SyncHealth.sap("trip.start"))
        assertTrue(SapState.entries.all { it.label.startsWith("Not ") || it.label.startsWith("No ") })
    }

    @Test fun itemsAreNewestFirstWithReferencesAndBounded() {
        val rows = listOf(
            op("a", "load.confirm", "done", 1),
            op("b", "trip.start", "done", 2),
            op("c", "sale.record", "parked", 3, """{"receiptNumber":"TRIP-1-0001"}"""),
            op("d", "return.record", "parked", 3, """{"returnNumber":"TRIP-1-0002"}"""),
            op("e", "truck.damage", "rejected", 4),
        )
        val items = SyncHealth.items(rows, held = false)
        assertEquals(listOf("e", "c", "d", "b", "a"), items.map { it.clientRequestId })
        assertEquals("TRIP-1-0001", items[1].reference)
        assertEquals("TRIP-1-0002", items[2].reference)
        assertEquals("Customer return", items[2].title)
        assertEquals(OfficeState.NEEDS_REVIEW, items[0].office)
        assertEquals(SapState.NOT_NEEDED, items[3].sap)
        assertEquals(2, SyncHealth.items(rows, false, limit = 2).size)
        // A malformed operation never breaks the screen; it just has no reference.
        assertEquals(null, SyncHealth.items(listOf(OutboxFacts("x", "sale.record", "parked", 1, "not json")), false).single().reference)
    }

    @Test fun footerKeepsPhoneOfficeAndSapSeparate() {
        val s = SyncStatus(queued = 1, sending = 1, review = 1, held = 0, savedSales = 2, savedReturns = 1,
            phoneOnly = 4, received = 3, sapPending = 6)
        val lines = SyncHealth.footer(s, "Oct 7, 9:00 AM").lines()
        assertEquals("Phone: 6 items kept only on this phone", lines[0])
        assertEquals("2 sales saved on this phone", lines[1])
        assertEquals("1 return saved on this phone", lines[2])
        assertEquals("Office: 3 received · 2 waiting · 1 to review", lines[3])
        assertEquals("Last sync: Oct 7, 9:00 AM", lines[4])
        assertEquals("SAP: 6 not posted yet", lines[5])
    }

    @Test fun pausedWorkCountsAsOnThePhoneAndIsNamed() {
        val s = SyncStatus(held = 2, received = 1)
        assertEquals(2, SyncHealth.onPhoneOnly(s))
        assertTrue(SyncHealth.officeLine(s, "Not yet").contains("2 paused"))
        assertEquals("Phone: nothing waiting — all work is with the office", SyncHealth.phoneLine(SyncStatus(received = 5)))
        assertEquals("SAP: nothing to post yet", SyncHealth.sapLine(SyncStatus()))
        assertFalse(SyncHealth.footer(SyncStatus(), "Not yet").contains("saved on this phone"))
    }

    @Test fun healthCodesBecomePlainWordsAndUnknownCodesAreNotEchoed() {
        assertEquals("Last sync did not finish — it will try again", SyncHealth.healthLabel("retry_pending"))
        assertEquals("Sync state unknown", SyncHealth.healthLabel("weird_server_text"))
    }
}
