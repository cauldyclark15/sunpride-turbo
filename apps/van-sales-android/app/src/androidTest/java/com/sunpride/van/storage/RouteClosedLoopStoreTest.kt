package com.sunpride.van.storage

import android.graphics.Bitmap
import androidx.test.platform.app.InstrumentationRegistry

import com.sunpride.van.ledger.BatchLedger
import com.sunpride.van.pos.*
import com.sunpride.van.sync.FakeVanBackend
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import java.util.UUID

/** F-104/F-105/F-113/F-114/F-115/F-116/F-117/F-122/F-123 real encrypted Room; explicitly fixture-backed, not live-server proof. */
class RouteClosedLoopStoreTest {
    private val context=InstrumentationRegistry.getInstrumentation().targetContext
    private val scope=StoreScope("v2|route-proof|fingerprint","device")
    private val product="k57prod0000000000000000000000001"
    private val outlet="k57out00000000000000000000000001"
    private val at=System.currentTimeMillis()
    private val key="route-sqlcipher-test-only".toByteArray()
    private lateinit var db: VanDatabase
    private lateinit var store: RoomVanStore
    private lateinit var name: String
    @Before fun setup() {name="route-${UUID.randomUUID()}.db";db=EncryptedVanDatabase.openWithPassphrase(context,key,name);store=RoomVanStore(db,scope,clock={at+10})}
    @After fun close() {db.close();context.deleteDatabase(name)}
    private fun snapshot(): String {
        val o=JSONObject(FakeVanBackend.FIXTURE).put("serverTime",at)
        o.getJSONObject("trip").put("status","active").put("routeSessionId","fixture-route")
        o.getJSONObject("load").put("status","posted")
        o.getJSONObject("policy").put("operationsVersion",1).getJSONObject("tripClose").put("requireUploadsSent",false)
        o.getJSONObject("policy").getJSONObject("cashReconciliation").put("approvalRequired",false)
        o.getJSONObject("policy").getJSONObject("stockReconciliation").put("approvalRequired",false)
        o.put("truckStock",JSONArray().put(JSONObject().put("productId",product).put("availableBase","10").put("damagedBase","0")))
        o.put("_v2",JSONObject().put("subject",scope.fullAuthSubject).put("scopeFingerprint","fingerprint").put("epoch","epoch").put("cursor","fixture-cursor").put("leaseExpiresAt",at+86_400_000).put("cacheExpiresAt",at+86_400_000))
        val lots=JSONArray()
        for((id,quantity,days) in listOf(Triple("lot-a",3,7),Triple("lot-b",7,14))) lots.put(JSONObject().put("productId",product).put("lotId",id).put("batch",id.uppercase()).put("quantityBase",quantity.toString()).put("qualityStatus","released").put("status","available").put("expiresAt",at+days*86_400_000L))
        o.put("vanOps",JSONObject().put("version",1).put("tripFacts",JSONObject().put("startOdometerKm",1000))
            .put("lots",lots).put("loadLots",JSONArray()).put("trackedProducts",JSONArray().put(JSONObject().put("productId",product).put("shelfLifeDays",0)))
            .put("observations",JSONArray()).put("vanContainers",JSONArray()).put("containers",JSONArray())
            .put("policies",JSONObject().put("cold_chain",JSONObject().put("intervalMinutes",60).put("bands",JSONArray().put(JSONObject().put("productId",JSONObject.NULL).put("label","SAMPLE frozen").put("minDeciC",-250).put("maxDeciC",-180))))
                .put("returnables",JSONObject().put("items",JSONArray().put(JSONObject().put("code","crate").put("label","Sample crate"))))
                .put("return_reasons",JSONObject().put("items",JSONArray().put(JSONObject().put("code","damaged").put("label","Damaged"))))))
        return o.toString()
    }
    @Test fun F104_legacySaleAndReturnKeepTheirOriginalWireFields()=runBlocking {
        val legacy=JSONObject(snapshot()).apply {remove("vanOps");getJSONObject("policy").remove("operationsVersion")}
        store.replaceBootstrap(legacy.toString())
        val total=4L*6850L
        val sale=store.commitSale(CheckoutRequest(UUID.randomUUID().toString(),outlet,listOf(CartLine(product,4)),PaymentInput("cash",total)),total)
        ReturnStore(store).commit(ReturnRequest(UUID.randomUUID().toString(),outlet,sale.saleId,listOf(ReturnLineInput(product,"PC",1,"damaged",ReturnDisposition.BAD_STOCK))))
        for(kind in listOf("sale.record","return.record")) {
            val payload=JSONObject(store.pending().single {it.kind==kind}.operationJson).getJSONObject("payload")
            assertFalse(payload.has("settlementVersion"))
            assertFalse(payload.getJSONArray("lines").getJSONObject(0).has("allocations"))
        }
        Unit
    }
    @Test fun F123_fullLocalTripSurvivesEncryptedReopenWithoutAnyTransport()=runBlocking {
        store.replaceBootstrap(snapshot())
        val route=RouteOpsStore(store)
        route.stop(outlet,"arrival")
        route.temperature(-200,"delivery",outlet)
        val total=4L*6850L
        val sale=store.commitSale(CheckoutRequest(UUID.randomUUID().toString(),outlet,listOf(CartLine(product,4)),PaymentInput("cash",total)),total)
        val operation=JSONObject(store.pending().single {it.kind=="sale.record"}.operationJson).getJSONObject("payload")
        val allocation=operation.getJSONArray("lines").getJSONObject(0).getJSONArray("allocations")
        assertEquals("lot-a",allocation.getJSONObject(0).getString("lotId"));assertEquals("3",allocation.getJSONObject(0).getString("quantityBase"))
        assertEquals("lot-b",allocation.getJSONObject(1).getString("lotId"));assertEquals("1",allocation.getJSONObject(1).getString("quantityBase"))
        val jpeg=java.io.ByteArrayOutputStream().also {Bitmap.createBitmap(16,16,Bitmap.Config.ARGB_8888).compress(Bitmap.CompressFormat.JPEG,70,it)}.toByteArray()
        val hash=java.security.MessageDigest.getInstance("SHA-256").digest(jpeg).joinToString("") {"%02x".format(it)}
        val photo=JSONObject().put("base64",java.util.Base64.getEncoder().encodeToString(jpeg)).put("sha256",hash)
        val acknowledgement=JSONObject().put("name","Sample customer").put("accepted",true).put("strokes",JSONArray("[[[0,0],[3000,6000],[10000,10000]]]"))
        val beforeRefusal=store.pending().size
        val missingBatch=runCatching {ReturnStore(store).commit(ReturnRequest(UUID.randomUUID().toString(),outlet,sale.saleId,listOf(ReturnLineInput(product,"PC",1,"damaged",ReturnDisposition.BAD_STOCK)),acknowledgementJson=acknowledgement.toString(),photoJson=photo.toString()))}
        assertTrue(missingBatch.exceptionOrNull() is ReturnRefused)
        assertEquals(beforeRefusal,store.pending().size)
        ReturnStore(store).commit(ReturnRequest(UUID.randomUUID().toString(),outlet,sale.saleId,listOf(ReturnLineInput(product,"PC",1,"damaged",ReturnDisposition.BAD_STOCK,"LOT-A")),acknowledgementJson=acknowledgement.toString(),photoJson=photo.toString()))
        route.returnable(null,"crate","count",12);route.returnable(outlet,"crate","issue",2);route.returnable(outlet,"crate","receive",1)
        assertEquals("11",route.containerPosition().single().getString("quantity"))
        route.temperature(-170,"interval")
        assertTrue(route.observations().any {it.getString("kind")=="temperature" && it.getJSONObject("facts").optBoolean("excursion")})
        route.reloadRequest(product,12,"Sample route demand")
        route.stop(outlet,"departure");assertNull(route.openStop())
        val card=DailyScorecardStore(store).snapshot()
        assertEquals(total.toString(),card.getString("salesCentavos"));assertEquals(1,card.getInt("calls"));assertEquals(10000,card.getInt("strikeRateBasisPoints"));assertEquals(1,card.getInt("returnDocuments"))
        CashReconciliationStore(store).commit(CashCountRequest(UUID.randomUUID().toString(),mapOf(100L to total/100L),null,null,null,total))
        val stock=StockReconciliationStore(store)
        val count=stock.summary()!!
        val positions=BatchLedger(store).positions().filter {it.status in setOf("available","damaged")}
        stock.commit(StockCountRequest(UUID.randomUUID().toString(),count.lines.map {StockCountLine(it.productId,it.status,it.expectedBase,it.expectedBase)},batchCounts=positions.map {BatchCountLine(it,it.quantityBase)}))
        route.unload()
        val closing=TripCloseStore(store)
        val summary=closing.summary()!!
        assertEquals(1000.0,summary.startOdometerKm!!,0.0)
        closing.commit(TripCloseRequest(UUID.randomUUID().toString(),summary.checklist.reviewCode,1020.0,null))
        val before=store.pending().map {it.clientRequestId to it.operationJson}
        assertTrue(before.isNotEmpty());assertTrue(store.pending().all {it.status=="pending"})
        db.close();db=EncryptedVanDatabase.openWithPassphrase(context,key,name);store=RoomVanStore(db,scope,clock={at+100})
        assertEquals(before,store.pending().map {it.clientRequestId to it.operationJson})
        assertNotNull(db.rows().tripClose(scope.fullAuthSubject,scope.deviceId,summary.tripId))
        assertEquals(6L,store.stock().single().availableBase);assertEquals(1L,store.stock().single().damagedBase)
        assertTrue(runCatching {RouteOpsStore(store).temperature(-200,"interval")}.isFailure)
        Unit
    }
}
