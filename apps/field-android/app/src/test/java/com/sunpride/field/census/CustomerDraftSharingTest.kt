package com.sunpride.field.census

import com.sunpride.field.storage.StoreScope
import com.sunpride.field.sync.V2Wire
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CustomerDraftSharingTest {
    private val scope = StoreScope("account", "device", "scope")
    private fun empty() = CustomerCapture.Draft(CustomerCapture.Form(), null, null)
    private fun payload(row: com.sunpride.field.storage.IntentRow) = JSONObject(row.serializedOperation).getJSONObject("payload")

    @Test fun blankDraftsQueueOnlyNonApprovalOperationsAndKeepIndependentIds() {
        val book = CustomerDrafts().save(empty()).save(empty())
        val rows = CustomerDraftSharing.changes(scope, null, book.json(), 1000)
        assertEquals(2, rows.size)
        assertEquals(book.saved.map { it.id }.toSet(), rows.map { payload(it).getString("draftId") }.toSet())
        rows.forEach {
            assertEquals("census.draft", it.kind)
            assertEquals("save", payload(it).getString("action"))
            assertFalse(payload(it).has("photoJpegBase64"))
            assertFalse(payload(it).has("captureId"))
            val wire = V2Wire.operation(JSONObject(it.serializedOperation))
            assertEquals("census.draft", wire.getString("opType"))
            assertEquals(0, wire.getJSONArray("dependsOn").length())
        }
    }

    @Test fun workingFormIsNotSharedBeforeSaveAsDraft() {
        val book = CustomerDrafts().keep(empty().copy(form = CustomerCapture.Form(registeredName = "Typing")))
        assertTrue(CustomerDraftSharing.changes(scope, null, book.json(), 1000).isEmpty())
    }

    @Test fun partlyTypedTextSurvivesSharingWithoutCustomerValidation() {
        val draft = empty().copy(form = CustomerCapture.Form(email = "unfinished@", mobileNo = "09", details = mapOf("creditLimit" to "1.")))
        val book = CustomerDrafts().save(draft)
        val shared = payload(CustomerDraftSharing.changes(scope, null, book.json(), 1000).single()).getJSONObject("profile")
        assertEquals("unfinished@", shared.getJSONObject("form").getString("email"))
        assertEquals("1.", shared.getJSONObject("details").getString("creditLimit"))
        assertTrue(CustomerCapture.missing(draft.form, null, null, false, false).isNotEmpty())
    }

    @Test fun unchangedDraftsAreNotRepeatedButPreviouslyPhoneOnlyDraftsAreShared() {
        val book = CustomerDrafts().save(empty())
        val known = book.saved.map { it.id }.toSet()
        assertTrue(CustomerDraftSharing.changes(scope, book.json(), book.json(), 1000, known).isEmpty())
        assertEquals(1, CustomerDraftSharing.changes(scope, book.json(), book.json(), 1000).size)
        val reopened = book.open(book.saved.single().id)
        val edit = empty().copy(form = CustomerCapture.Form(registeredName = "Updated"))
        val changed = reopened.save(edit)
        assertEquals("Updated", payload(CustomerDraftSharing.changes(scope, book.json(), changed.json(), 1001, known).single())
            .getJSONObject("profile").getJSONObject("form").getString("registeredName"))
    }

    @Test fun removingOneDraftDoesNotDiscardTheOtherAndRevisionsAreFrozen() {
        val before = CustomerDrafts().save(empty()).save(empty())
        val ids = before.saved.map { it.id }.toSet()
        val after = before.open(before.saved.first().id).clear()
        val rows = CustomerDraftSharing.changes(scope, before.json(), after.json(), 1002, ids)
        assertEquals(1, rows.size)
        assertEquals(before.saved.first().id, payload(rows.single()).getString("draftId"))
        assertEquals("discard", payload(rows.single()).getString("action"))
        assertEquals(1002L, payload(rows.single()).getLong("revision"))
        assertEquals(listOf(before.saved.last().id), CustomerDrafts.parse(after.json()).saved.map { it.id })
    }

    @Test fun photosStayOnPhoneWithoutCreatingLargeSharingPayloads() {
        val draft = empty().copy(photo = ByteArray(100000), form = CustomerCapture.Form(customFields = mapOf("photo" to "data:image/jpeg;base64,large")))
        val shared = CustomerDraftSharing.profile(draft)
        assertFalse(shared.has("photo"))
        assertTrue(shared.getBoolean("photoPresent"))
        assertEquals("Photo saved on phone", shared.getJSONObject("customFields").getString("photo"))
        assertNotNull(CustomerDrafts.parse(CustomerDrafts().save(draft).json()).saved.single().draft.photo)
    }
}
