package com.sunpride.van.storepos

import com.sunpride.van.storage.OutboxRow
import com.sunpride.van.sync.V2VanCodec
import org.json.JSONObject
import org.junit.Test
import org.junit.Assert.*
import java.util.UUID

class StorePosRulesTest {
    private val mode=UUID.randomUUID().toString()
    private val register=UUID.randomUUID().toString()
    private fun config()=StorePosConfig("store",mode,register,"Register 1","Sample Cebu store","CEBU-01",UUID.randomUUID().toString(),null)
    private fun row(kind:String,shift:String,time:Long,status:String="pending"):OutboxRow {
        val id=UUID.randomUUID().toString()
        val p=JSONObject().put("shiftId",shift).put("modeVersionId",mode).put("deviceTime",time)
        return OutboxRow("v2|cashier|scope","device",id,register,kind,JSONObject().put("kind",kind).put("clientRequestId",id).put("payload",p).toString(),time,status=status)
    }
    @Test fun F_R01_offlineOpenAndCloseReplayNeverReopenClosedSession() {
        val id=UUID.randomUUID().toString()
        val a=row("store.shift.open",id,1)
        assertEquals(id,StorePosStore.project(config(),listOf(a)).shift!!.shiftId)
        val b=row("store.shift.close",id,2)
        assertNull(StorePosStore.project(config(),listOf(b,a)).shift)
        assertNull(StorePosStore.project(config(),listOf(b.copy(status="done"),a.copy(status="done"))).shift)
    }
    @Test fun F_R01_rejectedBlindCloseRetainsOpenSessionForSupervisedRecovery() {
        val id=UUID.randomUUID().toString()
        val state=StorePosStore.project(config(),listOf(row("store.shift.open",id,1,"done"),row("store.shift.close",id,2,"rejected")))
        assertEquals(id,state.shift!!.shiftId);assertEquals(1,state.review)
    }
    @Test fun F_R01_reassignedTerminalDoesNotAdoptOldSessionAndOldReviewRemainsVisible() {
        val a=row("store.shift.open",UUID.randomUUID().toString(),1,"conflict")
        val state=StorePosStore.project(config().copy(modeVersionId=UUID.randomUUID().toString()),listOf(a))
        assertNull(state.shift);assertEquals(1,state.review)
    }
    @Test fun F_R01_operationsUseExistingV2SyncEnvelopeAndNeverSendExpectedCash() {
        val a=row("store.shift.close",UUID.randomUUID().toString(),1)
        val o=V2VanCodec.operation(a)
        assertEquals("store.shift.close",o.getString("opType"))
        assertFalse(o.getJSONObject("payload").has("expectedCentavos"))
        assertEquals(a.clientRequestId,o.getString("clientOpId"))
    }
    @Test fun F_R01_unknownOrTransactionEnabledConfigurationsFailClosed() {
        val o=JSONObject().put("version",1).put("mode","store").put("modeVersionId",mode)
            .put("registerId",register).put("registerName","Register").put("storeName","Store").put("terminalCode","ONE")
            .put("policyId",UUID.randomUUID().toString()).put("shift",JSONObject.NULL).put("allowLocalSwitch",false).put("transactionsEnabled",false)
        assertEquals("store",StorePosConfig.decode(o).mode)
        o.put("transactionsEnabled",true)
        assertThrows(IllegalArgumentException::class.java){StorePosConfig.decode(o)}
        o.put("transactionsEnabled",false).put("mode","unknown")
        assertThrows(IllegalArgumentException::class.java){StorePosConfig.decode(o)}
    }
}
