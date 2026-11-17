package com.sunpride.field.storage

import androidx.sqlite.db.SupportSQLiteDatabase
import com.sunpride.field.ui.diagnosticvisit.VisitIntentFactory
import org.junit.Assert.*
import org.junit.Test

/**
 * SP-0189 rule 1: on the first start of this build every refused (`review`) outbox row goes back to `pending` once.
 * The persisted mark is the Room 9 -> 10 migration itself (Room runs a migration exactly once per database); the
 * real SQL against a v9 database is proven in androidTest StoreMigrationTest.v9ToV10ResendsEarlierRefusedSavesOnce.
 */
class ResendRefusedOnceTest {
    @Test fun migrationIsNineToTenAndOnlyTouchesRefusedRows() {
        val m = EncryptedFieldDatabase.MIGRATION_9_10
        assertEquals(9, m.startVersion); assertEquals(10, m.endVersion)
        val sql = mutableListOf<String>()
        val db = java.lang.reflect.Proxy.newProxyInstance(javaClass.classLoader, arrayOf(SupportSQLiteDatabase::class.java)) { _, method, args ->
            if (method.name == "execSQL") sql += args!![0] as String; null
        } as SupportSQLiteDatabase
        m.migrate(db)
        assertEquals(listOf(EncryptedFieldDatabase.RESEND_REFUSED_SQL, EncryptedFieldDatabase.FORGET_DISMISSED_SQL), sql)
        val resend = sql[0]
        // Only the state goes back: requestId (clientOpId) and the serialized operation are never touched.
        assertTrue(resend.startsWith("UPDATE outbox SET state='pending', rejectionCode=NULL WHERE state='review'"))
        assertFalse(resend.contains("requestId")); assertFalse(resend.contains("intents"))
        // A save the server already kept for the office is not sent again.
        assertFalse(resend.contains("office"))
    }

    @Test fun keptAndRefusedRowsBlockTheSameBusinessRules() {
        val scope = StoreScope("a", "d", "s")
        val start = VisitIntentFactory.create(scope, "visit.checkIn", null, null, null, "p", "o", emptyList(), null, null, null, null, null, 1000)
        for (state in listOf("review", "office")) {
            assertTrue(OutboxState.refused(state))
            val rows = listOf(start to state)
            assertFalse(VisitCallRules.started(rows))
            val e = assertThrows(VisitRuleFailure::class.java) { EvidencePhotos.requireOpenCall(start.clientVisitId, start.requestId, rows) }
            assertEquals(VisitRuleFailure.Code.CALL_NOT_OPEN, e.code)
        }
        // After the resend the row is pending: the call counts as started again, exactly like a fresh save.
        assertTrue(VisitCallRules.started(listOf(start to "pending")))
        EvidencePhotos.requireOpenCall(start.clientVisitId, start.requestId, listOf(start to "pending"))
        assertFalse(OutboxState.refused("pending")); assertFalse(OutboxState.refused("done")); assertFalse(OutboxState.refused(null))
    }
}

class KeptFlagWireTest {
    /** SP-0189: the v2 push result's `kept` reaches the outbox code through the v1 adapter unchanged. */
    @Test fun v2ResultKeepsTheKeptFlag() {
        val r = com.sunpride.field.sync.V2Wire.result(org.json.JSONObject().put("clientOpId", "op-1").put("opType", "census.capture")
            .put("status", "rejected").put("code", "invalid_request").put("retryable", false).put("kept", true))
        assertEquals("rejected", r.getString("status")); assertTrue(r.optBoolean("kept"))
        val old = com.sunpride.field.sync.V2Wire.result(org.json.JSONObject().put("clientOpId", "op-1").put("opType", "census.capture")
            .put("status", "rejected").put("code", "invalid_request").put("retryable", false))
        assertFalse(old.optBoolean("kept"))
    }
}
