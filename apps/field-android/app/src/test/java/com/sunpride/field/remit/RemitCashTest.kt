package com.sunpride.field.remit

import com.sunpride.field.storage.StoreScope
import com.sunpride.field.sync.DomainOutbox
import com.sunpride.field.ui.FieldNav
import com.sunpride.field.ui.MoreRow
import com.sunpride.field.ui.AppMode
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID

/** SP-0228 Remit cash: form rules, the queued op and the server parity. */
class RemitCashTest {
    private val now = java.time.ZonedDateTime.of(2026, 11, 17, 15, 0, 0, 0, java.time.ZoneId.of("Asia/Manila")).toInstant().toEpochMilli()
    private val jpeg = byteArrayOf(0xff.toByte(), 0xd8.toByte(), 1, 2, 3, 0xff.toByte(), 0xd9.toByte())
    private val id = UUID.randomUUID().toString()

    private fun form(amount: String = "50,000", channel: String? = "palawan", other: String = "", ref: String = "007-123-456",
                     at: String = "2026-11-17 14:05", note: String = " Tuesday sales ", photo: ByteArray? = jpeg) =
        RemitCash.payload(id, amount, channel, other, ref, at, note, photo, now)

    @Test fun buildsTheWirePayloadInCentavosWithReceipt() {
        val p = form()
        assertEquals(id, p.getString("remittanceId"))
        assertEquals(5_000_000L, p.getLong("amountMinor"))
        assertEquals("palawan", p.getString("channel"))
        assertFalse(p.has("channelOther"))
        assertEquals("007-123-456", p.getString("referenceNumber"))
        assertEquals(now - 55 * 60_000L, p.getLong("remittedAt"))
        assertEquals("Tuesday sales", p.getString("note"))
        val photo = p.getJSONObject("photo")
        assertEquals("image/jpeg", photo.getString("mimeType"))
        assertEquals(java.util.Base64.getEncoder().encodeToString(jpeg), photo.getString("bytesBase64"))
        assertEquals(64, photo.getString("sha256").length)
        assertEquals(125_050L, form(amount = "1250.50").getLong("amountMinor"))
        assertEquals("M Lhuillier", form(channel = "other", other = " M Lhuillier ").getString("channelOther"))
        assertFalse(form(note = "").has("note"))
    }

    @Test fun refusesIncompleteFormsInPlainWords() {
        fun refused(message: String, block: () -> JSONObject) =
            assertEquals(message, assertThrows(IllegalArgumentException::class.java) { block() }.message)
        refused("Enter the amount you remitted") { form(amount = " ") }
        refused("Enter an amount more than ₱0") { form(amount = "0") }
        assertThrows(IllegalArgumentException::class.java) { form(amount = "1.005") }
        assertThrows(IllegalArgumentException::class.java) { form(amount = "abc") }
        refused("Choose where you remitted the cash") { form(channel = null) }
        refused("Choose where you remitted the cash") { form(channel = "western") }
        refused("Write the name of the remittance center") { form(channel = "other") }
        refused("Enter the reference number from the receipt") { form(ref = "  ") }
        refused("Take a photo of the receipt") { form(photo = null) }
        refused("Retake the receipt photo") { form(photo = byteArrayOf(1, 2, 3, 4)) }
        refused("The remittance time cannot be in the future") { form(at = "2026-11-18 09:00") }
        refused("Record remittances from the last 30 days only") { form(at = "2026-09-01 09:00") }
        assertThrows(IllegalArgumentException::class.java) { form(at = "17/11/2026") }
    }

    @Test fun queuesThroughTheSharedOutboxWithAFrozenCopy() {
        assertTrue(DomainOutbox.isDomain(RemitCash.KIND))
        val p = form()
        val row = DomainOutbox.intent(StoreScope("acct", "device", "fp"), RemitCash.KIND, p, id, at = 1234)
        p.put("amountMinor", 1)
        val op = JSONObject(row.serializedOperation)
        assertEquals(RemitCash.KIND, op.getString("kind"))
        assertEquals(row.requestId, op.getString("clientRequestId"))
        assertEquals(5_000_000L, op.getJSONObject("payload").getLong("amountMinor"))
        assertEquals(1234L, op.getJSONObject("payload").getLong("deviceTime"))
        assertEquals(id, row.clientVisitId)
    }

    @Test fun moreShowsRemitCashOnlyForSellingPeopleOutsideMapping() {
        assertTrue(MoreRow.REMIT_CASH in FieldNav.moreWorkRows(AppMode.SELLING, true, false, false, remit = true))
        assertTrue(MoreRow.REMIT_CASH in FieldNav.moreWorkRows(AppMode.VISITS, true, false, false, remit = true))
        assertFalse(MoreRow.REMIT_CASH in FieldNav.moreWorkRows(AppMode.SELLING, true, false, false, remit = false))
        assertFalse(MoreRow.REMIT_CASH in FieldNav.moreWorkRows(AppMode.MAPPING, true, false, false, remit = true))
    }

    @Test fun channelsMatchTheServer() {
        val model = File("../../api/src/domains/remittances/model.js").readText()
        val server = Regex("CHANNELS = Object.freeze\\(\\[([^\\]]*)\\]").find(model)!!.groupValues[1]
            .split(",").map { it.trim().trim('"') }.filter { it.isNotEmpty() }
        assertEquals(server, RemitCash.CHANNELS.map { it.first })
    }
}
