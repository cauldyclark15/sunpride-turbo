package com.sunpride.field.census

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
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

/** SP-0244: fake boundaries only; no camera, location permission, network or phone mutation is needed. */
class CustomerDraftScreenTest {
    @get:Rule val rule = createAndroidComposeRule<androidx.activity.ComponentActivity>()
    private class Backend : FieldBackend {
        @Volatile var disk: String? = null
        @Volatile var failWrites = false
        val queued = mutableListOf<JSONObject>()
        override val isSignedIn = true
        override fun loadSigner(): DeviceSigner = error("unused")
        override fun signIn(email: String, password: String) = Unit
        override fun signOut() = Unit
        override fun refreshEnrollment(signer: DeviceSigner) = EnrollmentState.SignedOut
        override fun censusConfig() = JSONObject().put("customerMaster", JSONObject().put("salesOrgCode", "1000")
            .put("lists", JSONArray().put(JSONObject().put("list", "sales_organization").put("code", "1000").put("name", "SFI"))))
        override fun customerDraft() = disk
        override fun saveCustomerDraft(json: String?) { check(!failWrites); disk = json }
        override fun queueCensus(payload: JSONObject) { queued += payload }
    }
    private val noLocation = object : VisitLocation {
        override val requiresPermission = false
        override suspend fun fix(): JSONObject = error("Drafts must not request a location")
    }
    private fun waitTag(tag: String) = rule.waitUntil(10_000) { rule.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }

    @Test fun severalIncompleteDraftsReopenAfterScreenAndHolderRecreationAndFinalSaveStillChecksFields() {
        val backend = Backend()
        val generation = mutableStateOf(0)
        rule.setContent {
            androidx.compose.runtime.key(generation.value) {
                MaterialTheme(colorScheme = SunprideTokens.lightColors) { CensusScreen(backend, noLocation, {}) }
            }
        }
        waitTag("customer-save-draft")
        rule.onNodeWithTag("customer-firstName").performScrollTo().performTextInput("First customer")
        rule.onNodeWithTag("customer-save-draft").performClick()
        waitTag("customer-drafts-new")
        rule.onNodeWithTag("customer-drafts-new").performClick()
        rule.onNodeWithTag("customer-firstName").performScrollTo().performTextInput("Second customer")
        rule.onNodeWithTag("customer-save-draft").performClick()
        waitTag("customer-drafts-new")
        rule.runOnIdle { generation.value++ }
        waitTag("customer-drafts-new")
        rule.onNodeWithTag("customer-draft-${CustomerDrafts.parse(backend.disk).saved.first().id}").performScrollTo().performClick()
        rule.onNodeWithTag("customer-firstName").assertTextContains("First customer")
        rule.onNodeWithTag("census-save").performClick()
        waitTag("customer-missing-registeredName")
        rule.onNodeWithTag("customer-missing-coordinates").assertDoesNotExist() // SP-0243: location never blocks final Save.
        rule.onNodeWithTag("customer-missing-photo").assertDoesNotExist() // SP-0256: Store Photo is optional.
        assertTrue(backend.queued.isEmpty())
        rule.onNodeWithTag("customer-save-draft").performClick()
        waitTag("customer-drafts-new")
        assertEquals(2, CustomerDrafts.parse(backend.disk).saved.size)
    }

    @Test fun failedDraftWriteKeepsTheFormVisibleForRetry() {
        val backend = Backend()
        rule.setContent { MaterialTheme { CensusScreen(backend, noLocation, {}) } }
        waitTag("customer-save-draft")
        rule.onNodeWithTag("customer-firstName").performScrollTo().performTextInput("Not lost")
        backend.failWrites = true
        rule.onNodeWithTag("customer-save-draft").performClick()
        waitTag("census-save-note")
        rule.onNodeWithTag("customer-firstName").performScrollTo().assertTextContains("Not lost")
        assertTrue(backend.queued.isEmpty())
        backend.failWrites = false
        rule.onNodeWithTag("customer-save-draft").performClick()
        waitTag("customer-drafts-new")
        assertEquals("Not lost", CustomerDrafts.parse(backend.disk).saved.single().draft.form.firstName)
    }
}
