package com.sunpride.van.printing

import com.sunpride.van.printing.escpos.PrinterChoice
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class SelectablePrinterTest {
    private class MemoryStore(var saved: PrinterChoice? = null) : PrinterChoiceStore {
        override fun load() = saved
        override fun save(choice: PrinterChoice?) { saved = choice }
    }

    private val bluetooth = PrinterChoice("00:11:22:AA:BB:CC", "MPT-II", 80)

    @Test fun startsWithTheSavedChoiceAndSwitchesWithoutRestart() = runBlocking {
        val built = mutableListOf<Pair<PrinterChoice?, FakeReceiptPrinter>>()
        val store = MemoryStore()
        val printer = SelectablePrinter(store) { choice -> FakeReceiptPrinter().also { built += choice to it } }
        assertNull(printer.choice)
        assertEquals(1, built.size)
        printer.connect()
        assertEquals(PrintResult.Success, printer.print(TestReceipts.build("H10P", "209")))

        printer.select(bluetooth)
        assertEquals(bluetooth, store.saved)
        assertEquals(bluetooth, printer.choice)
        assertSame(built[1].second, printer.active)
        // The old printer was closed; the new one is used for the next receipt.
        assertEquals(PrinterStatus.Disconnected, built[0].second.status())
        printer.connect()
        printer.print(TestReceipts.build("H10P", "ESC/POS"))
        assertEquals(1, built[1].second.documents.size)

        printer.select(null)
        assertNull(store.saved)
        assertNull(built[2].first)

        // A fresh app start picks up what was saved.
        store.saved = bluetooth
        val restarted = SelectablePrinter(store) { choice -> FakeReceiptPrinter().also { built += choice to it } }
        assertEquals(bluetooth, restarted.choice)
        assertEquals(bluetooth, built.last().first)
        restarted.close()
        printer.close()
    }

    @Test fun choiceCapabilitiesFollowPaperWidth() {
        assertEquals(48, bluetooth.capabilities().charactersPerLine)
        assertEquals(32, PrinterChoice("00:11:22:AA:BB:CC", "x").capabilities().charactersPerLine)
        assertFalse(bluetooth.capabilities().cutter)
        listOf({ PrinterChoice("not-an-address", "x") }, { PrinterChoice("00:11:22:AA:BB:CC", "x", 72) }).forEach {
            assertTrue(runCatching(it).isFailure)
        }
    }

    @Test fun setupProblemsHavePlainWords() {
        PrinterSetupProblem.entries.forEach { problem ->
            val words = PrinterWords.status(PrinterStatus.NeedsSetup(problem))
            assertTrue(words.isNotBlank() && words.none(Char::isDigit))
        }
    }
}
