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

/** Short new-screen proof with real API sample data, explicit backend substitution, no account/phone setting changes. */
class FinishADeviceTest {
    @get:Rule val rule=createAndroidComposeRule<ComponentActivity>()
    private val instrumentation get()=InstrumentationRegistry.getInstrumentation()
    private fun capture(name:String){
        val bitmap=checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        File(instrumentation.targetContext.getExternalFilesDir(null),"finish-a-$name.png").outputStream().use{bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)}
        bitmap.recycle()
    }
    @Test fun F223_F613_F404_F407_newFormsOnThePhone(){
        val fixtures=JSONObject(instrumentation.context.assets.open("finish-a-forms.json").bufferedReader().use{it.readText()})
        val life="isolated-sample-screen-lifetime"
        val pair=KeyPairGenerator.getInstance("EC").apply{initialize(ECGenParameterSpec("secp256r1"))}.generateKeyPair()
        val signer=JcaDeviceSigner(pair.private,pair.public,KeyProtection.SOFTWARE)
        val backend=object:FieldBackend{
            override val isSignedIn=true
            override fun loadSigner()=signer
            override fun signIn(email:String,password:String)=Unit
            override fun signOut()=Unit
            override fun refreshEnrollment(signer:DeviceSigner)=EnrollmentState.Ready("isolated-sample-device")
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
            rule.setContent{if(mounted)MaterialTheme{
                LaunchedEffect(Unit){controller.refresh()}
                Box(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()){
                    when(scene){
                        0->JointCallScreen(controller)
                        1->CollectorScreen(controller)
                        2->FieldCreditControlPanel({_,_->JSONObject().put("orders",JSONArray()).put("requests",JSONArray())},{life})
                        else->DsrScreen(controller,location)
                    }
                }
            }}
            rule.waitUntil(10_000){!controller.busy&&rule.onAllNodesWithTag("joint-call-add").fetchSemanticsNodes().isNotEmpty()}
            rule.onNodeWithTag("joint-call-add").performClick()
            rule.onNodeWithText("SAMPLE trainee").performScrollTo().performClick()
            rule.onNodeWithText("Add BCP").performScrollTo().performClick()
            rule.onNode(hasSetTextAction() and hasText("Observed item")).performScrollTo().performTextInput("Sample opening procedure")
            androidx.test.espresso.Espresso.closeSoftKeyboard()
            rule.onNodeWithText("Basic Call Procedure").performScrollTo().assertIsDisplayed();capture("coaching")
            rule.runOnIdle{scene=1}
            rule.waitUntil(10_000){rule.onAllNodesWithText("1. SAMPLE store 0 · overdue balance").fetchSemanticsNodes().isNotEmpty()}
            rule.onNodeWithText("1. SAMPLE store 0 · overdue balance").performClick()
            rule.onNodeWithText("SAMPLE invoice 1",substring=true).performScrollTo().assertIsDisplayed().performClick()
            capture("collector")
            rule.onNodeWithText("Save promise").performScrollTo().assertIsEnabled()
            rule.runOnIdle{scene=2}
            rule.onNodeWithText("Open credit control").performClick()
            rule.waitUntil(10_000){rule.onAllNodesWithText("No priced orders",substring=true).fetchSemanticsNodes().isNotEmpty()}
            capture("credit-control")
            rule.runOnIdle{scene=3}
            rule.waitUntil(10_000){rule.onAllNodesWithText("SAMPLE Distributor").fetchSemanticsNodes().isNotEmpty()}
            rule.onNodeWithText("SAMPLE Distributor").assertIsDisplayed()
            capture("distributor")
        }finally{rule.runOnUiThread{mounted=false};rule.waitForIdle();work.cancel()}
    }
    /** New forms persist together in the existing SQLCipher tables; a mid-transaction epoch loss rolls back both rows. */
    @Test fun F223_F407_F613_sharedEncryptedOutboxSurvivesReopenAndRefusesRetiredEpoch()=runBlocking{
        val context=instrumentation.targetContext
        val name="finish-a-domain-${UUID.randomUUID()}.db"
        val key=ByteArray(32).also{java.security.SecureRandom().nextBytes(it)}
        System.loadLibrary("sqlcipher")
        fun open()=Room.databaseBuilder(context,StoreDatabase::class.java,name).openHelperFactory(SupportOpenHelperFactory(key.copyOf())).build()
        var db=open()
        val scope=StoreScope("issuer|sample-finish-a","sample-finish-a-device","sample-scope")
        try{
            var store=RoomFieldStore(db,scope)
            store.swap(store.stage(ScopedSnapshot("{\"id\":\"sample\"}",null,emptyList(),emptyList(),emptyList(),emptyList())),"sample-cursor",Long.MAX_VALUE,Long.MAX_VALUE)
            val original=mutableListOf<String>()
            for(kind in listOf("jointcall.capture","collections.capture","dsr.visit.activity")){
                val row=DomainOutbox.intent(scope,kind,JSONObject().put("note","SAMPLE offline domain evidence"))
                original+=row.serializedOperation;store.enqueueDomain(row,System.currentTimeMillis()){true}
            }
            var checks=0
            try{store.enqueueDomain(DomainOutbox.intent(scope,"jointcall.capture",JSONObject()),System.currentTimeMillis()){++checks==1};fail("Retired epoch must roll back")}catch(_:IllegalStateException){}
            assertEquals(3,store.pending().size)
            db.close();db=open();store=RoomFieldStore(db,scope)
            assertEquals(original,store.pending().map{it.first.serializedOperation})
            assertFalse(context.getDatabasePath(name).readBytes().take(16).toByteArray().toString(Charsets.US_ASCII).startsWith("SQLite format 3"))
        }finally{db.close();context.deleteDatabase(name);key.fill(0)}
        Unit
    }
}
