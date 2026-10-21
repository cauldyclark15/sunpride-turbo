package com.sunpride.van.fiscal

import com.sunpride.van.data.*
import com.sunpride.van.pos.QuotedLine
import com.sunpride.van.printing.*
import com.sunpride.integrity.OfflineApproval
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class FiscalTaxTest {
    @Test fun F109_APIQuotePartitionsMatchHandheldAndFrozenPaper_ORRecognizesNoNewTax() {
        // Captured from finish-tax.test.js: one mixed invoice and a partial collection, all SAMPLE.
        val wire=JSONObject(checkNotNull(javaClass.classLoader?.getResourceAsStream("fiscal-tax-v1.json")).bufferedReader().use{it.readText()})
        val rows=wire.getJSONArray("lines");val listId=wire.getString("priceListId")
        val quoted=(0 until rows.length()).map{i->val l=rows.getJSONObject(i)
            val product=Product(l.getString("productId"),l.getString("code"),l.getString("name"),l.getString("uomCode"),l.getLong("quantityScale"),emptyList())
            QuotedLine(i+1,product,l.getLong("quantityBase"),l.getLong("unitPriceMinor"),l.getLong("totalMinor"),listOf(listId),priceListId=listId)
        }
        val policy=wire.getJSONObject("policy");val tax=FiscalTax.snapshot(quoted,policy,listId,wire.getLong("at"))
        assertEquals(OfflineApproval.canonical(wire.getJSONObject("expected")),OfflineApproval.canonical(tax))
        fun issued(key:String):FiscalNumbers.Issued{val d=wire.getJSONObject(key);return FiscalNumbers.Issued(d.getString("number"),d.getString("allocationId"),d.getLong("serial"),d.getJSONObject("snapshot").getJSONObject("registration"))}
        val total=tax.getLong("totalMinor")
        val frozen=FiscalNumbers.snapshot(issued("invoice"),total,providedTax=tax)
        val receiptLines=quoted.map{SaleReceiptLine(it.lineNumber,it.product.productId,it.product.name,it.product.uomCode,it.quantityBase.toString(),it.unitPriceMinor,it.totalMinor)}
        val invoice=SaleReceipt("sample-invoice",issued("invoice").number,"SAMPLE buyer",receiptLines,"PHP",total,total,0,wire.getLong("at"),fiscalJson=frozen)
        fun paper(receipt:SaleReceipt,kind:PrintKind):String {
            val attempt=PrintAttempt("sample-print",receipt.saleId,kind,if(kind==PrintKind.REPRINT)1 else 0,if(kind==PrintKind.REPRINT)"customer_copy" else null,PrintOutcome.NOT_PRINTED,wire.getLong("at"))
            return ReceiptLayoutFormatter().format(SaleReceiptDocuments.build(receipt,ReceiptHeader(null,null,null),attempt,wire.getLong("at"))).filterIsInstance<ReceiptCommand.Line>().joinToString("\n"){it.text}.replace(Regex("\\s+")," ")
        }
        val original=paper(invoice,PrintKind.ORIGINAL)
        policy.getJSONArray("taxQuotes").getJSONObject(1).remove("treatment")
        assertTrue(runCatching{FiscalTax.snapshot(quoted,policy,listId,wire.getLong("at"))}.isFailure)
        for(text in listOf(original,paper(invoice,PrintKind.REPRINT))){assertTrue(text.contains("VAT EXEMPT"));assertTrue(text.contains("ZERO RATED"));assertTrue(text.contains("VATable sales"));assertTrue(text.contains("SAMPLE ONLY"))}
        assertEquals(frozen,invoice.fiscalJson)
        val source=wire.getJSONObject("collection").getJSONObject("snapshot")
        val amount=source.getLong("totalMinor")
        val orJson=JSONObject(FiscalNumbers.snapshot(issued("collection"),amount,"official_receipt"))
            .put("invoiceNumber",source.getString("invoiceNumber")).put("invoiceTax",tax)
        assertTrue(orJson.isNull("tax"));assertEquals("payment_application_only",orJson.getString("taxRecognition"))
        val collection=SaleReceipt("sample-payment",issued("collection").number,"SAMPLE buyer",emptyList(),"PHP",amount,amount,0,wire.getLong("at"),fiscalJson=orJson.toString())
        val paymentPaper=paper(collection,PrintKind.ORIGINAL)
        assertTrue(paymentPaper.contains("OFFICIAL RECEIPT"));assertFalse(paymentPaper.contains("VATable sales"));assertTrue(paymentPaper.contains("no new invoice tax"))
    }
}
