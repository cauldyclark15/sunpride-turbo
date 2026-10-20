package com.sunpride.van.device

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.van.AppEnvironment
import com.sunpride.van.data.VanRepository
import com.sunpride.van.storage.EncryptedVanDatabase
import com.sunpride.van.storage.OutboxRow
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

/** Opt-in REAL H10P/API proof. Only a throwaway account on the isolated integrity lane is accepted.
 * The host coordinator marks wipe after the ready marker. Never embeds tester/admin credentials.
 * The deliberately unsupported SAMPLE outbox row is review-only and can never post a business effect.
 */
@RunWith(AndroidJUnit4::class)
class IntegrityLiveWipeProofTest {
    private fun shot(name:String,visibleText:String) {
        val i=InstrumentationRegistry.getInstrumentation()
        val context=i.targetContext
        androidx.test.uiautomator.UiDevice.getInstance(i).wakeUp()
        androidx.test.core.app.ActivityScenario.launch<com.sunpride.van.MainActivity>(android.content.Intent(context,com.sunpride.van.MainActivity::class.java)).use {
            val device=androidx.test.uiautomator.UiDevice.getInstance(i)
            check(device.wait(androidx.test.uiautomator.Until.hasObject(androidx.test.uiautomator.By.textContains(visibleText)),20_000)) { "Live proof screen did not settle" }
            i.waitForIdleSync()
            val bitmap=checkNotNull(i.uiAutomation.takeScreenshot())
            try { File(checkNotNull(context.getExternalFilesDir("integrity-proof")),name).outputStream().use { out -> check(bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,out)) } }
            finally {bitmap.recycle()}
        }
    }
    @Test fun F007_realContactSealsSampleQueuedWorkThenErasesOnlyItsPartition(): Unit = runBlocking {
        val instrumentation=InstrumentationRegistry.getInstrumentation()
        val raw=runCatching { instrumentation.context.assets.open("integrity-live-proof.json").bufferedReader().use { it.readText() } }.getOrNull()
        assumeTrue("Opt in with a private SUNPRIDE_INTEGRITY_PROOF_DIR and isolated sample account",raw!=null)
        val config=JSONObject(checkNotNull(raw)); val email=config.getString("email")
        require(email.startsWith("integrity-wipe-") && email.endsWith("@sample.sunpride.test"))
        require(config.getString("apiOrigin")=="http://127.0.0.1:4500")
        require(com.sunpride.van.BuildConfig.API_ORIGIN==config.getString("apiOrigin")) { "Installed app must use the isolated lane API" }
        val context=instrumentation.targetContext
        require(context.packageName=="com.sunpride.van.integrity") { "Wipe proof refuses the tester app sandbox" }
        KeystoreDeviceKey.delete(KeystoreDeviceKey.DEFAULT_ALIAS) // This isolated SAMPLE-only package, never a tester's key.
        val markers=File(context.filesDir,"integrity-live-proof").apply { mkdirs() }
        File(markers,"ready.json").delete(); File(markers,"complete.json").delete()
        val repository=VanRepository.create(context,environment=AppEnvironment(config.getString("apiOrigin")))
        var signedIn=false
        try {
            // A vendor test-key finding must be explicitly excepted by the office, never ignored here.
            repeat(30) { if(!signedIn) {
                try { repository.signIn(email,config.getString("password")); signedIn=true }
                catch (e: Exception) { File(markers,"assessment-review").writeText("sample_account_only"); delay(1_000) }
            } }
            assertTrue("Sample sign-in/enrollment must succeed (or receive an audited office exception)",signedIn)
            shot("F007-before-wipe.png","Today")
            val scope=repository.storeScope.first { it!=null }!!
            require(scope.fullAuthSubject.startsWith("v2|"))
            val db=EncryptedVanDatabase.open(context)
            try {
                val otherSubject="SAMPLE integrity sentinel "+UUID.randomUUID()
                val otherDevice="SAMPLE other account device"
                val requestId=UUID.randomUUID().toString()
                val operation=JSONObject().put("kind","integrity.sample_held_evidence").put("clientRequestId",requestId)
                    .put("note","SAMPLE unsent evidence; supervised recovery only, never a business command").toString()
                db.rows().insertOutbox(OutboxRow(scope.fullAuthSubject,scope.deviceId,requestId,UUID.randomUUID().toString(),"integrity.sample_held_evidence",operation,System.currentTimeMillis(),status="review"))
                val sentinel=OutboxRow(otherSubject,otherDevice,UUID.randomUUID().toString(),UUID.randomUUID().toString(),"integrity.sample_sentinel","{}",System.currentTimeMillis(),status="review")
                db.rows().insertOutbox(sentinel)
                File(markers,"ready.json").writeText(JSONObject().put("deviceId",scope.deviceId).put("subject",scope.fullAuthSubject)
                    .put("requestId",requestId).put("operation",operation).put("queuedCount",1).toString())
                withTimeout(120_000) {
                    while(repository.sessionState.value.signedIn) {
                        try { repository.syncNow() } catch (_: Exception) { }
                        delay(500)
                    }
                }
                assertFalse(repository.sessionState.value.signedIn)
                assertTrue("The throwaway partition must be erased",db.rows().outboxRows(scope.fullAuthSubject,scope.deviceId).isEmpty())
                assertEquals("Another account must survive byte-for-byte",listOf(sentinel),db.rows().outboxRows(otherSubject,otherDevice))
                db.openHelper.writableDatabase.execSQL("delete from outbox where fullAuthSubject=? and deviceId=?",arrayOf(otherSubject,otherDevice))
                shot("F007-after-wipe.png","Sign in")
                File(markers,"complete.json").writeText(JSONObject().put("signedOut",true).put("selectedRowsAfter",0).put("otherAccountPreserved",true).put("requestId",requestId).toString())
                instrumentation.sendStatus(0,android.os.Bundle().apply { putString("stream","F-007 real H10P contact: selected partition erased, other account retained, signed out\n") })
            } finally { db.close() }
        } finally { repository.close() }
    }
}
