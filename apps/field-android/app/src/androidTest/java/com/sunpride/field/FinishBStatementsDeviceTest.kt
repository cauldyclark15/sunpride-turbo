package com.sunpride.field

import androidx.activity.ComponentActivity
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.auth.EnrollmentState
import com.sunpride.field.ui.FieldBackend
import com.sunpride.field.ui.incentives.EarnedStatement
import com.sunpride.field.ui.incentives.EarnedStatementsScreen
import java.io.File
import org.junit.Rule
import org.junit.Test

/** Short physical-screen proof with explicit sample responses; never touches an account or its cache. */
class FinishBStatementsDeviceTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    @Test fun samplePersonalStatementKeepsPaymentDisclaimerAndOnlineRefreshVisible() {
        val backend=object:FieldBackend {
            override val isSignedIn=true
            override fun loadSigner():DeviceSigner=error("No device credentials used")
            override fun signIn(email:String,password:String)=Unit
            override fun signOut()=Unit
            override fun refreshEnrollment(signer:DeviceSigner):EnrollmentState=error("No enrollment used")
            override fun earnedStatements()=listOf(EarnedStatement("Sample earned plan","October sample","calculated",12500,true,emptyList()))
        }
        rule.setContent { MaterialTheme { EarnedStatementsScreen(backend,{}) } }
        rule.waitUntil(10000){rule.onAllNodesWithText("Sample earned plan").fetchSemanticsNodes().isNotEmpty()}
        rule.onNodeWithText("Sample earned plan").assertIsDisplayed()
        rule.onNodeWithText("Your own results only. Calculated or approved earnings are not proof of payment; SAP remains the payout authority.").assertIsDisplayed()
        rule.onNodeWithTag("earned-refresh").performScrollTo().assertIsDisplayed().performClick()
        rule.waitForIdle()
        val instrumentation=InstrumentationRegistry.getInstrumentation()
        val image=checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        File(instrumentation.targetContext.getExternalFilesDir(null),"finish-b-earned.png").outputStream().use { image.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) }
    }
}
