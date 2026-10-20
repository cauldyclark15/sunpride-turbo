package com.sunpride.field.orders

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class PresellDatesTest {
    private fun flow()=JSONObject().put("definition",JSONObject().put("channelProfile","pre_sell"))
        .put("deliveryPolicy",JSONObject().put("lead_days",1).put("horizon_days",30).put("cutoff_minute",840))
    @Test fun `F-301 exact Manila cutoff adds one lead day`() {
        PresellDates.validate(flow(),"2026-10-21",Instant.parse("2026-10-20T05:59:59Z").toEpochMilli())
        assertThrows(IllegalArgumentException::class.java) { PresellDates.validate(flow(),"2026-10-21",Instant.parse("2026-10-20T06:00:00Z").toEpochMilli()) }
        PresellDates.validate(flow(),"2026-10-22",Instant.parse("2026-10-20T06:00:00Z").toEpochMilli())
    }
    @Test fun `F-301 pre-sell requires a requested day and a cached delivery policy`() {
        assertThrows(IllegalArgumentException::class.java) { PresellDates.validate(flow(),null,0) }
        assertThrows(IllegalArgumentException::class.java) { PresellDates.validate(JSONObject().put("definition",JSONObject().put("channelProfile","pre_sell")),"2026-10-22",0) }
        PresellDates.validate(null,null,0)
    }
    @Test fun `F-301 send checks current capture cutoff instead of saved draft time`() = kotlinx.coroutines.runBlocking {
        val before=Instant.parse("2026-10-20T05:59:59Z").toEpochMilli()
        val after=Instant.parse("2026-10-20T06:00:00Z").toEpochMilli()
        val text=javaClass.classLoader!!.getResourceAsStream("bootstrap-call-sheet-response.json")!!.bufferedReader().use { it.readText() }
        val snapshot=com.sunpride.field.sync.BootstrapCodec.snapshot(listOf(com.sunpride.field.sync.BootstrapCodec.page(text))).copy(
            outlets=listOf(com.sunpride.field.storage.SnapshotItem("store",JSONObject().put("id","store").put("callFlow",flow()).toString())))
        val store=com.sunpride.field.support.FakeFieldStore(com.sunpride.field.storage.StoreScope("person","device","scope"))
        store.swap(store.stage(snapshot),"cursor",Long.MAX_VALUE,Long.MAX_VALUE)
        val draft=OrderDraft("00000000-0000-0000-0000-000000000001","call","start",null,"store","2026-10-20",null,null,null,null,null,1,listOf(OrderDraftLine("p","FOOD","Food","PC",2)),before,before,requestedDeliveryDate="2026-10-21")
        assertNull(OrderSubmission.checks(store,draft,before).first { it.label=="Requested delivery day meets cutoff" }.problem)
        assertNotNull(OrderSubmission.checks(store,draft,after).first { it.label=="Requested delivery day meets cutoff" }.problem)
    }
    @Test fun `F-301 requested day reaches immutable activity and equality detects changes`() {
        val d=OrderDraft("00000000-0000-0000-0000-000000000001","call","start",null,"store","2026-10-20",null,null,null,null,null,1,listOf(OrderDraftLine("p","FOOD","Food","PC",2)),1,2,requestedDeliveryDate="2026-10-22")
        val restored=OrderDraftCodec.decode(OrderDraftCodec.encode(d))
        assertEquals(d,restored)
        val activity=OrderSubmission.activity(restored);OrderSubmission.validateActivity(activity)
        assertEquals("2026-10-22",activity.getString("requestedDeliveryDate"))
        assertFalse(OrderSubmission.sameActivity(activity,OrderSubmission.activity(d.copy(requestedDeliveryDate="2026-10-23"))))
    }
}
