package com.sunpride.van.ui

import com.sunpride.van.data.Customer
import com.sunpride.van.pos.CartLine
import com.sunpride.van.pos.ManualDiscountInput
import com.sunpride.van.printing.PrintAttempt
import com.sunpride.van.printing.PrintKind
import com.sunpride.van.printing.PrintOutcome
import com.sunpride.van.printing.ReprintRules
import com.sunpride.van.selling.DiscountClaim
import com.sunpride.van.selling.PrivilegeType
import com.sunpride.van.data.offMain
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.toList
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** SP-0169 r5b lane vanmore: NF-R5V-3, NF-R5V-6, VAN-051. */
class VanMoreR5Test {
    private val buyer = Customer("outlet-1", "C1", "Gulaman Store", null, 1, "route")

    @Test fun nfR5v3HoldingACartLeavesNoDiscountOnTheNextCart() {
        val held = SaleDraft("sale-1", buyer, listOf(CartLine("p1", 2)), manualDiscount = ManualDiscountInput(basketMinor = 500, reason = "promo"),
            claim = DiscountClaim(PrivilegeType.SENIOR, "R5VID0001", "R5V Tester"))
        val next = held.afterHold("sale-2")
        assertEquals("sale-2", next.saleId); assertEquals(buyer, next.customer)
        assertTrue(next.lines.isEmpty())
        assertNull("the claim stays with the held customer", next.claim)
        assertNull(next.manualDiscount); assertNull(next.priceOverride); assertNull(next.creditOverride)
    }

    @Test fun nfR5v6EveryRepositoryScreenFlowDecodesOffTheMainThread() {
        val src = File("src/main/java/com/sunpride/van/data/VanRepository.kt").readText()
        val flows = Regex("""^    val (\w+): Flow<.*$""", RegexOption.MULTILINE).findAll(src).toList()
        assertTrue("expected the screen flows", flows.size >= 15)
        val onMain = flows.filterNot { it.value.trimEnd().endsWith(".offMain()") }.map { it.groupValues[1] }
        assertEquals("screen flows still transforming on the collector's (Main) thread", emptyList<String>(), onMain)
    }

    @Test fun nfR5v6OffMainRunsTheDecodeOnTheWorkerAndSkipsRepeats() = kotlinx.coroutines.runBlocking {
        val dispatcher = java.util.concurrent.Executors.newSingleThreadExecutor { r -> Thread(r, "decode-worker") }.asCoroutineDispatcher()
        try {
            val seen = mutableListOf<String>()
            val out = flow { listOf(1, 1, 2).forEach { seen += Thread.currentThread().name; emit(it) } }.offMain(dispatcher).toList()
            assertEquals(listOf(1, 2), out)
            assertEquals(3, seen.size); assertTrue(seen.toString(), seen.all { it.startsWith("decode-worker") })
        } finally { dispatcher.close() }
    }

    private fun original(n: Int, outcome: PrintOutcome = PrintOutcome.PRINTED) = PrintAttempt("p$n", "sale-1", PrintKind.ORIGINAL, 0, null, outcome, 10L + n)

    @Test fun van051TheDidItPrintSheetShowsTheResendLimitFromSavedHistory() {
        assertNull(ReprintRules.printAgainLeft(emptyList()))
        assertEquals(3, ReprintRules.printAgainLeft(listOf(original(1))))
        assertEquals(1, ReprintRules.printAgainLeft((1..3).map { original(it) }))
        val four = (1..4).map { original(it) }
        assertEquals(0, ReprintRules.printAgainLeft(four))
        assertEquals("This receipt was sent to the printer 4 times. Answer \"Did it print?\" or ask the office for a copy.", VanRules.printAgainNote(0))
        assertEquals("You can print it again 1 more time before you answer.", VanRules.printAgainNote(1))
        assertNull(VanRules.printAgainNote(null))
        // After "Yes, printed" further copies are reprints with their own limit; the sheet note no longer applies.
        assertNull(ReprintRules.printAgainLeft(four.dropLast(1) + original(4, PrintOutcome.CONFIRMED)))
    }
}
