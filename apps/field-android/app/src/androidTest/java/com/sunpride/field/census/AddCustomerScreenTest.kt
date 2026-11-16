package com.sunpride.field.census

import android.Manifest
import android.graphics.Bitmap
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.field.auth.EnrollmentState
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.ui.FieldBackend
import com.sunpride.field.ui.SunprideTokens
import com.sunpride.field.ui.diagnosticvisit.VisitLocation
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File

/** SP-0170 Add customer against a fake API: the client's sections, labels and dependent pickers, offline geography,
 * and the queued census.capture with the `customer` object. Screenshots go to the app's files/cg-shots. */
class AddCustomerScreenTest {
    @get:Rule val rule = createAndroidComposeRule<androidx.activity.ComponentActivity>()
    @org.junit.Before fun grantCamera() {
        val i = InstrumentationRegistry.getInstrumentation(); i.uiAutomation.grantRuntimePermission(i.targetContext.packageName, Manifest.permission.CAMERA)
    }
    private fun ref(list: String, code: String, name: String, org: String = "", ch: String = "", g1: String = "") =
        JSONObject().put("list", list).put("salesOrgCode", org).put("channelCode", ch).put("group1Code", g1).put("code", code).put("name", name)
    private val config = JSONObject().put("addressSearch", false).put("batches", JSONArray()).put("channels", JSONArray()).put("subchannels", JSONArray())
        .put("customerMaster", JSONObject().put("salesOrgCode", "1000").put("provinceCodes", JSONArray().put("0702200000")).put("lists", JSONArray()
            .put(ref("sales_organization", "1000", "SFI")).put(ref("sales_organization", "2000", "ARI"))
            .put(ref("distribution_channel", "41", "Route Sales", "1000")).put(ref("distribution_channel", "50", "Services", "1000"))
            .put(ref("customer_group_1", "RSF", "RS Frozen", "1000", "41"))
            .put(ref("customer_group_2", "RSS", "Sari-Sari Store", "1000", "41", "RSF"))
            .put(ref("customer_group", "74", "NO GROUP")).put(ref("type_of_business", "Sole Proprietor", "Sole Proprietor"))
            .put(ref("country", "PH", "Philippines")).put(ref("tax_classification", "1", "Liable for Taxes"))
            .put(ref("sales_office", "100", "SFI Cebu", "1000")).put(ref("payment_terms", "0003", "Due in 7 days"))
            .put(ref("pricing_procedure", "2", "Standard Inclusive Tax")).put(ref("delivering_plant", "1000", "Cebu Production", "1000"))
            .put(ref("distribution_channel", "40", "Distributive Trade", "1000"))))
    private val geography = CustomerCapture.Geography.parse(JSONObject()
        .put("regions", JSONArray().put(JSONObject().put("code", "0700000000").put("name", "Region VII (Central Visayas)")))
        .put("provinces", JSONArray().put(JSONObject().put("code", "0702200000").put("name", "Cebu").put("regionCode", "0700000000")))
        .put("municipalities", JSONArray().put(JSONObject().put("code", "0730600000").put("name", "City of Cebu").put("provinceCode", "0702200000")))
        .put("postalCodes", JSONArray().put(JSONObject().put("municipalityCode", "0730600000").put("code", "6000"))))
        .withBarangays("0702200000", listOf(CustomerMaster.GeoBarangay("0730600003", "Apas", "0730600000")))

