package com.sunpride.van.storage

import android.graphics.Bitmap
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.van.evidence.*
import com.sunpride.van.sync.*
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.first
import org.json.JSONArray
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import java.io.File
import java.io.ByteArrayOutputStream
import java.util.UUID

class DamageEvidenceStoreTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val scope = StoreScope("issuer|damage-store-test",UUID.randomUUID().toString())
    private val name = "van-damage-${UUID.randomUUID()}.db"
    private lateinit var db: VanDatabase
    private lateinit var store: RoomVanStore
    private lateinit var photos: DamagePhotoFiles
    private val product = "k57prod0000000000000000000000001"
    @Before fun setup() {
        db = EncryptedVanDatabase.openWithPassphrase(context,"damage-store-test-key".toByteArray(),name)
        photos = DamagePhotoFiles(File(context.noBackupFilesDir,"van-evidence-tests"),scope)
        store = RoomVanStore(db,scope,evidence=photos)
    }
    @After fun cleanup() { db.close(); context.deleteDatabase(name); photos.directory.deleteRecursively() }
    private fun active(): String = JSONObject(FakeVanBackend.FIXTURE).also {
        it.getJSONObject("trip").put("status","active")
        it.put("truckStock",JSONArray().put(JSONObject().put("productId",product).put("availableBase","48").put("damagedBase","0")))
    }.toString()
    private fun capture(): DamageCapture {
        val bitmap = Bitmap.createBitmap(1600,1200,Bitmap.Config.ARGB_8888)
        val random = java.util.Random(20)
        bitmap.setPixels(IntArray(1600*1200) { random.nextInt() or (0xff shl 24) },0,1600,0,0,1600,1200)
        return DamageCapture(ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.JPEG,95,it); bitmap.recycle() }.toByteArray(),90)
    }
    @Test fun bitmapCompressionHonorsPolicyByteCapAndRotation() {
        val capture = capture()
        for (cap in listOf(90_000,1024)) {
            val jpeg = DamagePhotoEncoder.compress(capture,cap)
            assertTrue(jpeg.size <= cap)
            val bitmap = android.graphics.BitmapFactory.decodeByteArray(jpeg,0,jpeg.size)
            assertTrue(bitmap.height > bitmap.width); assertTrue(maxOf(bitmap.width,bitmap.height) <= 1024); bitmap.recycle()
        }
    }
    @Test fun transactionRefusesMissingPhotoReasonAndInclusiveApprovalBoundary() = runBlocking {
        store.replaceBootstrap(active())
        assertTrue(runCatching { store.recordDamage(product,1,"crushed",null) }.isFailure)
        assertTrue(runCatching { store.recordDamage(product,12,"expired",null) }.isFailure)
        assertTrue(store.pending().isEmpty()); assertEquals(48L,store.stock().single().availableBase)
        val photo = photos.save(DamagePhotoEncoder.compress(capture(),90_000),90_000)
        val id = store.recordDamage(product,12,"expired",null,photo.sha256)
        assertEquals(photo.sha256,damagePhotoSha(store.pending().single())); assertEquals(36L,store.stock().single().availableBase)
        assertEquals(id,store.pending().single().clientRequestId); Unit
    }
    @Test fun scaledThresholdAndLocalMissingOrCorruptedFileRefuseBeforeOutboxWrite() = runBlocking {
        val bootstrap = JSONObject(active())
        bootstrap.getJSONArray("products").getJSONObject(0).put("quantityScale","1000")
        bootstrap.getJSONArray("truckStock").getJSONObject(0).put("availableBase","48000")
        store.replaceBootstrap(bootstrap.toString())
        assertTrue(runCatching { store.recordDamage(product,12000,"expired",null) }.isFailure)
        assertTrue(runCatching { store.recordDamage(product,1,"crushed",null,"a".repeat(64)) }.isFailure)
        val photo = photos.save(DamagePhotoEncoder.compress(capture(),90_000),90_000)
        photo.file.writeBytes(byteArrayOf(1,2))
        assertTrue(runCatching { store.recordDamage(product,1,"crushed",null,photo.sha256) }.isFailure)
        assertTrue(store.pending().isEmpty()); store.recordDamage(product,11999,"expired",null)
        assertEquals(36001L,store.stock().single().availableBase); Unit
    }
    @Test fun photoSurvivesRejectionAndSharedPhotoWaitsForEveryAck() = runBlocking {
        store.replaceBootstrap(active())
        val photo = photos.save(DamagePhotoEncoder.compress(capture(),90_000),90_000)
        store.recordDamage(product,1,"crushed",null,photo.sha256)
        store.recordDamage(product,1,"crushed",null,photo.sha256)
        photos.markUploaded(photo.sha256)
        val pending = store.pending()
        val first = pending.first(); val second = pending.last()
        store.recordResult(first,com.sunpride.van.data.PushResult(first.kind,first.clientRequestId,"accepted",com.sunpride.van.data.PushAck("dmg-one",null,1791346000000)))
        store.cleanupAcknowledgedPhotos(); assertTrue(photo.file.exists())
        store.recordResult(second,com.sunpride.van.data.PushResult(second.kind,second.clientRequestId,"rejected",code="photo_required"))
        store.cleanupAcknowledgedPhotos(); assertTrue(photo.file.exists()); Unit
    }
    @Test fun restartCleanupDeletesOnlyAfterAckAndHistoryIsScopedAndDurable() = runBlocking {
        store.replaceBootstrap(active())
        val photo = photos.save(DamagePhotoEncoder.compress(capture(),90_000),90_000)
        store.recordDamage(product,1,"crushed",null,photo.sha256)
        val row = store.pending().single(); photos.markUploaded(photo.sha256)
        store.recordResult(row,com.sunpride.van.data.PushResult(row.kind,row.clientRequestId,"accepted",com.sunpride.van.data.PushAck("dmg",null,1791346000000)))
        assertTrue(photo.file.exists())
        db.close(); db = EncryptedVanDatabase.openWithPassphrase(context,"damage-store-test-key".toByteArray(),name)
        store = RoomVanStore(db,scope,evidence=photos); store.cleanupAcknowledgedPhotos()
        assertFalse(photo.file.exists()); assertEquals(1,store.damageRecords.first().size)
        // An identical retake is a new unuploaded draft: old done rows must not delete it again.
        val retake = photos.save(DamagePhotoEncoder.compress(capture(),90_000),90_000)
        assertEquals(photo.sha256,retake.sha256); store.cleanupAcknowledgedPhotos(); assertTrue(retake.file.exists())
        assertTrue(RoomVanStore(db,StoreScope("issuer|other",scope.deviceId)).damageRecords.first().isEmpty()); Unit
    }
}
