package com.sunpride.field.ui.diagnosticvisit

import com.sunpride.field.storage.CallSheet
import com.sunpride.field.storage.CallSheetCodec
import com.sunpride.field.storage.CallSheetProduct
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ActivityFormsTest {
    private fun fields(o: JSONObject) = o.keys().asSequence().associateWith { o.get(it) }
    private val sheet = CallSheet("outlet-1", 1, CallSheetCodec.header(JSONObject().put("accountName", "A")
        .put("address", JSONObject.NULL).put("buyerName", JSONObject.NULL).put("contactNumber", JSONObject.NULL)
        .put("accountInCharge", JSONObject.NULL).put("receivingInCharge", JSONObject.NULL)
        .put("distributorName", JSONObject.NULL).put("distributorSchedule", JSONObject.NULL)
        .put("foc", JSONObject.NULL).put("pricing", JSONObject.NULL)),
        listOf(CallSheetProduct("product-1", "P1", "Product 1", "CAN", null, null)))

    @Test fun buildsExactWireShapes() {
        assertEquals(mapOf("kind" to "merchandising", "displayCondition" to "needs_action", "actionTaken" to "Re-faced"),
            fields(ActivityForms.merchandising("needs_action", "  Re-faced ")))
        assertFalse(ActivityForms.merchandising("compliant", " ").has("actionTaken"))
        assertEquals(mapOf("kind" to "promotion", "programRef" to "Holiday bundle", "finding" to "executed"),
            fields(ActivityForms.promotion(" Holiday bundle ", "executed")))
        val stock = ActivityForms.inventoryCheck(sheet, "product-1", "present", "24")
        assertEquals(24L, stock.getLong("observedQuantity"))
        assertFalse(ActivityForms.inventoryCheck(sheet, "product-1", "absent", "").has("observedQuantity"))
        val price = ActivityForms.priceCheck(sheet, "product-1", "189.5", false)
        assertEquals(18950L, price.getLong("observedPriceMinor"))
        assertEquals("PHP", price.getString("currency"))
        assertFalse(price.getBoolean("compliant"))
        assertEquals(18900L, ActivityForms.priceCheck(sheet, "product-1", "189", null).getLong("observedPriceMinor"))
        for (form in listOf(stock, price, ActivityForms.merchandising("compliant", ""), ActivityForms.promotion("P", "not_applicable")))
            ActivityForms.validate(form, sheet)
    }

    @Test fun refusesIncompleteForeignOrMalformedForms() {
        val cases: List<() -> Any> = listOf(
            { ActivityForms.merchandising(null, "") },
            { ActivityForms.merchandising("great", "") },
            { ActivityForms.merchandising("compliant", "x".repeat(501)) },
            { ActivityForms.promotion("", "executed") },
            { ActivityForms.promotion("P", null) },
            { ActivityForms.inventoryCheck(sheet, "product-9", "present", "") },
            { ActivityForms.inventoryCheck(null, "product-1", "present", "") },
            { ActivityForms.inventoryCheck(sheet, "product-1", "present", "1.5") },
            { ActivityForms.inventoryCheck(sheet, "product-1", "present", "-1") },
            { ActivityForms.priceCheck(sheet, "product-1", "189.555", null) },
            { ActivityForms.priceCheck(sheet, "product-1", "abc", null) },
            { ActivityForms.priceCheck(sheet, null, "10", null) })
        cases.forEach { assertThrows(ActivityFormError::class.java) { it() } }
        val price = ActivityForms.priceCheck(sheet, "product-1", "10", null)
        for (bad in listOf(JSONObject(price.toString()).put("currency", "USD"),
            JSONObject(price.toString()).put("observedPriceMinor", 1.5),
            JSONObject(price.toString()).put("extra", true),
            JSONObject().put("kind", "order_intent").put("clientOrderId", "x"))) {
            assertThrows(Exception::class.java) { ActivityForms.validate(bad, sheet) }
        }
    }
}