    private class Backend(val cfg: JSONObject, val geo: CustomerCapture.Geography) : FieldBackend {
        val queued = mutableListOf<JSONObject>()
        override val isSignedIn = true
        override fun loadSigner(): DeviceSigner = error("unused")
        override fun signIn(email: String, password: String) = Unit
        override fun signOut() = Unit
        override fun refreshEnrollment(signer: DeviceSigner) = EnrollmentState.SignedOut
        override fun censusConfig() = cfg
        override fun customerGeography(provinces: List<String>) = geo
        override fun queueCensus(payload: JSONObject) { CensusRules.validate(payload); queued += payload }
    }
    private val gps = object : VisitLocation {
        override val requiresPermission = false
        override suspend fun fix(): JSONObject = JSONObject().put("latitude", 10.3312).put("longitude", 123.9056).put("accuracyMeters", 8.0)
            .put("fixTime", System.currentTimeMillis()).put("provider", "fused").put("mockSignal", false)
    }
    private val jpeg = byteArrayOf(0xff.toByte(), 0xd8.toByte(), 1, 2, 0xff.toByte(), 0xd9.toByte())
    private fun shot(name: String) {
        rule.runOnUiThread { val w = rule.activity.window
            androidx.core.view.WindowInsetsControllerCompat(w, w.decorView).hide(androidx.core.view.WindowInsetsCompat.Type.ime()) }
        rule.waitForIdle(); Thread.sleep(800)
        val bmp = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot() ?: return
        val dir = File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir, "cg-shots").apply { mkdirs() }
        File(dir, "field-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    private fun waitTag(tag: String, ms: Long = 10_000) = rule.waitUntil(ms) { rule.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }
    private fun show(backend: Backend) = rule.setContent {
        MaterialTheme(colorScheme = SunprideTokens.lightColors) { CensusScreenForTest(backend, gps, {}, photoForTest = jpeg) }
    }
    private fun choose(tag: String, option: String) {
        rule.onNodeWithTag(tag).performScrollTo().performClick(); rule.waitForIdle()
        rule.waitUntil(5_000) { rule.onAllNodesWithText(option).fetchSemanticsNodes().isNotEmpty() }
        Thread.sleep(300)
        rule.onAllNodesWithText(option).fetchSemanticsNodes().size.let { if (it > 1) rule.onAllNodesWithText(option)[it - 1].performClick() else rule.onNodeWithText(option).performClick() }
        rule.waitForIdle()
    }
    private fun type(key: String, text: String) = rule.onNodeWithTag("customer-$key").performScrollTo().performTextInput(text)

    @Test fun fullCaptureQueuesTheCustomerObject() {
        val backend = Backend(config, geography); show(backend)
        waitTag("customer-customerName")
        rule.onNodeWithText(CustomerMaster.GENERAL).assertExists()
        rule.onNodeWithTag("customer-salesOrgCode").performScrollTo().assertTextContains("SFI (1000)", substring = true)
        rule.onNodeWithTag("customer-registeredName").performScrollTo(); shot("01-general-information")
        type("registeredName", "Nena Store Inc"); type("customerName", "Aling Nena Store"); type("tradeName", "Nena's"); type("mobileNo", "09175550101")
        choose("customer-taxClassificationCode", "Liable for Taxes (1)")
        choose("customer-regionCode", "Region VII (Central Visayas)"); choose("customer-provinceCode", "Cebu")
        choose("customer-municipalityCode", "City of Cebu"); choose("customer-barangayCode", "Apas")
        rule.onNodeWithTag("customer-postalCode").performScrollTo().assertTextContains("6000", substring = true)
        type("houseNo", "12"); type("street1", "Gorordo Ave")
        rule.onNodeWithTag("census-gps").performScrollTo().performClick(); waitTag("census-accuracy")
        rule.onNodeWithTag("census-accuracy").assertTextContains("±8 m", substring = true)
        shot("02-location")
        choose("customer-salesOfficeCode", "SFI Cebu (100)")
        choose("customer-distributionChannelCode", "Route Sales (41)"); choose("customer-customerGroup1Code", "RS Frozen (RSF)")
        choose("customer-customerGroup2Code", "Sari-Sari Store (RSS)"); choose("customer-customerGroupCode", "NO GROUP (74)")
        choose("customer-typeOfBusiness", "Sole Proprietor")
        rule.onNodeWithTag("customer-typeOfBusiness").performScrollTo(); shot("03-assignment")
        choose("customer-paymentTermsCode", "Due in 7 days (0003)")
        type("creditLimit", "1000.50")
        choose("customer-pricingProcedureCode", "Standard Inclusive Tax (2)")
        choose("customer-deliveringPlantCode", "Cebu Production (1000)")
        rule.onNodeWithTag("customer-sameAsCustomer").performScrollTo().performClick()
        type("shipToParty", "Nena Warehouse"); type("shipToAddress", "99 Delivery Road")
        type("shipToMobileNo", "09175550202"); type("shipToEmail", "delivery@example.ph")
        type("contactPerson", "Nena Cruz"); shot("04-delivery-contact")
        rule.onNodeWithTag("customer-customerAddress").performScrollTo().assertTextContains("12 Gorordo Ave, Apas, City of Cebu, Cebu 6000")
        // SP-0183: every other required field is filled; Registered Name alone must block saving.
        rule.onNodeWithTag("census-save").performClick()
        waitTag("customer-missing-registeredName")
        rule.onNodeWithTag("customer-missing-registeredName").assertTextContains("Registered Name is required.")
        assertTrue(backend.queued.isEmpty())
        type("registeredName", "Aling Nena Store Inc.")
        rule.onNodeWithTag("census-save").performClick()
        rule.waitUntil(10_000) { backend.queued.isNotEmpty() }
        val p = backend.queued.single(); val c = p.getJSONObject("customer")
        assertEquals("Aling Nena Store", p.getString("name")); assertEquals("Nena Cruz", p.getString("ownerName"))
        assertEquals("RSS", c.getString("customerGroup2Code")); assertEquals("0730600003", c.getString("barangayCode"))
        assertEquals("12 Gorordo Ave, Apas, City of Cebu, Cebu 6000", c.getString("customerAddress"))
        assertFalse(p.has("channelId"))
        for (key in listOf("taxClassificationCode", "salesOfficeCode", "paymentTermsCode", "pricingProcedureCode", "deliveringPlantCode")) assertTrue(c.has(key))
        assertEquals("Nena Warehouse", c.getJSONArray("shipTos").getJSONObject(0).getString("shipToParty"))
        shot("05-saved")
    }

    @Test fun allFormerAdminControlsAndConditionalAdpAreVisible() {
        val backend = Backend(config, geography); show(backend); waitTag("customer-customerName")
        for (key in listOf("taxClassificationCode", "countryCode", "salesOfficeCode", "salesPartnerCode", "paymentTermsCode",
            "creditLimit", "pricingProcedureCode", "deliveringPlantCode", "shipToParty", "shipToAddress", "contactPerson", "shipToMobileNo", "shipToEmail"))
            rule.onNodeWithTag("customer-$key").performScrollTo().assertExists()
        assertTrue(rule.onAllNodesWithTag("customer-distributorCode").fetchSemanticsNodes().isEmpty())
        choose("customer-distributionChannelCode", "Distributive Trade (40)")
        for (field in CustomerMaster.CUSTOMER_FIELDS.filter { it.adp }) rule.onNodeWithTag("customer-${field.key}").performScrollTo().assertExists()
        choose("customer-distributionChannelCode", "Services (50)")
        assertTrue(rule.onAllNodesWithTag("customer-distributorCode").fetchSemanticsNodes().isEmpty())
    }

    @Test fun saveWithMissingFieldsMarksThemAndServicesHasNoGroups() {
        val backend = Backend(config, geography); show(backend)
        waitTag("customer-customerName")
        type("customerName", "Bebot Grocery")
        rule.onNodeWithTag("census-save").performClick(); rule.waitForIdle()
        for (k in listOf("registeredName", "mobileNo", "regionCode", "coordinates", "distributionChannelCode", "contactPerson")) waitTag("customer-missing-$k", 3_000)
        rule.onNodeWithTag("customer-missing-mobileNo").assertTextContains("Mobile No. is required.")
        shot("06-missing-fields")
        choose("customer-distributionChannelCode", "Services (50)")
        waitTag("customer-na-customerGroup1Code"); waitTag("customer-na-customerGroup2Code")
        assertTrue(rule.onAllNodesWithTag("customer-missing-customerGroup1Code").fetchSemanticsNodes().isEmpty())
        shot("07-services-no-groups")
        assertTrue(backend.queued.isEmpty())
    }
}
