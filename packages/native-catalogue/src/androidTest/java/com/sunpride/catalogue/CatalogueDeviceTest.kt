package com.sunpride.catalogue

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.zxing.BarcodeFormat
import com.google.zxing.MultiFormatWriter
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest

/** F-616 physical-device fixture test. The separate lane walk proves live API
 * bootstrap; this test covers offline screen/decoder/image-cache behavior only. */
@RunWith(AndroidJUnit4::class)
class CatalogueDeviceTest {
    @get:Rule val ui=createComposeRule()
    @Test fun f616OfflineSearchDecodedScanAndImageWorkWithoutAWebViewOrNetwork(){
        val context=ApplicationProvider.getApplicationContext<android.content.Context>()
        val bytes=context.assets.open("sample-catalogue.jpg").use{it.readBytes()}
        val sha=MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it.toInt() and 255)}
        val id="11111111-1111-4111-8111-111111111111"
        val details=CatalogueDetails(1,id,"sample",true,"SAMPLE description","SAMPLE ingredients","SAMPLE allergens","SAMPLE storage",180,"SAMPLE case specs",listOf(CataloguePack("CASE","Case",24,1,"PC")),CatalogueImage("/api/v1/masters/catalogue-images/$id",sha,bytes.size))
        val code="4006381333931"
        val entry=CatalogueEntry(id,"SAMPLE-001","Sample offline product",listOf(code),details)
        val products=listOf(entry)+(2..500).map{CatalogueEntry("product-$it","SAMPLE-$it","Sample other product $it",emptyList(),null)}
        val event=mutableStateOf<Pair<Long,String>?>(null)
        ui.setContent{MaterialTheme{CatalogueScreen(products,{},scanEvent=event.value)}}
        ui.onNodeWithTag("catalogue-search").performTextInput("offline product")
        ui.onNodeWithText("1 of 500 saved products").assertIsDisplayed()
        ui.onNodeWithTag("catalogue-product-SAMPLE-001").performClick()
        ui.waitUntil(15000){ui.onAllNodesWithTag("catalogue-image").fetchSemanticsNodes().isNotEmpty()}
        ui.onNodeWithTag("catalogue-image").assertIsDisplayed()
        ui.onNodeWithTag("catalogue-detail").performScrollToNode(hasText("Case specifications"))
        ui.onNodeWithText("SAMPLE case specs").assertIsDisplayed()
        ui.onNodeWithTag("catalogue-back").performClick()
        val matrix=MultiFormatWriter().encode(code,BarcodeFormat.EAN_13,600,180)
        val y=ByteArray(matrix.width*matrix.height){i->if(matrix[i%matrix.width,i/matrix.width])0 else 255.toByte()}
        val scan=CameraBarcodeDecoder().decode(y,matrix.width,matrix.height)
        assertEquals(code,scan)
        ui.runOnIdle{event.value=1L to scan!!}
        ui.onNodeWithTag("catalogue-title").assertTextEquals("Sample offline product")
        ui.waitUntil(15000){ui.onAllNodesWithTag("catalogue-image").fetchSemanticsNodes().isNotEmpty()}
        ui.onNodeWithTag("catalogue-sample").assertIsDisplayed()
        val cached=CatalogueImageCache(File(context.noBackupFilesDir,"catalogue-images")).get(sha)
        assertNotNull(cached);assertEquals(bytes.size.toLong(),cached!!.length())
        val screenshot=InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
        assertNotNull(screenshot)
        File(context.getExternalFilesDir(null),"f616-catalogue-fixture.png").outputStream().use{screenshot!!.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)}
        screenshot!!.recycle()
    }
}
