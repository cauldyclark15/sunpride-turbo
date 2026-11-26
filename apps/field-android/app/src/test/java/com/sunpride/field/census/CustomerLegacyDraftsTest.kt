package com.sunpride.field.census

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

/** Production download/book/serialization rules. No device, Room or live account is substituted as proof. */
class CustomerLegacyDraftsTest {
    private fun customer(name: String = "Older store") = JSONObject()
        .put("id", UUID.randomUUID().toString()).put("updatedAt", 12345L)
        .put("registeredName", name).put("customerName", "Ana Cruz")
        .put("street1", "Original street").put("paymentTermsCode", "0003")
        .put("mobileNo", JSONObject.NULL)
        .put("fieldMissing", JSONArray().put(JSONObject().put("field", "mobileNo")))
        .put("fieldSubmitted", JSONObject().put("mobileNo", "0917"))
        .put("shipTos", JSONArray().put(JSONObject().put("sameAsCustomer", false)
            .put("shipToParty", "Delivery store").put("contactPerson", "Ana")
            .put("shipToAddress", "Delivery address").put("mobileNo", "09175550101")))

    @Test fun earlierUploadedCustomersReopenOfflineWithAllTypedAnswersAndOneCount() {
        val c = customer()
        val book = CustomerDrafts().mergeDownloaded(listOf(c))
        val holder = CustomerDraftHolder()
        holder.restore(book.json())
        assertEquals(1, holder.savedCount)
        val entry = holder.customers.saved.single()
        assertEquals(c.getString("id"), entry.existingCustomerId)
        assertEquals(12345L, entry.expectedUpdatedAt)
        assertEquals("0003", entry.draft.form.detail("paymentTermsCode"))
        assertEquals("0917", entry.draft.form.mobileNo)
        assertEquals("Ana Cruz", CustomerCapture.customerName(entry.draft.form))
        assertEquals("", entry.draft.form.firstName) // never invent name parts
        assertEquals("Delivery store", entry.draft.form.shipToParty)
        assertEquals("Ana", entry.draft.form.contactPerson)
        assertFalse(entry.draft.form.sameAsCustomer)
        val reopened = CustomerDrafts.parse(holder.customers.open(entry.id).json())
        assertEquals(entry.draft.form, reopened.active!!.form)
        val payload = CustomerCapture.payload(UUID.randomUUID().toString(), reopened.active.form, null, 5000L, null, null)
            .put("allowIncomplete", true)
        val queued = reopened.queued(payload, reopened.active, false)
        assertFalse(payload.getJSONObject("customer").has("firstName"))
        CensusRules.validate(payload)
        assertEquals(c.getString("id"), payload.getString("existingCustomerId"))
        assertEquals(12345L, payload.getLong("expectedUpdatedAt"))
        assertEquals(1, queued.mergeDownloaded(listOf(c)).saved.size)
        val nextPayload = JSONObject().put("captureId", UUID.randomUUID().toString())
        val next = queued.open(entry.id).queued(nextPayload, entry.draft, true)
        holder.restore(next.json())
        assertEquals(0, holder.savedCount)
        assertEquals(1, holder.customers.awaitingConfirmation.size)
        assertFalse(nextPayload.has("existingCustomerId")) // future saves use ordered revisions
        assertEquals(0, next.mergeDownloaded(listOf(c)).saved.size) // stale list cannot resurrect it
        val states = JSONArray().put(JSONObject().put("draftId", entry.id).put("revision", 2).put("completeness", "complete"))
        assertNull(next.reconcile(states).json())
    }

    @Test fun refreshKeepsNewerEditsAndOpenFormsButRemovesUntouchedOfficeCompletions() {
        val c = customer()
        val original = CustomerDrafts().mergeDownloaded(listOf(c))
        val id = original.saved.single().id
        assertTrue(original.mergeDownloaded(emptyList()).saved.isEmpty())
        assertEquals(1, original.open(id).mergeDownloaded(emptyList()).saved.size)
        val open = original.open(id)
        val edited = open.active!!.copy(form = open.active.form.copy(street1 = "Changed offline"))
        val saved = open.keep(edited).save(edited)
        val refresh = JSONObject(c.toString()).put("street1", "Later office street").put("updatedAt", 67890L)
        val merged = CustomerDrafts.parse(saved.json()).mergeDownloaded(listOf(refresh))
        assertEquals("Changed offline", merged.saved.single().draft.form.street1)
        assertEquals(12345L, merged.saved.single().expectedUpdatedAt) // office conflict remains detectable
        assertEquals(1, merged.mergeDownloaded(emptyList()).saved.size)
        assertEquals("Later office street", original.mergeDownloaded(listOf(refresh)).saved.single().draft.form.street1)
    }

    @Test fun absentNestedAnswersStayBlankAndDeferredNestedTextIsKept() {
        val c = customer()
        val ship = c.getJSONArray("shipTos").getJSONObject(0)
        ship.put("shipToAddress", JSONObject.NULL).put("email", JSONObject.NULL).put("mobileNo", JSONObject.NULL)
        c.getJSONArray("fieldMissing").put(JSONObject().put("field", "shipTos[0].mobileNo"))
        c.getJSONObject("fieldSubmitted").put("shipTos", JSONArray().put(JSONObject().put("mobileNo", "091")))
        val f = CustomerDrafts.parse(CustomerDrafts().mergeDownloaded(listOf(c)).json()).saved.single().draft.form
        assertEquals("", f.shipToAddress)
        assertEquals("", f.shipToEmail)
        assertEquals("091", f.shipToMobileNo)
    }

    @Test fun everyDownloadedPageIsStagedIncludingEmptyFilteredPages() {
        val customers = (0 until 27).map { customer("Store $it") }
        val cursors = mutableListOf<String?>()
        val rows = CustomerDraftDownload.load { cursor ->
            cursors += cursor
            when (cursor) {
                null -> JSONObject().put("rows", JSONArray(customers.take(25))).put("nextCursor", "page-two")
                "page-two" -> JSONObject().put("rows", JSONArray()).put("nextCursor", "page-three")
                else -> JSONObject().put("rows", JSONArray(customers.drop(25))).put("nextCursor", JSONObject.NULL)
            }
        }
        assertEquals(listOf(null, "page-two", "page-three"), cursors)
        val holder = CustomerDraftHolder()
        holder.replace(CustomerDrafts().mergeDownloaded(rows))
        assertEquals(27, holder.savedCount)
        holder.restore(holder.customers.json())
        assertEquals(27, holder.savedCount)
        assertThrows(IllegalStateException::class.java) {
            CustomerDraftDownload.load { cursor ->
                if (cursor != null) error("Connection lost")
                JSONObject().put("rows", JSONArray(customers.take(25))).put("nextCursor", "more")
            }
        }
        assertEquals(27, holder.savedCount)
        assertThrows(IllegalStateException::class.java) {
            CustomerDraftDownload.load { JSONObject().put("rows", JSONArray()).put("nextCursor", "repeated") }
        }
        holder.reset()
        assertEquals(0, holder.savedCount)
    }
}
