package com.sunpride.field.retail

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.field.*
import com.sunpride.field.auth.SessionVaults
import com.sunpride.field.device.KeystoreDeviceKey
import com.sunpride.field.ui.*
import com.sunpride.field.ui.diagnosticvisit.VisitLocation
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File

/** F-310 F-311 F-315 F-320 physical Redmi + real lane API/Keystore/SQLCipher/UI/outbox.
 * GPS coordinates and the labelled sample picture are injected test inputs, not physical shelf/temperature evidence. */
class RetailLiveDeviceTest {
    @get:Rule val rule=createAndroidComposeRule<ComponentActivity>()
    private fun waitTag(tag:String)=rule.waitUntil(60000){rule.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()}
    private fun click(tag:String){val node=rule.onNodeWithTag(tag);runCatching { node.performScrollTo() };node.performClick()}
    private fun fill(tag:String,text:String){rule.onNodeWithTag(tag).performScrollTo().performTextReplacement(text)}
    private fun shot(name:String){
        rule.waitForIdle();val bitmap=checkNotNull(InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot())
        File(rule.activity.getExternalFilesDir(null),"merch-$name.png").outputStream().use{bitmap.compress(Bitmap.CompressFormat.PNG,100,it)};bitmap.recycle()
    }
    @Test fun F310_F311_F315_F320_liveMerchandisingCallFreezerAndExpiry() {
        val context=rule.activity.applicationContext;val file=File(context.filesDir,"merch-proof.json")
        assumeTrue("Opt-in isolated MERCH API proof file is not present",file.exists())
        val f=JSONObject(file.readText());file.delete();val environment=AppEnvironment(f.getString("origin"))
        check(BuildConfig.DEBUG&&environment.apiOrigin=="http://127.0.0.1:4570")
        val backend=LiveFieldBackend(environment,SessionVaults.app(context),context){KeystoreDeviceKey.loadOrCreate(context)}
        runCatching{backend.signOut()}
        val location=object:VisitLocation{
            override val requiresPermission=false
            override suspend fun fix()=JSONObject().put("latitude",f.getDouble("latitude")).put("longitude",f.getDouble("longitude"))
                .put("accuracyMeters",5).put("fixTime",System.currentTimeMillis()).put("provider","gps").put("mockSignal",false)
        }
        rule.setContent{FieldApp(environment,false,backend=backend,features=FieldFeatures.ALL,visitLocation=location)}
        waitTag("email");rule.onNodeWithTag("email").performTextInput(f.getString("email"));rule.onNodeWithTag("password").performTextInput(f.getString("password"));click("sign-in")
        try {rule.waitUntil(60000){rule.onAllNodesWithText(f.getString("outletName")).fetchSemanticsNodes().isNotEmpty()}}
        catch(t:Throwable){shot("failure-after-signin");android.util.Log.i("MERCH_UI",rule.onRoot(useUnmergedTree=true).printToString().replace(f.getString("email"),"[private]").replace(f.getString("password"),"[private]"));throw t}
        rule.onNodeWithText(f.getString("outletName")).performScrollTo().performClick();waitTag("diagnostic-title")
        click("diagnostic-checkin");waitTag("diagnostic-checkout");shot("configured-call")
        // The existing availability activity, not a second MSL/OSA implementation.
        click("activity-merchandising");waitTag("activity-form-title");click("activity-display-compliant");click("activity-save");waitTag("diagnostic-title")
        val device=checkNotNull(backend.cachedDeviceId);val signer=backend.loadSigner();backend.today(device,signer,true)
        val start=backend.visitStates().last{it.first.kind=="visit.checkIn"}.first
        val picture=Bitmap.createBitmap(640,480,Bitmap.Config.ARGB_8888)
        Canvas(picture).apply{drawColor(Color.WHITE);drawText("SAMPLE retail proof image",20f,80f,Paint().apply{color=Color.BLACK;textSize=30f})}
        val bytes=ByteArrayOutputStream().also{picture.compress(Bitmap.CompressFormat.JPEG,90,it)}.toByteArray();picture.recycle()
        backend.savePhoto(start.clientVisitId,start.requestId,f.getString("outletId"),"shelf_display",bytes,System.currentTimeMillis());backend.uploadEvidence()
        // Reopen so controller reads the genuine persisted photograph row.
        rule.onNodeWithTag("visit-back").performClick()
        rule.onNodeWithText(f.getString("outletName")).performScrollTo().performClick();waitTag("diagnostic-title")
        click("retail-kind-planogram")
        for(i in 0 until 3){fill("retail-facing-$i","3");fill("retail-position-$i","Shelf ${i+1}")}
        fill("retail-total-facings","18");click("retail-save");waitTag("retail-saved");shot("planogram")
        click("activity-price_check");waitTag("activity-form-title");click("activity-product-${f.getJSONArray("productIds").getString(0)}");fill("activity-text","100.00");click("activity-compliant-yes");click("activity-save");waitTag("diagnostic-title")
        click("retail-kind-competitor");click("retail-none");click("retail-save");waitTag("retail-saved")
        click("retail-kind-issue_log");click("retail-none");click("retail-save");waitTag("retail-saved")
        click("retail-kind-freezer");fill("retail-serial",f.getString("serial"));fill("retail-temperature","-12.0");fill("retail-share","80");click("retail-save");waitTag("retail-saved");shot("freezer-audit")
        click("retail-kind-expiry");fill("retail-batch","SAMPLE-SHELF-BATCH-X")
        val expiry=java.time.LocalDate.parse(f.getString("day")).plusDays(10).toString()
        fill("retail-expiry",expiry);fill("retail-quantity","12");click("retail-save");waitTag("retail-saved");shot("expiry-audit")
        fill("short-call-reason","Sample proof, not a measured operating call")
        click("diagnostic-outcome");click("zero-sale-no_demand");click("diagnostic-checkout");waitTag("diagnostic-confirm-end");click("diagnostic-confirm-end");waitTag("visit-result");rule.onNodeWithTag("visit-result").performScrollTo();shot("call-complete")
        backend.today(device,signer,true)
        val rows=backend.visitStates().filter{it.first.clientVisitId==start.clientVisitId}
        check(rows.count{it.first.kind=="retail.capture"}==5)
        check(rows.all{it.second=="done"}){"Every captured operation must be durably acknowledged"}
        val before=rows.map{it.first.requestId to it.first.serializedOperation};backend.today(device,signer,true)
        check(before==backend.visitStates().filter{it.first.clientVisitId==start.clientVisitId}.map{it.first.requestId to it.first.serializedOperation})
        backend.signOut() // Preserve held evidence and leave the ordinary launcher tests signed out.
    }
}
