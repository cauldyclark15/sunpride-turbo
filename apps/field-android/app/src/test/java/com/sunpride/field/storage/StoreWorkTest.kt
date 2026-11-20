package com.sunpride.field.storage

import com.sunpride.field.support.FakeFieldStore
import com.sunpride.field.ui.diagnosticvisit.ActivityForms
import com.sunpride.field.ui.diagnosticvisit.VisitIntentFactory
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class StoreWorkTest {
    private val id = "00000000-0000-4000-8000-000000000001"
    private val other = "00000000-0000-4000-8000-000000000002"
    private val scope = StoreScope("account","device","scope")
    private fun work() = JSONObject().put("routineName","Weekly follow-up").put("activities",JSONArray()
        .put(JSONObject().put("activityId",id).put("name","Collection")))
    private fun tick(start: IntentRow, activityId: String = id, done: Boolean = true) = VisitIntentFactory.create(scope,
        "visit.activity",start.clientVisitId,start.requestId,start.requestId,null,"outlet",emptyList(),null,null,null,null,null,
        at=100,activity=StoreWork.activity(activityId,done))
    @Test fun signedNamesAndStrictAdditiveDecode() {
        assertEquals("Collection",StoreWork.decode(work()).activities.single().name)
        assertEquals("Weekly follow-up",StoreWork.decode(work()).routineName)
        assertTrue(StoreWork.decode(null).activities.isEmpty())
        assertThrows(IllegalArgumentException::class.java) { StoreWork.decode(work().also { it.getJSONArray("activities").getJSONObject(0).put("done","yes") }) }
        assertThrows(IllegalArgumentException::class.java) { StoreWork.decode(work().also { it.getJSONArray("activities").put(it.getJSONArray("activities").getJSONObject(0)) }) }
        assertThrows(IllegalArgumentException::class.java) { ActivityForms.validate(StoreWork.activity(id,true).put("name","Forged"),null) }
        assertThrows(IllegalArgumentException::class.java) { ActivityForms.validate(StoreWork.activity(id,true).put("done","yes"),null) }
    }
    private suspend fun store(): Pair<FakeFieldStore,IntentRow> {
        val store=FakeFieldStore(scope)
        val today=SnapshotItem("planned",JSONObject().put("id","planned").put("outletId","outlet").put("serviceDate","1970-01-01")
            .put("agenda",JSONObject().put("storeWork",work())).toString(),"1970-01-01")
        val tomorrow=today.copy(id="tomorrow",serviceDate="1970-01-02")
        store.swap(store.stage(ScopedSnapshot("{}",null,listOf(today,tomorrow),emptyList(),emptyList(),emptyList())),"cursor",Long.MAX_VALUE,Long.MAX_VALUE)
        val start=VisitIntentFactory.create(scope,"visit.checkIn",null,null,null,"planned","outlet",emptyList(),null,null,null,null,null,at=100)
        store.enqueue(start,100)
        return store to start
    }
    @Test fun ticksAndUnticksUseExistingDependencyQueueAndOnlyThisStopsTasks() = runBlocking {
        val (store,start)=store()
        val row=tick(start);val original=row.serializedOperation
        store.enqueue(row,100)
        assertEquals("@checkin:${start.requestId}",JSONObject(row.serializedOperation).getJSONObject("payload").getString("visitId"))
        assertEquals(start.requestId,JSONObject(row.serializedOperation).getJSONArray("dependsOn").getString(0))
        assertEquals(true,StoreWork.state(StoreActivity(id,"Collection"),store.history().map { it.first to it.second.state }).first)
        assertThrows(IllegalArgumentException::class.java) { runBlocking { store.enqueue(tick(start,other),100) } }
        assertEquals(2,store.history().size)
        val uncheck=tick(start,done=false);store.enqueue(uncheck,100)
        val (done,label)=StoreWork.state(StoreActivity(id,"Collection"),store.history().map { it.first to it.second.state })
        assertFalse(done);assertTrue(label.contains("waiting to send"))
        assertEquals(original,store.intent(row.requestId)!!.serializedOperation)
    }
    @Test fun refusedTickNeverLooksSyncedAndPreviouslyAcceptedFactsRemainVisible() = runBlocking {
        val (store,start)=store();val row=tick(start);store.enqueue(row,100)
        store.recordRejection(row.requestId,"invalid_plan")
        val state=StoreWork.state(StoreActivity(id,"Collection"),store.history().map { it.first to it.second.state })
        assertFalse(state.first);assertEquals("Needs office review",state.second)
        assertEquals(true to "Marked done",StoreWork.state(StoreActivity(id,"Collection",true),emptyList()))
        val accepted=tick(start);val refused=tick(start,done=false)
        assertTrue(StoreWork.state(StoreActivity(id,"Collection"),listOf(accepted to "done",refused to "review")).first)
    }
    @Test fun tomorrowUsesTheSavedNextDayWithoutAddingItToToday() = runBlocking {
        val (store,_)=store()
        assertEquals(listOf("planned"),store.todaysVisits("1970-01-01").map { it.id })
        assertEquals(listOf("tomorrow"),store.todaysVisits("1970-01-02").map { it.id })
        assertEquals(2,store.plannedVisits().size)
    }
}
