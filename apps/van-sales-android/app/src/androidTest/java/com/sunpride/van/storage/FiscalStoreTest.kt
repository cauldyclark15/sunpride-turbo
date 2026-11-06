package com.sunpride.van.storage

import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.van.data.*
import com.sunpride.van.pos.*
import com.sunpride.van.sync.FakeVanBackend
import com.sunpride.van.printing.*
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import java.util.UUID

class FiscalStoreTest {
    private val context=InstrumentationRegistry.getInstrumentation().targetContext
    private val scope=StoreScope("v2|fiscal-test|fingerprint","fiscal-device")
    private val at=1791338400000L
    private lateinit var db:VanDatabase
    private lateinit var store:RoomVanStore
    private lateinit var name:String
    private val key="fiscal-test-only-key".toByteArray()
    private val product="k57prod0000000000000000000000001"
    private val outlet="k57out00000000000000000000000001"
    private fun snapshot():String {
        val o=JSONObject(FakeVanBackend.FIXTURE).put("serverTime",at)
        o.getJSONObject("trip").put("status","active")
        o.getJSONObject("load").put("status","posted")
        o.put("truckStock",JSONArray().put(JSONObject().put("productId",product).put("availableBase","20").put("damagedBase","0")))
        o.put("_v2",JSONObject().put("subject",scope.fullAuthSubject).put("scopeFingerprint","fingerprint").put("epoch","epoch")
            .put("cursor","fiscal-cursor").put("leaseExpiresAt",at+86400000).put("cacheExpiresAt",at+86400000))
        FiscalFixture.add(o,scope.deviceId)
        val methods=o.getJSONObject("policy").getJSONArray("paymentMethods")
        listOf("maya","card").forEach { code ->methods.put(JSONObject().put("code",code).put("label",code).put("kind","other").put("referenceRequired",true).put("referenceLabel","Confirmation reference")) }
        return o.toString()
    }
    @Before fun setup() {name="fiscal-${UUID.randomUUID()}.db";db=EncryptedVanDatabase.openWithPassphrase(context,key,name);store=RoomVanStore(db,scope,clock={at+10})}
    @After fun close(){db.close();context.deleteDatabase(name)}
    private fun request(method:String="cash",reference:String?=null)=CheckoutRequest(UUID.randomUUID().toString(),outlet,listOf(CartLine(product,1)),PaymentInput(method,if(method=="cash")6850 else null,reference))
    @Test fun F_019_offlineCounterRollsBackWithSaleAndNeverResetsOnReopenOrBootstrap()=runBlocking {
        store.replaceBootstrap(snapshot())
        db.openHelper.writableDatabase.execSQL("CREATE TRIGGER fiscal_fail_sale BEFORE INSERT ON sale BEGIN SELECT RAISE(ABORT,'injected'); END")
        assertTrue(runCatching{store.commitSale(request(),6850)}.isFailure)
        db.openHelper.writableDatabase.execSQL("DROP TRIGGER fiscal_fail_sale")
        val first=store.commitSale(request(),6850)
        assertEquals("SAMPLE-SI-000000001",first.receiptNumber)
        db.close();db=EncryptedVanDatabase.openWithPassphrase(context,key,name);store=RoomVanStore(db,scope,clock={at+10})
        store.replaceBootstrap(snapshot())
        val second=store.commitSale(request(),6850)
        assertEquals("SAMPLE-SI-000000002",second.receiptNumber)
        assertEquals(2,db.rows().saleRows(scope.fullAuthSubject,scope.deviceId).size);Unit
    }
    @Test fun F_109_frozenTaxPreviewAndReprintUseTheSame58mmLayoutAndJournal()=runBlocking {
        store.replaceBootstrap(snapshot());val r=store.commitSale(request(),6850)
        val tax=JSONObject(r.fiscalJson!!).getJSONObject("tax")
        assertEquals(6850L,tax.getString("vatableSalesMinor").toLong()+tax.getString("vatMinor").toLong())
        val log=RoomReceiptPrintLog(db,scope,clock={at+20})
        val first=log.begin(r.saleId,false,null) as BeginPrint.Go
        log.finish(first.attempt.printId,PrintOutcome.MAYBE_PRINTED)
        log.settle(r.saleId,PrintOutcome.CONFIRMED)
        val again=log.begin(r.saleId,true,"customer_copy") as BeginPrint.Go
        val preview=ReceiptLayoutFormatter().format(SaleReceiptDocuments.build(again.receipt,again.header,again.attempt,at+30))
            .filterIsInstance<ReceiptCommand.Line>().joinToString("\n"){it.text}
        assertTrue(preview.contains("REPRINT"));assertTrue(preview.contains("SAMPLE - NOT FILED"));assertTrue(preview.contains("VATable sales"))
        assertTrue(preview.contains("SAMPLE-SI-000000001"))
        log.finish(again.attempt.printId,PrintOutcome.NOT_PRINTED)
        assertEquals(4,store.pending().count{it.kind=="fiscal.print"})
        assertTrue(store.pending().filter{it.kind=="fiscal.print"}.all{JSONObject(it.operationJson).getJSONArray("dependsOn").length()==1});Unit
    }
    @Test fun F_111_mayaAndCardAreCapturedWithReferencesAndAwaitConfirmation()=runBlocking {
        store.replaceBootstrap(snapshot())
        val maya=store.commitSale(request("maya","MAYA-REF-123"),6850)
        val card=store.commitSale(request("card","AUTH-456"),6850)
        assertEquals("awaiting_confirmation",maya.paymentStatus);assertEquals("awaiting_confirmation",card.paymentStatus)
        assertEquals("AUTH-456",card.reference)
        assertTrue(runCatching{store.commitSale(request("card","4111111111111111"),6850)}.isFailure)
        assertEquals(2,db.rows().saleRows(scope.fullAuthSubject,scope.deviceId).size);Unit
    }
}
