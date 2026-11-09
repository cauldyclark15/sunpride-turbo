package com.sunpride.field

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.room.Room
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.field.auth.EnrollmentState
import com.sunpride.field.device.*
import com.sunpride.field.storage.*
import com.sunpride.field.sync.DomainOutbox
import com.sunpride.field.ui.*
import com.sunpride.field.ui.diagnosticvisit.VisitLocation
import kotlinx.coroutines.*
import net.zetetic.database.sqlcipher.SupportOpenHelperFactory
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec
import java.util.UUID

/** Lane 2 actions: Add joint call is a visible FAB that never covers the list; saved session rows read Edit; plain Save labels. */
class VisitActionsTest {
    @get:Rule val rule=createAndroidComposeRule<ComponentActivity>()
    private val instrumentation get()=InstrumentationRegistry.getInstrumentation()
    private fun capture(name:String){
        val bitmap=instrumentation.uiAutomation.takeScreenshot()?:return
        File(instrumentation.targetContext.getExternalFilesDir(null),"lane2-$name.png").outputStream().use{bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)}
        bitmap.recycle()
    }
    @Test fun jointCallAddFabCollectorAndDsrWording(){
        val fixtures=JSONObject(instrumentation.context.assets.open("finish-a-forms.json").bufferedReader().use{it.readText()})
        // one saved session so the list has an Edit row
        val joint=fixtures.getJSONObject("jointcall")
        joint.put("sessions",JSONArray().put(JSONObject().put("traineeName","SAMPLE trainee").put("revision","1")
            .put("session",JSONObject().put("id","s-1").put("serviceDate","2026-11-09").put("traineeProfileId","0f469d24-15b8-4597-bf0e-e48fb965aaa8"))))
        val life="lane2-sample-lifetime"
        val pair=KeyPairGenerator.getInstance("EC").apply{initialize(ECGenParameterSpec("secp256r1"))}.generateKeyPair()
        val signer=JcaDeviceSigner(pair.private,pair.public,KeyProtection.SOFTWARE)
        val backend=object:FieldBackend{
            override val isSignedIn=true
            override fun loadSigner()=signer
            override fun signIn(email:String,password:String)=Unit
            override fun signOut()=Unit
            override fun refreshEnrollment(signer:DeviceSigner)=EnrollmentState.Ready("lane2-device")
            override fun sapMasterLifetime()=life
            override fun today(deviceId:String,signer:DeviceSigner,sync:Boolean)=TodayData(partner=fixtures.getJSONObject("distributor"))
            override fun domainForms(kind:String,refresh:Boolean)=JSONObject(fixtures.getJSONObject(kind).toString()).put("authorizationExpiresAt",System.currentTimeMillis()+600_000).put("localOperations",JSONArray())
        }
        val work=CoroutineScope(SupervisorJob()+Dispatchers.Main.immediate)
        val controller=FieldController(backend,work)
        var scene by mutableIntStateOf(0)
        var mounted by mutableStateOf(true)
        val location=object:VisitLocation{override val requiresPermission=false;override suspend fun fix():JSONObject?=null}
        try{
            rule.setContent{if(mounted)MaterialTheme(colorScheme=SunprideTokens.lightColors){
                LaunchedEffect(Unit){controller.refresh()}
                Box(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()){
                    when(scene){0->JointCallScreen(controller);1->CollectorScreen(controller);else->DsrScreen(controller,location)}
                }
            }}
            rule.waitUntil(10_000){!controller.busy&&rule.onAllNodesWithTag("joint-call-add").fetchSemanticsNodes().isNotEmpty()}
            val fab=rule.onNodeWithTag("joint-call-add").assertIsDisplayed()
            rule.onNodeWithText("Add joint call",useUnmergedTree=true).assertIsDisplayed()
            val root=rule.onRoot().getUnclippedBoundsInRoot()
            val fb=fab.getUnclippedBoundsInRoot()
            assertTrue("FAB inside the first viewport",fb.bottom<=root.bottom&&fb.top>=root.top)
            // saved session reads as Edit with a short date, never ISO
            rule.onNodeWithText("Edit · SAMPLE trainee · Nov 9").assertIsDisplayed()
            assertTrue(rule.onAllNodesWithText("2026-11-09",substring=true).fetchSemanticsNodes().isEmpty())
            assertTrue(rule.onAllNodesWithText("New joint call").fetchSemanticsNodes().isEmpty())
            // the last row (saved session) scrolls clear of the FAB
            val sync=rule.onNodeWithText("Edit · SAMPLE trainee · Nov 9").performScrollTo().getUnclippedBoundsInRoot()
            assertTrue("FAB does not cover the last row",sync.bottom<=fb.top||sync.right<=fb.left)
            capture("joint-call-list")
            fab.performClick()
            rule.onNodeWithText("Save draft").performScrollTo().assertIsDisplayed()
            rule.onNodeWithText("Save and finish").assertExists()
            assertTrue("FAB hides while the form is open",rule.onAllNodesWithTag("joint-call-add").fetchSemanticsNodes().isEmpty())
            rule.runOnIdle{scene=1}
            rule.waitUntil(10_000){rule.onAllNodesWithText("1. SAMPLE store 0 · overdue balance").fetchSemanticsNodes().isNotEmpty()}
            rule.onNodeWithText("Refresh").assertIsDisplayed()
            rule.onNodeWithText("1. SAMPLE store 0 · overdue balance").performClick()
            rule.onNodeWithText("Save promise").performScrollTo().assertIsDisplayed()
            rule.onNodeWithText("Save cheque").performScrollTo().assertIsDisplayed()
            rule.onNodeWithText("Take photo").performScrollTo().assertIsDisplayed()
            capture("collector")
            assertTrue(rule.onAllNodesWithText("on phone",substring=true).fetchSemanticsNodes().isEmpty())
            rule.runOnIdle{scene=2}
            rule.waitUntil(10_000){rule.onAllNodesWithText("Sync").fetchSemanticsNodes().isNotEmpty()}
            assertTrue(rule.onAllNodesWithText("Sync distributor work").fetchSemanticsNodes().isEmpty())
        }finally{rule.runOnUiThread{mounted=false};rule.waitForIdle();work.cancel()}
    }
}
