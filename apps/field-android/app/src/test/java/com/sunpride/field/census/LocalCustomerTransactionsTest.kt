package com.sunpride.field.census

import com.sunpride.field.storage.*
import com.sunpride.field.support.FakeFieldStore
import com.sunpride.field.orders.*
import com.sunpride.field.ui.diagnosticvisit.VisitIntentFactory
import com.sunpride.field.ui.saveOrderDraftIn
import com.sunpride.field.sync.*
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.KeyProtection
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class LocalCustomerTransactionsTest {
    private val identity = StoreScope("person", "device", "scope")
    @Test fun offlineCustomerStartsVisitOrderAndCollectionThenResolvesAcknowledgementsWithoutDuplicateOrChangedTemplates() = runBlocking {
        val store = FakeFieldStore(identity)
        store.swap(store.stage(ScopedSnapshot("{}", null, emptyList(), emptyList(), emptyList(), emptyList())), "cursor", Long.MAX_VALUE, Long.MAX_VALUE)
        val captureId = UUID.randomUUID().toString()
        val p = CustomerCapture.payload(captureId, CustomerCapture.Form(registeredName="Sample Store",firstName="Ana"),null,1000,null,"").put("allowIncomplete",true)
        val customer = CensusRules.intent(identity,p,1000)
        store.enqueue(customer,1000)
        val product = CatalogProduct(UUID.randomUUID().toString(),"TEST","Sample Product","PC")
        store.putLocalCache(LocalCustomers.CATALOG,captureId,LocalCustomers.catalog(null,listOf(product)),1000,"")
        val localId = store.outlets().single().id
        assertEquals(LocalCustomers.reference(captureId),localId)
        val start = VisitIntentFactory.create(identity,"visit.checkIn",null,null,null,null,localId,listOf("sell","collect"),"New store",null,null,null,null,1001)
        store.enqueue(start,1001)
        val draft = saveOrderDraftIn(store,null,start.clientVisitId,start.requestId,listOf(product.id to 2),1002)
        assertNull(draft.lines.single().unitPriceMinor)
        val submitted = submitOrderDraftIn(store,identity,draft.draftId,start.requestId,1003)
        val order = store.intent(submitted.submittedRequestId!!)!!
        val collection = VisitCollection.intent(identity,start,order.requestId,12500,"cash","",1004)
        store.enqueue(collection,1004)
        assertEquals(4,store.pending().size)
        assertNull(LocalCustomers.materialize(store,JSONObject(start.serializedOperation)))
        val templates = store.history().associate { it.first.requestId to it.first.serializedOperation }
        val applied = linkedMapOf<String,Pair<String,String>>()
        var lostCustomerAnswer = false
        val sentCustomers = mutableListOf<String>()
        val serverOutlet = UUID.randomUUID().toString()
        val serverVisit = UUID.randomUUID().toString()
        val transport = object:VisitTransport {
            override fun challenge(deviceId:String)=UUID.randomUUID().toString() to 61000L
            override fun token(refresh:Boolean)="fixture"
            override fun post(path:String,bytes:ByteArray,headers:Map<String,String>,bearer:String):Pair<Int,String> {
                val body=JSONObject(bytes.toString(Charsets.UTF_8))
                if(path.endsWith("pull"))return 200 to JSONObject().put("type","pull.response").put("contractVersion",1).put("serverTime",1000).put("changes",JSONArray()).put("nextCursor","next").put("hasMore",false).toString()
                val results=JSONArray()
                val ops=body.getJSONArray("operations")
                for(i in 0 until ops.length()) {
                    val op=ops.getJSONObject(i);val id=op.getString("clientRequestId");val kind=op.getString("kind");val payload=op.getJSONObject("payload")
                    val semantic=op.toString()
                    applied[id]?.let { assertEquals(it.first,semantic) }
                    if(kind=="visit.checkIn") { assertEquals(serverOutlet,payload.getString("outletId"));assertTrue(applied.containsKey(captureId)) }
                    if(kind=="visit.activity"||kind==VisitCollection.KIND) { assertEquals(serverVisit,payload.getString("visitId"));assertTrue(applied.containsKey(start.requestId)) }
                    val entity=if(kind==CensusRules.KIND)serverOutlet else if(kind=="visit.checkIn")serverVisit else UUID.randomUUID().toString()
                    applied.putIfAbsent(id,semantic to entity)
                    if(kind==CensusRules.KIND) {
                        sentCustomers+=semantic
                        if(!lostCustomerAnswer) { lostCustomerAnswer=true;throw java.io.IOException("simulated lost answer after acceptance") }
                    }
                    results.put(JSONObject().put("clientRequestId",id).put("kind",kind).put("status","accepted")
                        .put("ack",JSONObject().put("entityId",applied[id]!!.second).put("eventIds",JSONArray()).put("serverTime",1000)))
                }
                return 200 to JSONObject().put("type","push.response").put("contractVersion",1).put("serverTime",1000).put("results",results).toString()
            }
        }
        val signer=object:DeviceSigner { override val publicKeySpki=byteArrayOf(1);override val protection=KeyProtection.SOFTWARE;override fun signDer(message:ByteArray)=byteArrayOf(1);override fun sign(message:String)="signature" }
        val engine=VisitSync(SignedVisitGateway(transport,signer,identity.deviceId,{0}),store,identity,{},now={1005},pause={},jitter={0})
        engine.sync();assertEquals(4,store.pending().size)
        engine.sync();assertTrue(store.pending().isEmpty())
        assertEquals(4,applied.size);assertEquals(2,sentCustomers.size);assertEquals(sentCustomers[0],sentCustomers[1])
        assertEquals(templates,store.history().associate { it.first.requestId to it.first.serializedOperation })
        assertEquals(localId,store.outlets().single().id)
        assertEquals(serverOutlet,JSONObject(store.outlets().single().json).getString("serverOutletId"))
        assertThrows(IllegalArgumentException::class.java) { VisitCollection.intent(identity,start,order.requestId,0,"cash","",1006) }
        Unit
    }
}
