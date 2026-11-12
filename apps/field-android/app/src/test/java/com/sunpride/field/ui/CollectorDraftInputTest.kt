package com.sunpride.field.ui

import com.sunpride.field.orders.PresellDates
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** FLD-122: an empty or mistyped day on Collections is a plain field error, never a crash. */
class CollectorDraftInputTest {
    private fun failure(block: () -> Unit): Throwable {
        val r = CollectorDraft.guarded(block)
        assertTrue("must fail as a field error, not crash", r.isFailure)
        return r.exceptionOrNull()!!
    }

    @Test fun emptyPromiseDayIsAFieldError() {
        val e = failure { CollectorDraft.promise("2026-11-13", "C1", "will pay", "100", "", "ref", "hash") }
        assertEquals("Enter the promise day as YYYY-MM-DD", e.message)
    }

    @Test fun emptyChequeDayIsAFieldError() {
        val e = failure { CollectorDraft.cheque("2026-11-13", "C1", "note", "100", "", "BDO", "123", null, null) }
        assertEquals("Enter the cheque day as YYYY-MM-DD", e.message)
    }

    @Test fun mistypedDaysAreFieldErrors() {
        for (bad in listOf("13/11/2026", "2026-02-30", "2026-1-5", "tomorrow")) {
            val e = failure { CollectorDraft.promise("2026-11-13", "C1", "n", "100", bad, "ref", "hash") }
            assertTrue(e.message!!, e.message!!.startsWith("Enter the promise day as a real date"))
        }
    }

    @Test fun badAmountAndMissingAnswersAreFieldErrors() {
        failure { CollectorDraft.promise("2026-11-13", "C1", "n", "", "2026-11-20", "ref", "hash") }
        failure { CollectorDraft.promise("2026-11-13", "C1", "n", "1e99", "2026-11-20", "ref", "hash") }
        failure { CollectorDraft.promise("2026-11-13", "C1", "n", "100", "2026-11-20", null, "hash") }
        failure { CollectorDraft.cheque("2026-11-13", "C1", "", "100", "2026-11-20", "", "", null, null) }
    }

    @Test fun guardedTurnsRawParseFailuresIntoMessages() {
        assertEquals("Enter the date as YYYY-MM-DD", failure { java.time.LocalDate.parse("") }.message)
        failure { java.math.BigDecimal("x") }
    }

    @Test fun validPromiseBuildsPayload() {
        val p = CollectorDraft.promise("2026-11-13", "C1", " will pay ", "1,0".replace(",", "."), " 2026-11-20 ", "ref", "hash")
        assertEquals("2026-11-20", p.getString("promisedOn")); assertEquals(100L, p.getLong("amountMinor")); assertEquals("will pay", p.getString("note"))
    }

    @Test fun malformedDeliveryDayIsAFieldError() {
        val e = runCatching { PresellDates.validate(null, "2026-1-5", 0) }.exceptionOrNull()
        assertTrue(e is IllegalArgumentException)
    }
}
