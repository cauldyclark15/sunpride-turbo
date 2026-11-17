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
        assertEquals(OfficeState.WITH_OFFICE, SyncHealth.office("rejected", false))
        assertEquals(OfficeState.WITH_OFFICE, SyncHealth.office("conflict", false))
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
        assertEquals(OfficeState.WITH_OFFICE, items[0].office)
        assertEquals(SapState.NOT_NEEDED, items[3].sap)
        assertEquals(2, SyncHealth.items(rows, false, limit = 2).size)
        // A malformed operation never breaks the screen; it just has no reference.
        assertEquals(null, SyncHealth.items(listOf(OutboxFacts("x", "sale.record", "parked", 1, "not json")), false).single().reference)
    }

    @Test fun pausedWorkCountsAsWaitingToSend() {
        val s = SyncStatus(held = 2, received = 1)
        assertEquals(2, SyncHealth.onPhoneOnly(s))
        assertEquals("Waiting to send (2)", SyncHealth.line(s))
        assertFalse(SyncHealth.footer(SyncStatus(), "Not yet").contains("saved on this phone"))
    }

    @Test fun healthCodesBecomePlainWordsAndUnknownCodesAreNotEchoed() {
        assertEquals("Update the app to send your work", SyncHealth.healthLabel("update_required"))
        assertEquals(null, SyncHealth.healthLabel("weird_server_text"))
    }
}
