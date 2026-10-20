package com.sunpride.integrity

import android.graphics.Bitmap
import android.graphics.Color
import android.media.ExifInterface
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.sqlite.db.SupportSQLiteOpenHelper
import androidx.test.platform.app.InstrumentationRegistry
import net.zetetic.database.sqlcipher.SupportOpenHelperFactory
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.UUID

/** F-007/F-024/F-312: actual Android pixels/EXIF and SQLCipher, no OEM attestation claims. */
class IntegrityDeviceTest {
    private val context get()=InstrumentationRegistry.getInstrumentation().targetContext
    @Test fun F312_pixelsAndExifAreFrozenBeforeHashing() {
        val b=Bitmap.createBitmap(800,600,Bitmap.Config.ARGB_8888).apply {eraseColor(Color.rgb(100,160,90))}
        val out=ByteArrayOutputStream();b.compress(Bitmap.CompressFormat.JPEG,90,out);b.recycle()
        val at=System.currentTimeMillis()
        val marked=ExecutionWatermark.burn(out.toByteArray(),ExecutionWatermark.Facts(10.33,123.94,5.0,at,"SAMPLE User","sample-user","SAMPLE Outlet","sample-outlet"))
        assertFalse(out.toByteArray().contentEquals(marked))
        val exif=ExifInterface(ByteArrayInputStream(marked));val gps=FloatArray(2)
        assertTrue(exif.getLatLong(gps));assertEquals(10.33,gps[0].toDouble(),0.00001)
        assertNotNull(exif.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL))
        val bytes=String(marked,Charsets.ISO_8859_1)
        assertTrue(bytes.contains("SP-INTEGRITY-1"));assertTrue(bytes.contains("SAMPLE User"))
        assertTrue(bytes.contains("perceptualHash"))
        java.io.File(checkNotNull(context.getExternalFilesDir("integrity-proof")),"F312-SAMPLE-watermarked.jpg").writeBytes(marked)
    }
    private fun database(block:(SupportSQLiteDatabase)->Unit) {
        System.loadLibrary("sqlcipher")
        val name="spec-integrity-${UUID.randomUUID()}.db"
        val helper=SupportOpenHelperFactory(ByteArray(32){37}).create(SupportSQLiteOpenHelper.Configuration.builder(context).name(name)
            .callback(object:SupportSQLiteOpenHelper.Callback(1) {
                override fun onCreate(db:SupportSQLiteDatabase) {db.execSQL("create table outbox(account text,deviceId text,state text,operation text)")}
                override fun onUpgrade(db:SupportSQLiteDatabase,oldVersion:Int,newVersion:Int)=Unit
            }).build())
        try {block(helper.writableDatabase)} finally {helper.close();context.deleteDatabase(name)}
    }
    @Test fun F007_recoveryErasesOnlyTheSelectedAccountAndNeverLosesQueuedWork()=database { db->
        db.execSQL("insert into outbox values ('sample-a','phone','pending','saved sale'),('sample-b','phone','pending','other account')")
        val partition=PartitionRecovery.Partition("account","sample-a","phone")
        val bundle=PartitionRecovery.snapshot(db,partition)
        assertEquals(1,bundle.getInt("queuedCount"))
        assertFalse(bundle.toString().contains("other account"))
        var recovered=false;var acknowledged=false;var locked=false
        RemoteErasure.perform(context,JSONObject().put("serverTime",System.currentTimeMillis()).put("deviceControl",JSONObject().put("id",UUID.randomUUID().toString())),bundle,emptyList(),
            {"sample-signature"},{path,body->
                if(path.endsWith("recover")) {recovered=true;JSONObject().put("held",true).put("digest",PartitionRecovery.bytesDigest(body.getString("bundleJson").toByteArray(Charsets.UTF_8)))}
                else {assertTrue(recovered);db.query("select count(*) from outbox where account='sample-a'").use {it.moveToFirst();assertEquals(0,it.getInt(0))};acknowledged=true;JSONObject().put("acknowledged",true)}},
            {assertTrue(recovered);PartitionRecovery.erase(db,partition)}, {}, {locked=true})
        assertTrue(acknowledged && locked)
        db.query("select operation from outbox where account='sample-b'").use {assertTrue(it.moveToFirst());assertEquals("other account",it.getString(0))}
    }
    @Test fun F007_uncertainRecoveryReplaysIdenticalBytesWhenFileEnumerationChanges()=database {db->
        db.execSQL("insert into outbox values ('sample-a','phone','pending','saved sale')")
        val partition=PartitionRecovery.Partition("account","sample-a","phone")
        val bundle=PartitionRecovery.snapshot(db,partition)
        val me=JSONObject().put("serverTime",System.currentTimeMillis()).put("deviceControl",JSONObject().put("id",UUID.randomUUID().toString()))
        val a=RemoteErasure.RecoveryFile("a",byteArrayOf(1));val b=RemoteErasure.RecoveryFile("b",byteArrayOf(2))
        var sent="";var erased=false;var firstFailed=false
        try {RemoteErasure.perform(context,me,bundle,listOf(b,a),{"sample-signature"},{_,body->
            sent=body.getString("bundleJson");throw java.io.IOException("SAMPLE uncertain transport")
        },{erased=true},{},{})} catch (_:java.io.IOException) {firstFailed=true}
        assertTrue(firstFailed);assertFalse(erased)
        val deleted=mutableListOf<String>()
        RemoteErasure.perform(context,me,bundle,listOf(a,b),{"sample-signature"},{path,body->
            if(path.endsWith("recover")) {
                assertEquals(sent,body.getString("bundleJson"))
                JSONObject().put("held",true).put("digest",PartitionRecovery.bytesDigest(sent.toByteArray(Charsets.UTF_8)))
            } else JSONObject().put("acknowledged",true)
        },{PartitionRecovery.erase(db,partition);erased=true},{deleted.add(it)},{})
        assertTrue(erased);assertEquals(listOf("a","b"),deleted)
    }
    @Test fun F007_failedErasureDoesNotAcknowledgeOrDeleteAnotherAccount()=database {db->
        db.execSQL("insert into outbox values ('sample-a','phone','pending','saved sale'),('sample-b','phone','pending','other account')")
        db.execSQL("create trigger refuse_delete before delete on outbox when old.account='sample-a' begin select raise(abort,'sample failure');end")
        val partition=PartitionRecovery.Partition("account","sample-a","phone")
        var acknowledged=false;var failed=false
        try {RemoteErasure.perform(context,JSONObject().put("serverTime",System.currentTimeMillis()).put("deviceControl",JSONObject().put("id",UUID.randomUUID().toString())),PartitionRecovery.snapshot(db,partition),emptyList(),
            {"sample-signature"},{path,body->if(path.endsWith("recover")) JSONObject().put("held",true).put("digest",PartitionRecovery.bytesDigest(body.getString("bundleJson").toByteArray(Charsets.UTF_8))) else {acknowledged=true;JSONObject().put("acknowledged",true)}},
            {PartitionRecovery.erase(db,partition)}, {}, {})} catch (_:Exception) {failed=true}
        assertTrue(failed);assertFalse(acknowledged)
        db.query("select count(*) from outbox").use {it.moveToFirst();assertEquals(2,it.getInt(0))}
    }
}
