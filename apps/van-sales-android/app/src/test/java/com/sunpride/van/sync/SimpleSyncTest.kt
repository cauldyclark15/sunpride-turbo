package com.sunpride.van.sync

import com.sunpride.van.data.SyncStatus
import com.sunpride.van.pos.CloseOffice
import com.sunpride.van.pos.CloseOfficeRules
import com.sunpride.van.storage.OutboxRow
import com.sunpride.van.storage.OutboxRules
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** SP-0190: sellers see only All sent / Waiting to send / Waiting for signal; refused work belongs to the office. */
class SimpleSyncTest {
    private fun row(id: String, kind: String, status: String, code: String? = null) = OutboxRow("v2|s","d",id,"t",kind,
        """{"kind":"$kind","clientRequestId":"$id","payload":{"deviceTime":1}}""",1,null,status,code)

    @Test fun onlyThreeStatesAndRefusedWorkIsNeverCounted() {
        assertEquals("All sent", SyncHealth.line(SyncStatus(review = 4, received = 2, health = "synced")))
        assertEquals("Waiting to send (3)", SyncHealth.line(SyncStatus(queued = 2, sending = 1, review = 9, health = "synced")))
        assertEquals("Waiting for signal (1)", SyncHealth.line(SyncStatus(queued = 1, health = "retry_pending")))
        // Held under an earlier sign-in and parked work count as waiting to send.
        assertEquals("Waiting to send (5)", SyncHealth.line(SyncStatus(held = 2, phoneOnly = 3, health = "held_for_review")))
        assertEquals("All sent\nLast sent: Not yet", SyncHealth.footer(SyncStatus(review = 1), "Not yet"))
        assertEquals(setOf("All sent","Waiting to send","Waiting for signal"), SimpleSync.entries.map { it.label }.toSet())
        assertNull(SyncHealth.healthLabel("held_for_review")); assertNull(SyncHealth.healthLabel("retry_pending"))
        assertEquals(OfficeState.WITH_OFFICE, SyncHealth.office(OutboxRules.OFFICE, false))
        assertEquals(OfficeState.WITH_OFFICE, SyncHealth.office("rejected", false))
    }

    @Test fun keptResultIsReadFromThePushResponseOnlyForRefusals() {
        val op = JSONObject().put("clientOpId","id").put("opType","sale.record")
        val r = JSONObject().put("clientOpId","id").put("opType","sale.record").put("status","rejected").put("code","stock_conflict")
            .put("retryable",false).put("ack",JSONObject.NULL).put("kept",true)
        val body = JSONObject().put("version",2).put("results",JSONArray().put(r))
        assertTrue(V2VanCodec.results(body,listOf(op)).single().kept)
        r.remove("kept"); assertFalse(V2VanCodec.results(body,listOf(op)).single().kept) // older server
        r.put("status","applied").put("kept",true).put("ack",JSONObject().put("entityId","e").put("movementId",JSONObject.NULL).put("serverTime",1))
        assertFalse(V2VanCodec.results(body,listOf(op)).single().kept)
    }

    @Test fun keptRefusalIsStoredAsOfficeAndEveryBusinessRuleTreatsItAsRefused() {
        assertEquals(OutboxRules.OFFICE, OutboxRules.refusedState("rejected", kept = true))
        assertEquals(OutboxRules.OFFICE, OutboxRules.refusedState("conflict", kept = true))
        assertEquals("rejected", OutboxRules.refusedState("rejected", kept = false))
        val rows = listOf(row("a","sale.record",OutboxRules.OFFICE), row("b","sale.record","rejected"), row("c","sale.record","done"))
        // Stock and cash leave it out, exactly like a refusal.
        assertEquals(setOf("a","b"), OutboxRules.refused("v2|s", rows))
        assertEquals(OutboxRules.OFFICE, OutboxRules.reject("sending", OutboxRules.OFFICE))
        assertEquals(OutboxRules.OFFICE, OutboxRules.interrupted(OutboxRules.OFFICE))
        assertEquals(OutboxRules.OFFICE, OutboxRules.sending(OutboxRules.OFFICE))
        assertEquals(CloseOffice.REFUSED, CloseOfficeRules.state(true, OutboxRules.OFFICE, null, "active"))
        assertTrue(com.sunpride.van.storepos.StoreRefunds.local(listOf(row("r","store.refund.part",OutboxRules.OFFICE))).isEmpty())
    }

