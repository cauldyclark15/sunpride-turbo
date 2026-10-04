package com.sunpride.field.storage

import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.field.ui.diagnosticvisit.VisitIntentFactory
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.time.Instant
import java.util.UUID

class FieldDayStoreTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val identity = StoreScope("fieldday|${UUID.randomUUID()}", "emulator", "scope")
    private lateinit var db: StoreDatabase
    private val at = Instant.parse("2026-10-02T02:00:00Z").toEpochMilli()
    private val day = "2026-10-02"
    private fun store() = RoomFieldStore(db, identity)
    private fun plan(id: String, sequence: Int? = null) = SnapshotItem(id,
        JSONObject().put("id", id).put("outletId", id).put("serviceDate", day)
            .apply { sequence?.let { put("sequence", it) } }.toString(), day)
    private suspend fun ready(plans: List<SnapshotItem>) {
        store().swap(store().stage(ScopedSnapshot("{}", null, plans, emptyList(), emptyList(), emptyList())),
            "cursor", at + 100_000_000, at + 100_000_000)
    }
    private fun start(id: String, planned: Boolean = true) = VisitIntentFactory.create(identity, "visit.checkIn",
        null, null, null, if (planned) id else null, id, emptyList(), "Requested", null, null, null, null, at)
    private fun end(start: IntentRow) = VisitIntentFactory.create(identity, "visit.checkOut", start.clientVisitId,
        start.requestId, start.requestId, null, "", emptyList(), null, null, "completed", null, null, at + 24 * 60_000)
    @Before fun open() { db = EncryptedFieldDatabase.open(context) }
    @After fun close() { db.close() }
    @Test fun routeCodeComesFromThePromotedSnapshotOnly() = runBlocking {
        assertNull(store().routeCode())
        val generation = store().stage(ScopedSnapshot("{}", JSONObject().put("id", "r1").put("code", "R-07").toString(),
            listOf(plan("a", 0)), emptyList(), emptyList(), emptyList()))
        assertNull(store().routeCode()) // staged, not yet promoted
        store().swap(generation, "cursor", at + 100_000_000, at + 100_000_000)
        db.close(); db = EncryptedFieldDatabase.open(context)
        assertEquals("R-07", store().routeCode())
        ready(listOf(plan("a", 0))) // a later day without a route clears it
        assertNull(store().routeCode())
        Unit
    }
    @Test fun absentSequenceRetainsOriginalBootstrapListOrderAcrossReopen() = runBlocking {
        ready(listOf(plan("z"), plan("a")))
        db.close(); db = EncryptedFieldDatabase.open(context)
        assertEquals(listOf("z", "a"), store().todaysVisits(day).map { it.id })
        Unit
    }
    @Test fun sequencePersistsAndTransactionalStoreCannotBypassOrderOrOpenCall() = runBlocking {
        ready(listOf(plan("b", 1), plan("a", 0)))
        db.close(); db = EncryptedFieldDatabase.open(context)
        assertEquals(listOf("a", "b"), store().todaysVisits(day).map { it.id })
        assertEquals(VisitRuleFailure.Code.MCP_ORDER, assertThrows(VisitRuleFailure::class.java) {
            runBlocking { store().enqueue(start("b"), at) }
        }.code)
        assertTrue(store().history().isEmpty())
        val a = start("a"); store().enqueue(a, at)
        assertEquals(VisitRuleFailure.Code.CALL_OPEN, assertThrows(VisitRuleFailure::class.java) {
            runBlocking { store().enqueue(start("c", false), at) }
        }.code)
        store().recordAck(a.requestId, "server-a", "[]", at)
        assertEquals(VisitRuleFailure.Code.CALL_OPEN, assertThrows(VisitRuleFailure::class.java) {
            runBlocking { store().enqueue(start("b"), at) }
        }.code)
        val incompleteEnd = end(a).let { row -> row.copy(serializedOperation = JSONObject(row.serializedOperation)
            .apply { getJSONObject("payload").remove("outcome") }.toString()) }
        assertEquals(VisitRuleFailure.Code.OUTCOME_REQUIRED, assertThrows(VisitRuleFailure::class.java) {
            runBlocking { store().enqueue(incompleteEnd, at) }
        }.code)
        assertEquals(1, store().history().size)
        store().enqueue(end(a), at)
        store().enqueue(start("b"), at)
        assertEquals(3, store().history().size)
        assertEquals("24 min", VisitCallRules.timeSpent(store().history().take(2).map { it.first to it.second.state }))
        Unit
    }
    @Test fun expiredCloseRetainsPendingForDeliveryAndShowsLateUsingServiceDay() = runBlocking {
        ready(emptyList())
        val a = start("a", false); store().enqueue(a, at)
        val close = com.sunpride.field.ui.syncstatus.dayClose(day)
        assertEquals("Sync before 10 PM", store().status().label(close - 1))
        assertEquals("Late · held for review", store().status().label(close))
        assertEquals(a.serializedOperation, store().pending().single().first.serializedOperation)
        Unit
    }
}
