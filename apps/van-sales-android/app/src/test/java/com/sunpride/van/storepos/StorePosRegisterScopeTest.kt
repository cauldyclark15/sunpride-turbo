package com.sunpride.van.storepos

import com.sunpride.van.storage.OutboxRow
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

/** POS-005 / POS-049: one handheld moved from register A to register B keeps A's journal, but B must not inherit it. */
class StorePosRegisterScopeTest {
    private val colon=UUID.randomUUID().toString()
    private val mandaue=UUID.randomUUID().toString()
    private fun config(register:String)=StorePosConfig("store",UUID.randomUUID().toString(),register,"R","Store","T",UUID.randomUUID().toString(),null)
    private val noon=1_794_369_600_000L
    private fun row(kind:String,register:String,payload:JSONObject,metadata:String?=null):OutboxRow {
        val id=UUID.randomUUID().toString()
        payload.put("registerId",register).put("deviceTime",noon-60_000).put("shiftId",UUID.randomUUID().toString())
        return OutboxRow("v2|cashier|scope","device",id,register,kind,JSONObject().put("kind",kind).put("clientRequestId",id).put("payload",payload).toString(),noon-60_000,metadata,status="done")
    }
    @Test fun POS_005_zOnAnotherRegisterDoesNotCloseThisRegistersDay() {
        val z=row("store.read",colon,JSONObject().put("kind","z"))
        assertTrue(StorePosStore.zClosedToday(config(colon),listOf(z),noon))
        assertFalse(StorePosStore.zClosedToday(config(mandaue),listOf(z),noon))
    }
    @Test fun POS_049_receiptsListOnlyThisRegistersSales() {
        val receipt=JSONObject().put("receipt",JSONObject().put("saleId",UUID.randomUUID().toString()).put("soldAt",noon)).toString()
        val sale=row("store.sale",colon,JSONObject(),receipt)
        assertEquals(1,StoreTransactions.receipts(config(colon),listOf(sale)).size)
        assertTrue(StoreTransactions.receipts(config(mandaue),listOf(sale)).isEmpty())
    }
}
