package com.sunpride.field.ui.customers

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.sunpride.field.AppEnvironment
import com.sunpride.field.auth.EnrollmentState
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.KeystoreDeviceKey
import com.sunpride.field.ui.AppMode
import com.sunpride.field.ui.AppModes
import com.sunpride.field.ui.FieldApp
import com.sunpride.field.ui.FieldBackend
import com.sunpride.field.ui.TodayData
import com.sunpride.field.ui.mapping.MappingSave
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** SP-0250: real Customers tab -> waiting row -> submitted editor, with fixture transport only.
 * Compile without a device in the issue lane; execution belongs to the authorized phone check. */
class WaitingCustomerProfilesTest {
    @get:Rule val rule = createAndroidComposeRule<androidx.activity.ComponentActivity>()
    private val id = "b0599748-37c9-4b4f-87f8-ebae2a8c6486"
    private val alias = "sunpride-sp250-waiting-ui-test"

    private inner class Backend(val approved: Boolean = false, val admin: Boolean = false) : FieldBackend {
        val opened = mutableListOf<String>()
        override val isSignedIn = true
        override fun loadSigner(): DeviceSigner = KeystoreDeviceKey.loadOrCreate(rule.activity, alias)
        override fun signIn(email: String, password: String) = Unit
        override fun signOut() = Unit
        override fun refreshEnrollment(signer: DeviceSigner) = EnrollmentState.Ready("sample-phone")
        override fun today(deviceId: String, signer: DeviceSigner, sync: Boolean) = TodayData(lastSynced = 123L, stale = false)
        override fun appModes() = AppModes(AppMode.MAPPING)
        override fun mappingSaves() = listOf(MappingSave("Sample waiting store", null, true, 123L, profileId = id))
        override fun customerProfile(id: String, preview: JSONObject?): JSONObject {
            opened += id
            return JSONObject().put("customer", JSONObject().put("id", id).put("customerName", "Sample waiting store")
                .put("status", "active").put("enrolmentStatus", if (approved) "approved" else "provisional")
                .put("canEdit", !approved || admin).put("updatedAt", 123L)
                .put("history", JSONArray().put(JSONObject().put("actor", "Sample salesman").put("at", 123L)
                    .put("changes", JSONArray().put(JSONObject().put("label", "Street 1")
                        .put("before", JSONObject.NULL).put("after", "Sample Road"))))))
                .put("fields", JSONArray().put(JSONObject().put("key", "mobileNo").put("label", "Mobile No.")
                    .put("section", "Contact details").put("kind", "text").put("value", "").put("error", "Mobile No. is required.")))
                .put("missingFields", JSONArray().put(JSONObject().put("label", "Mobile No.")))
        }
    }

    @After fun clearKey() = KeystoreDeviceKey.delete(alias)

    private fun openFromCustomers(backend: Backend) {
        rule.setContent { FieldApp(AppEnvironment("https://practice.invalid"), dark = false, backend = backend) }
        rule.waitUntil(10_000) { rule.onAllNodesWithTag("nav-stores").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag("nav-stores").performClick()
        rule.waitUntil(10_000) { rule.onAllNodesWithTag("customer-waiting").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag("customer-waiting").performClick()
        rule.waitUntil(10_000) { rule.onAllNodesWithTag("profile-status").fetchSemanticsNodes().isNotEmpty() }
        assertEquals(listOf(id), backend.opened)
    }

    @Test fun waitingRowOpensTheProfileWithMissingFieldsAndHistory() {
        openFromCustomers(Backend())
        rule.onNodeWithTag("profile-status").assertTextContains("Waiting for approval")
        rule.onNodeWithText("Still to complete: Mobile No.").assertExists()
        rule.onNodeWithTag("profile-mobileNo").performScrollTo().assertIsEnabled()
        rule.onNodeWithText("Street 1: Not set → Sample Road").performScrollTo().assertExists()
        rule.onNodeWithText("Save details").assertExists()
    }

    @Test fun approvalSinceTheListWasSavedOpensReadOnlyForTheSalesman() {
        openFromCustomers(Backend(approved = true))
        rule.onNodeWithTag("profile-status").assertTextContains("Approved / closed")
        rule.onNodeWithTag("profile-mobileNo").performScrollTo().assertIsNotEnabled()
        rule.onNodeWithText("Read only. After approval only admins can edit.").performScrollTo().assertExists()
        rule.onNodeWithText("Save details").assertDoesNotExist()
    }

    @Test fun adminCanStillEditAfterApproval() {
        openFromCustomers(Backend(approved = true, admin = true))
        rule.onNodeWithTag("profile-status").assertTextContains("Approved / closed")
        rule.onNodeWithTag("profile-mobileNo").performScrollTo().assertIsEnabled()
        rule.onNodeWithText("Save details").assertExists()
    }

    @Test fun unsentCustomerDoesNotOpenAProfileUsingItsCaptureId() {
        rule.setContent {
            MaterialTheme {
                CustomerSearchScreen(TodayData(), onOpen = { error("Not a downloaded customer") }, mapping = true,
                    waiting = listOf(MappingSave("Sample unsent store", null, false, 123L)),
                    onOpenSubmitted = { error("No customer acknowledgement yet") })
            }
        }
        rule.onNodeWithTag("customer-waiting").assertHasNoClickAction()
    }
}
