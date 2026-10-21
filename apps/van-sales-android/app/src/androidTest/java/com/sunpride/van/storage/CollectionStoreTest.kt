package com.sunpride.van.storage

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.van.data.*
import com.sunpride.van.printing.*
import com.sunpride.van.sync.FakeVanBackend
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/** F-108/F-109/F-111: one small real SQLCipher transaction and fake-printer case; no paper. */
@RunWith(AndroidJUnit4::class)
class CollectionStoreTest {
 @Test fun F111_offlineCollectionReplayAndPrintDoNotCreateAnotherSaleOrStockMovement() = runBlocking {
  val context=InstrumentationRegistry.getInstrumentation().targetContext
  val name="finish-a-collection-${UUID.randomUUID()}.db"
  val db=EncryptedVanDatabase.openWithPassphrase(context,"test-only-collection-database-key".toByteArray(),name)
  val scope=StoreScope("sample-collection-subject","sample-device")
  val at=1791338400000L
  try {
   val store=RoomVanStore(db,scope,clock={at+10})
   val bootstrap=JSONObject(FakeVanBackend.FIXTURE).put("serverTime",at)
   bootstrap.getJSONObject("trip").put("status","active")
   val registration=JSONObject().put("entityName","SAMPLE company").put("branchName","SAMPLE branch").put("tin","SAMPLE").put("address","SAMPLE address").put("sample",true).put("status","sample_not_filed").put("permitReference",JSONObject.NULL).put("taxBasisPoints",1200)
   val allocation=UUID.randomUUID().toString()
   val range=JSONObject().put("allocationId",allocation).put("seriesId",UUID.randomUUID().toString()).put("documentType","official_receipt").put("prefix","SAMPLE-0571-OR")
      .put("firstSerial","1").put("lastSerial","3").put("nextSerial","1").put("deviceId",scope.deviceId).put("effectiveTo",JSONObject.NULL).put("registration",registration)
   bootstrap.getJSONObject("policy").put("fiscal",JSONObject().put("required",true).put("ranges",JSONArray().put(range)))
   store.replaceBootstrap(bootstrap.toString())
   val trip=db.rows().trip(scope.fullAuthSubject,scope.deviceId)!!
   val saleId=UUID.randomUUID().toString();val originalKey=UUID.randomUUID().toString()
   val invoice=SaleReceipt(saleId,"SAMPLE-SI-1","SAMPLE customer",emptyList(),"PHP",5000,5000,0,at,false,"credit","On account",PaymentKind.CREDIT,"on_account",null,null)
   db.rows().insertSale(SaleRow(scope.fullAuthSubject,scope.deviceId,saleId,trip.tripId,invoice.receiptNumber,originalKey,"sample-outlet","saved",5000,at,"on_account"))
   db.receiptPrints().insertSaleReceipt(SaleReceiptRow(scope.fullAuthSubject,scope.deviceId,saleId,FrozenReceipts.encode(invoice,ReceiptHeader(null,trip.tripNumber,null))))
   val original=JSONObject().put("tripId",trip.tripId).put("saleId",saleId).put("currency","PHP").put("payment",JSONObject().put("method","credit").put("kind","credit").put("amountMinor","5000")).put("deviceTime",at)
   db.rows().insertOutbox(OutboxRow(scope.fullAuthSubject,scope.deviceId,originalKey,trip.tripId,"sale.record",JSONObject().put("kind","sale.record").put("clientRequestId",originalKey).put("payload",original).toString(),at))
   val collection=CollectionStore(store);val paymentId=UUID.randomUUID().toString()
   val saved=collection.record(paymentId,saleId,2500,"cash",null)
   assertEquals(saved.receiptNumber,collection.record(paymentId,saleId,2500,"cash",null).receiptNumber)
   try {collection.record(UUID.randomUUID().toString(),saleId,2501,"cash",null);fail("overpayment")}catch(_: IllegalArgumentException) { }
   assertEquals(1,db.rows().saleRows(scope.fullAuthSubject,scope.deviceId).size)
   assertEquals(1,db.rows().paymentRows(scope.fullAuthSubject,scope.deviceId).size)
   assertTrue(db.rows().stockmovementRows(scope.fullAuthSubject,scope.deviceId).isEmpty())
   val cash=CashReconciliationStore(store).payments(trip.tripId).filter {it.kind==PaymentKind.CASH}.sumOf {it.amountMinor}
   assertEquals(2500L,cash)
   val log=RoomReceiptPrintLog(db,scope,clock={at+20})
   assertTrue(log.savedSales().single {it.receipt.saleId==paymentId}.isCollection)
   val go=log.begin(paymentId,false,null) as BeginPrint.Go
   assertEquals(saved.receiptNumber,go.receipt.receiptNumber)
   log.finish(go.attempt.printId,PrintOutcome.NOT_PRINTED)
   assertEquals(1,db.rows().saleRows(scope.fullAuthSubject,scope.deviceId).size)
   assertEquals("1",JSONObject(saved.fiscalJson!!).getString("serial"))
  } finally {db.close();context.deleteDatabase(name)}
 }
}