    @Test fun oneTimeResendPutsBackRefusedWorkUnchangedExceptCountsAndSpoiledReceipts() {
        assertTrue(OutboxRules.resendOnce(row("a","sale.record","rejected","stock_conflict")))
        assertTrue(OutboxRules.resendOnce(row("b","trip.close","conflict","idempotency_conflict")))
        assertFalse(OutboxRules.resendOnce(row("c","sale.record","rejected",com.sunpride.van.selling.RefusedReceipt.CODE)))
        assertFalse(OutboxRules.resendOnce(row("d","cash.reconcile","rejected")))
        assertFalse(OutboxRules.resendOnce(row("e","stock.reconcile","rejected")))
        assertFalse(OutboxRules.resendOnce(row("f","sale.record",OutboxRules.OFFICE))) // the office already has it
        assertFalse(OutboxRules.resendOnce(row("g","sale.record","done")))
        assertFalse(OutboxRules.resendOnce(row("h","sale.record","pending")))
        // The migration SQL encodes the same rule and only touches status/rejectionCode (op bytes and id untouched).
        val sql = OutboxRules.RESEND_SQL
        assertTrue(sql.startsWith("UPDATE outbox SET status='pending', rejectionCode=NULL WHERE status IN ('rejected','conflict')"))
        OutboxRules.NO_RESEND_KINDS.forEach { assertTrue(sql.contains("'$it'")) }
        assertTrue(sql.contains("'${com.sunpride.van.selling.RefusedReceipt.CODE}'"))
        assertFalse(sql.contains("operationJson") || sql.contains("clientRequestId") || sql.contains("office"))
        // It runs exactly once: as the 11→12 Room migration, registered on the encrypted database.
        assertEquals(11, com.sunpride.van.storage.VanDatabase.MIGRATION_11_12.startVersion)
        assertEquals(12, com.sunpride.van.storage.VanDatabase.MIGRATION_11_12.endVersion)
        val src = File("src/main/java/com/sunpride/van/storage/EncryptedVanDatabase.kt").readText()
        assertTrue(src.contains("VanDatabase.MIGRATION_11_12"))
    }

    private val forbidden = Regex("(?i)\\breview|reconcil|rejected|refused|invalid|supervisor|not accepted|office system|sync conflict|remove from this phone|ask your")

    @Test fun sellerSyncWordsNeverUseForbiddenWords() {
        val texts = mutableListOf<String>()
        listOf(SyncStatus(), SyncStatus(queued = 2, review = 3), SyncStatus(held = 1, health = "retry_pending")).forEach {
            texts += SyncHealth.line(it); texts += SyncHealth.footer(it, "Not yet")
        }
        listOf("synced","retry_pending","held_for_review","update_required","paused","never_synced").forEach { SyncHealth.healthLabel(it)?.let(texts::add) }
        texts += OfficeState.entries.map { it.label }
        CloseOffice.entries.forEach { texts += CloseOfficeRules.title(it); texts += CloseOfficeRules.detail(it) }
        texts += com.sunpride.van.selling.RefusedReceipt.message("SI-1"); texts += com.sunpride.van.selling.RefusedReceipt.message("CM-1","store.refund.part")
        texts += com.sunpride.van.ui.NoTripMessage.sentence("No trip",null,null,0,java.time.ZoneId.of("UTC"))
        listOf("stock_conflict","idempotency_conflict","out_of_scope","x").forEach { texts += com.sunpride.van.pos.CountOfficeRules.refusal("cash.reconcile",it) }
        texts.forEach { assertFalse("forbidden word in: $it", forbidden.containsMatchIn(it)) }
    }

    @Test fun sellerSyncScreensSourceHasNoForbiddenWords() {
        val literal = Regex("\"([^\"\\\\]|\\\\.)*\"")
        listOf("ui/SyncScreens.kt","ui/StoreScreens.kt","ui/CollectionDialog.kt","ui/NoTripMessage.kt","ui/AppNav.kt","sync/SyncHealth.kt","storepos/StoreRefunds.kt").forEach { f ->
            val text = File("src/main/java/com/sunpride/van/$f").readText()
            literal.findAll(text).map { it.value }.filterNot { it.contains("supervisor PIN") || Regex("\"[a-z_.-]+\"").matches(it) } /* op/status codes and test tags are not seller text */.forEach {
                assertFalse("$f: $it", forbidden.containsMatchIn(it))
            }
        }
    }
}
