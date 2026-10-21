package com.sunpride.van.fiscal

import com.sunpride.van.data.*
import com.sunpride.van.storage.CollectionRules
import com.sunpride.van.printing.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CollectionReceiptTest {
    @Test fun F111_collectionsRejectOverpaymentCreditAndCardNumbers() {
        assertNull(CollectionRules.reference(PaymentMethod.CASH,2500,5000,null))
        val card=PaymentMethod("card","Card",PaymentKind.OTHER,true,"Terminal reference")
        assertEquals("TX-123",CollectionRules.reference(card,2500,5000,"tx-123"))
        for(action in listOf<()->Unit>(
            {CollectionRules.reference(PaymentMethod.CASH,5001,5000,null)},
            {CollectionRules.reference(PaymentMethod("credit","On account",PaymentKind.CREDIT,false,null),1,5000,null)},
            {CollectionRules.reference(card,2500,5000,"1234567890123456")}
        )) try {action();fail("must refuse")} catch(_: IllegalArgumentException) { }
    }
    @Test fun F109_officialReceiptAndReprintRetainInvoiceAmountAndRegistration() {
        val registration=JSONObject().put("entityName","SAMPLE company").put("branchName","SAMPLE branch").put("address","SAMPLE address")
            .put("tin","SAMPLE").put("permitReference",JSONObject.NULL).put("sample",true).put("taxBasisPoints",1200)
        val issued=FiscalNumbers.Issued("SAMPLE-OR-000000001","allocation",1,registration)
        val fiscal=JSONObject(FiscalNumbers.snapshot(issued,2500,"official_receipt")).put("invoiceNumber","SAMPLE-SI-000000009")
        val receipt=SaleReceipt("payment","SAMPLE-OR-000000001","SAMPLE customer",emptyList(),"PHP",2500,2500,0,1,false,"cash","Cash",PaymentKind.CASH,"paid",null,null,fiscal.toString())
        fun text(kind: PrintKind):String {
            val attempt=PrintAttempt("print","payment",kind,if(kind==PrintKind.REPRINT)1 else 0,if(kind==PrintKind.REPRINT)"customer_copy" else null,PrintOutcome.NOT_PRINTED,1)
            return ReceiptLayoutFormatter().format(SaleReceiptDocuments.build(receipt,ReceiptHeader(null,null,null),attempt,1)).filterIsInstance<ReceiptCommand.Line>().joinToString("\n") {it.text}
        }
        val original=text(PrintKind.ORIGINAL);val copy=text(PrintKind.REPRINT)
        assertTrue(original.contains("OFFICIAL RECEIPT"));assertTrue(copy.contains("REPRINT"))
        for(rendered in listOf(original,copy)) {assertTrue(rendered.contains("SAMPLE-SI-000000009"));assertTrue(rendered.contains("SAMPLE-OR-000000001"));assertTrue(rendered.contains("25.00"));assertTrue(rendered.contains("SAMPLE ONLY"))}
    }
}
