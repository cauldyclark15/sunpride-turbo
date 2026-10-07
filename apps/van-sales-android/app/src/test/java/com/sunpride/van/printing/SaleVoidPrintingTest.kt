package com.sunpride.van.printing

import com.sunpride.van.data.*
import org.junit.Assert.*
import org.junit.Test

class SaleVoidPrintingTest {
    private fun a(kind: PrintKind = PrintKind.VOID, outcome: PrintOutcome = PrintOutcome.PRINTED) = PrintAttempt("p","s",kind,1,null,outcome,1)
    @Test fun voidAlwaysPrintsOnlyVoidEvenAfterOriginalAndReprints() {
        val original = listOf(a(PrintKind.ORIGINAL),a(PrintKind.REPRINT))
        assertEquals(PrintDecision.Print(PrintKind.VOID,1,null),ReprintRules.decide(original,false,null,true))
        assertEquals(PrintDecision.Print(PrintKind.VOID,1,null),ReprintRules.decide(original,true,"office_copy",true))
        val history = original + a(outcome = PrintOutcome.STARTED) + a(outcome = PrintOutcome.NOT_PRINTED)
        assertEquals(PrintDecision.Refused(PrintRefusal.ALREADY_PRINTED),ReprintRules.decide(history,false,null,true))
        assertEquals(PrintDecision.Print(PrintKind.VOID,2,null),ReprintRules.decide(history,true,null,true))
        assertEquals(PrintDecision.Print(PrintKind.VOID,4,null),ReprintRules.decide(List(3) { a(outcome = PrintOutcome.MAYBE_PRINTED) },true,null,true))
        assertEquals(PrintDecision.Refused(PrintRefusal.LIMIT_REACHED),ReprintRules.decide(List(4) { a() },true,null,true))
        assertEquals(PrintDecision.Print(PrintKind.ORIGINAL,0,null),ReprintRules.decide(listOf(a()),false,null))
    }
    @Test fun voidSlipUsesFrozenSaleAndManilaAuditWithoutReprintBanner() {
        val r = SaleReceipt("s","R-1","Frozen customer",listOf(SaleReceiptLine(1,"p","Frozen juice","PC","3",8500,25500)),"PHP",25500,30000,4500,1791338400000)
        val doc = SaleReceiptDocuments.build(r,ReceiptHeader("Seller","Trip","Truck"),a(),0,void = SaleVoidInfo("wrong_items",1791342000000,true))
        assertFalse(doc.isReprint)
        val texts = doc.elements.filterIsInstance<ReceiptElement.Text>()
        val banner = texts.single { it.text == "VOID - SALE CANCELLED" }
        assertTrue(banner.style.bold); assertTrue(banner.style.doubleWidth); assertEquals(ReceiptAlignment.CENTER,banner.style.alignment)
        assertTrue(texts.any { it.text == "** VOID - NOT A VALID RECEIPT **" && it.style.bold && it.style.alignment == ReceiptAlignment.CENTER })
        val text = texts.joinToString("\n") { it.text }
        listOf("Frozen juice","Frozen customer","Voided: 2026-10-07 11:00","Reason: Wrong items","Supervisor approved").forEach { assertTrue(it,text.contains(it)) }
        val lines = ReceiptLayoutFormatter().format(doc).filterIsInstance<ReceiptCommand.Line>()
        assertFalse(lines.any { it.text.contains("REPRINT") })
        assertTrue(lines.any { it.text.startsWith("TOTAL") && it.text.endsWith("P255.00") })
        val none = SaleReceiptDocuments.build(r,ReceiptHeader(null,null,null),a(),0,void = SaleVoidInfo("other",1791342000000,false))
        assertFalse(none.elements.filterIsInstance<ReceiptElement.Text>().any { it.text == "Supervisor approved" })
    }
}
