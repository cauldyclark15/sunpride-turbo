package com.sunpride.van.storepos

import com.sunpride.van.fiscal.FiscalNumbers
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

/** b33: a till refund takes its credit-memo number from the store's own bundle (where the sale takes its invoice number). */
class StoreRefundsFiscalTest {
    private val device = UUID.randomUUID().toString()
    private fun range(type: String, prefix: String) = JSONObject().put("documentType", type).put("allocationId", UUID.randomUUID().toString()).put("seriesId", UUID.randomUUID().toString())
        .put("deviceId", device).put("firstSerial", "1").put("lastSerial", "50").put("nextSerial", "1").put("prefix", prefix).put("effectiveTo", JSONObject.NULL)
        .put("registration", JSONObject().put("taxBasisPoints", 1200).put("sample", true).put("status", "sample_not_filed").put("entityName", "SAMPLE Foods").put("tin", "000").put("address", "1 Sample St"))
    private fun config(vararg ranges: JSONObject) = StorePosConfig("store", UUID.randomUUID().toString(), "r", "Reg", "Store", "T", "p", null,
        JSONObject().put("fiscal", JSONObject().put("ranges", JSONArray(ranges.toList()))))

    @Test fun theCreditMemoRangeIsFoundInTheStoreBundleNotTheVanPolicy() {
        val c = config(range("sales_invoice", "SI"), range("credit_memo", "CM"))
        val ranges = FiscalNumbers.ranges(StoreRefunds.fiscalPolicy(c))
        assertEquals(listOf("sales_invoice", "credit_memo"), ranges.map { it.getString("documentType") })
        assertEquals("SAMPLE Foods", StoreRefunds.creditMemoRegistration(StoreRefunds.fiscalPolicy(c))?.getString("entityName"))
    }
    @Test fun aRegisterWithoutAFiscalBlockGivesAnEmptyPolicyThatSaysSync() {
        val c = StorePosConfig("store", UUID.randomUUID().toString(), "r", "Reg", "Store", "T", "p", null)
        val policy = StoreRefunds.fiscalPolicy(c)
        assertTrue(FiscalNumbers.ranges(policy).isEmpty())
        assertNull(StoreRefunds.creditMemoRegistration(policy))
        assertTrue(StoreRefunds.creditNumberProblem("Download an authorized document range before selling").contains("no credit memo numbers yet"))
    }
    @Test fun aBundleFromBeforeTheSeriesWasSeededHasNoCreditMemoRange() {
        val policy = StoreRefunds.fiscalPolicy(config(range("sales_invoice", "SI")))
        assertNull(StoreRefunds.creditMemoRegistration(policy))
        assertEquals(1, FiscalNumbers.ranges(policy).size)
    }
    @Test fun everyNumberFailureHasItsOwnPlainSentence() {
        val words = listOf("Download an authorized document range before selling", "Document range exhausted; sync before issuing again", "Fiscal authorization expired",
            "Document range belongs to another handheld", "something else", null).map { StoreRefunds.creditNumberProblem(it) }
        assertEquals(5, words.distinct().size)
        words.forEach { assertTrue(it, it.startsWith("No credit memo number") || it.startsWith("This register") || it.startsWith("The credit memo")) ; assertFalse(it.contains("range")) }
        assertTrue(words[1].contains("left"))
        assertFalse(words[0].contains("left"))
    }
}
