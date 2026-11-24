package com.sunpride.field.ui.customers

import com.sunpride.field.ui.BackNavigation
import com.sunpride.field.ui.BackState
import com.sunpride.field.ui.BackStep
import com.sunpride.field.ui.FieldNav
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SubmittedCustomerEditsTest {
    @Test fun partialEditsPreserveNestedPathsExplicitBlanksAndVersion() {
        val body = SubmittedCustomerEdits.body(mapOf("street1" to "Sample Road", "shipTos[0].contactPerson" to "Sample Owner", "email" to ""), 123L)
        assertEquals(123L, body.getLong("expectedUpdatedAt"))
        val edits = body.getJSONObject("edits")
        assertEquals("Sample Road", edits.getString("street1"))
        assertEquals("Sample Owner", edits.getString("shipTos[0].contactPerson"))
        assertTrue(edits.isNull("email"))
        assertFalse(body.has("status"))
        assertFalse(body.has("code"))
    }
    @Test fun changingParentClearsItsOldChildrenButKeepsOtherEdits() {
        val field = JSONObject("""{"key":"regionCode","clears":["provinceCode","municipalityCode","barangayCode"]}""")
        val changed = SubmittedCustomerEdits.change(mapOf("registeredName" to "Sample Shop", "provinceCode" to "old"), field, "new")
        assertEquals("new", changed["regionCode"])
        assertEquals("", changed["provinceCode"])
        assertEquals("", changed["barangayCode"])
        assertEquals("Sample Shop", changed["registeredName"])
    }
    @Test fun approvalIsNotInferredFromSuccessfulSaveOrActiveStatus() {
        assertTrue(SubmittedCustomerEdits.waiting(JSONObject("""{"status":"active","enrolmentStatus":"provisional"}""")))
        assertFalse(SubmittedCustomerEdits.waiting(JSONObject("""{"status":"active","enrolmentStatus":"approved"}""")))
    }
    @Test fun profilesAreReachableInMappingAndReturnToTheirOriginWithoutBottomBar() {
        assertTrue("customer-profiles" in FieldNav.overlayPages)
        assertTrue("customer-profiles" in FieldNav.noBarPages)
        assertEquals(BackStep.ToPage("more"), BackNavigation.step(BackState(page="customer-profiles", origin="more")))
    }
}
