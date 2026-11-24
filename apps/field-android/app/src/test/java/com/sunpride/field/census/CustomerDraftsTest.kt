package com.sunpride.field.census

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** SP-0241: the real draft book/holder and enrollment validator; phone storage is substituted with a file. */
class CustomerDraftsTest {
    private fun partial(name: String = "Nena Store") = CustomerCapture.Draft(
        CustomerCapture.Form(registeredName = name, mobileNo = "0917", email = "unfinished@",
            sameAsCustomer = false, shipToParty = "Warehouse", customFields = mapOf("cf_sample" to "In progress")), null, null)

    @Test fun missingAndPartlyTypedFieldsCanBeSavedWithoutSubmission() {
        val d = partial()
        assertTrue(CustomerCapture.missing(d.form, null, null, false, false).isNotEmpty())
        val saved = CustomerDrafts.parse(CustomerDrafts().save(d).json())
        assertNull(saved.active)
        assertNull(saved.activeId)
        assertEquals(d.form, saved.saved.single().draft.form)
        assertEquals("Nena Store", saved.saved.single().name)
        assertNull(saved.saved.single().draft.fix)
        assertNull(saved.saved.single().draft.photo)
        // There is no capture/outbox payload in a draft book.
        val json = JSONObject(saved.json()!!)
        assertFalse(json.has("captureId")); assertFalse(json.has("payload"))
    }

    @Test fun multipleDraftsReopenAndEditsReplaceOnlyTheSelectedDraft() {
        val book = CustomerDrafts().save(partial("One")).save(partial("Two"))
        val reloaded = CustomerDrafts.parse(book.json())
        val id = reloaded.saved.first().id
        val open = reloaded.open(id)
        val edited = open.active!!.copy(form = open.active.form.copy(street1 = "New Street", mobileNo = "09175550101"))
        val saved = CustomerDrafts.parse(open.keep(edited).save(edited).json())
        assertEquals(2, saved.saved.size)
        assertEquals(setOf(id, reloaded.saved.last().id), saved.saved.map { it.id }.toSet())
        assertEquals("New Street", saved.open(id).active!!.form.street1)
        assertEquals(partial("Two").form, saved.saved.single { it.id != id }.draft.form)
    }

    @Test fun appRestartRestoresTheOpenDraftAndAllOfItsEvidence() {
        val d = partial().copy(fix = JSONObject().put("latitude", 10.3).put("longitude", 123.9),
            photo = byteArrayOf(-1, -40, 1, 2, -1, -39))
        val saved = CustomerDrafts().save(d)
        val open = saved.open(saved.saved.single().id)
        val updated = d.copy(form = d.form.copy(contactPerson = "Nena", shipToEmail = "delivery@example.ph",
            details = mapOf("distributorCode" to "Sample", "creditLimit" to "100.25")))
        val holder = CustomerDraftHolder()
        holder.restore(open.keep(updated).json())
        assertTrue(holder.loaded)
        assertEquals(open.activeId, holder.customers.activeId)
        assertEquals(updated.form, holder.draft!!.form)
        assertEquals(updated.fix.toString(), holder.draft!!.fix.toString())
        assertArrayEquals(updated.photo, holder.draft!!.photo)
    }

    @Test fun oldSingleDraftIsPreservedAlongsideNewSavedDrafts() {
        val holder = CustomerDraftHolder()
        holder.restore(CustomerCapture.draftJson(partial()))
        assertEquals(partial().form, holder.draft!!.form)
        assertTrue(holder.customers.saved.isEmpty())
        val next = holder.customers.save(holder.draft!!).save(partial("Second"))
        assertEquals(2, CustomerDrafts.parse(next.json()).saved.size)
    }

    @Test fun discardOrSuccessfulSubmissionClearsOnlyTheOpenDraft() {
        val book = CustomerDrafts().save(partial("One")).save(partial("Two"))
        val holder = CustomerDraftHolder()
        holder.restore(book.open(book.saved.first().id).json())
        holder.clear()
        assertNull(holder.draft)
        assertEquals(listOf("Two"), CustomerDrafts.parse(holder.customers.json()).saved.map { it.name })
    }

    @Test fun aNameAloneAndAnExplicitlySavedEmptyDraftBothSurviveRestart() {
        val onlyName = CustomerCapture.Draft(CustomerCapture.Form(customerName = "Owner"), null, null)
        assertFalse(onlyName.isEmpty())
        assertEquals("Owner", CustomerDrafts.parse(CustomerDrafts().keep(onlyName).json()).active!!.form.customerName)
        val empty = CustomerCapture.Draft(CustomerCapture.Form(), null, null)
        val saved = CustomerDrafts().save(empty)
        assertEquals("Unnamed customer", saved.saved.single().name)
        val reopened = CustomerDrafts.parse(saved.open(saved.saved.single().id).json())
        assertNotNull(reopened.active)
        assertNotNull(reopened.activeId)
    }

    @Test fun openingAnotherDraftCannotReplaceUnfinishedWork() {
        val saved = CustomerDrafts().save(partial())
        val working = saved.keep(partial("Unsaved new customer"))
        assertThrows(IllegalStateException::class.java) { working.open(saved.saved.single().id) }
        assertEquals("Unsaved new customer", working.active!!.form.registeredName)
    }

    @Test fun corruptSavedDataDoesNotMarkTheHolderLoadedOrOverwriteItsContents() {
        val holder = CustomerDraftHolder()
        holder.restore(CustomerDrafts().save(partial()).json())
        val original = holder.customers.json()
        assertThrows(Exception::class.java) { holder.restore("{\"version\":2,\"saved\":[{}]}") }
        assertEquals(original, holder.customers.json())
        val fresh = CustomerDraftHolder()
        assertThrows(Exception::class.java) { fresh.restore("broken") }
        assertFalse(fresh.loaded)
    }

    @Test fun anOlderAutoSaveCannotResurrectAnArchivedOrSubmittedDraft() {
        val holder = CustomerDraftHolder()
        holder.keep(partial())
        val oldJson = holder.customers.json(); val older = holder.ticket()
        val archived = holder.customers.save(holder.draft!!)
        var disk: String? = null
        assertTrue(holder.persist(holder.ticket()) { disk = archived.json() })
        holder.replace(archived)
        assertFalse(holder.persist(older) { disk = oldJson })
        assertNull(CustomerDrafts.parse(disk).active)
        assertEquals(1, CustomerDrafts.parse(disk).saved.size)
    }

    @Test fun signOutRetiresPendingPhoneWrites() {
        val holder = CustomerDraftHolder()
        holder.keep(partial())
        val ticket = holder.ticket()
        holder.reset()
        var wrote = false
        assertFalse(holder.persist(ticket) { wrote = true })
        assertFalse(wrote)
        assertTrue(holder.persist(holder.ticket()) { wrote = true })
        assertTrue(wrote)
    }

    @Test fun failedPhoneWriteKeepsTheFormAndCanBeRetried() {
        val holder = CustomerDraftHolder()
        holder.keep(partial())
        val next = holder.customers.save(holder.draft!!)
        val ticket = holder.ticket()
        assertThrows(IllegalStateException::class.java) { holder.persist(ticket) { error("disk unavailable") } }
        assertEquals(partial().form, holder.draft!!.form)
        assertTrue(holder.customers.saved.isEmpty())
        var stored: String? = null
        assertTrue(holder.persist(ticket) { stored = next.json() })
        holder.replace(next)
        assertEquals(1, CustomerDrafts.parse(stored).saved.size)
    }

    @Test fun savedDraftsRoundTripThroughARealFileAndSignOutClearsOnlyMemory() {
        val folder = File(System.getenv("TMPDIR") ?: System.getProperty("java.io.tmpdir"))
        val file = File.createTempFile("sp241-drafts-", ".json", folder)
        try {
            val holder = CustomerDraftHolder()
            val next = holder.customers.save(partial("One")).save(partial("Two"))
            holder.persist(holder.ticket()) { file.writeText(next.json()!!) }
            holder.replace(next); holder.reset()
            assertNull(holder.draft); assertTrue(holder.customers.saved.isEmpty()); assertFalse(holder.loaded)
            val restarted = CustomerDraftHolder()
            restarted.restore(file.readText())
            assertEquals(listOf("One", "Two"), restarted.customers.saved.map { it.name })
        } finally { file.delete() }
    }
}
