package com.sunpride.field.census

import org.junit.Assert.*
import org.junit.Test

/** SP-0196: the open Add customer form survives its screen being rebuilt, and an older phone copy never wins. */
class CustomerDraftHolderTest {
    private val full = CustomerCapture.Draft(CustomerCapture.Form(registeredName = "Aling Nena Sari-Sari Store", customerName = "Nena Reyes",
        mobileNo = "09171234567", regionCode = "0700000000", provinceCode = "0702200000", municipalityCode = "0730600000",
        barangayCode = "0730600003", houseNo = "123", street1 = "Rizal Street", postalCode = "6000", contactPerson = "Nena Reyes",
        details = mapOf("taxClassificationCode" to "1", "salesOfficeCode" to "100")), null, byteArrayOf(1, 2, 3))

    /** The phone copy as the background writes leave it (last completed write wins, like the real store). */
    private class Phone { var json: String? = null; fun write(d: CustomerCapture.Draft?) { json = d?.let(CustomerCapture::draftJson) } }

    @Test fun aRebuiltScreenStartsFromEveryFieldAndThePhoto() {
        val holder = CustomerDraftHolder()
        assertFalse(holder.loaded)
        holder.keep(full) // the screen keeps each change at once
        // The screen is thrown away (camera, Back, the app re-keying its pages) and built again: it reads the holder.
        val rebuilt = holder.draft!!
        assertTrue(holder.loaded)
        assertEquals(full.form, rebuilt.form); assertArrayEquals(full.photo, rebuilt.photo)
    }

    @Test fun anOlderCopyFinishingAfterSaveNeverBringsTheSavedCustomerBack() {
        // Seen on the phone: a background write of the filled form finished after Save cleared the copy, and the
        // saved customer came back as "your unsaved customer was kept".
        val holder = CustomerDraftHolder(); val phone = Phone()
        holder.keep(full); val filled = holder.ticket() // debounced write took its snapshot...
        holder.clear(); val save = holder.ticket()       // ...then Save
        assertTrue(holder.persist(save) { phone.write(null) })
        assertFalse(holder.persist(filled) { phone.write(full) }) // finishes late: skipped
        assertNull(phone.json); assertNull(holder.draft); assertTrue(holder.loaded)
    }

    @Test fun anOlderSnapshotNeverReplacesANewerOne() {
        val holder = CustomerDraftHolder(); val phone = Phone()
        val older = holder.ticket(); val partial = full.copy(form = full.form.copy(registeredName = "", customerName = "", mobileNo = ""))
        val newer = holder.ticket()
        assertTrue(holder.persist(newer) { phone.write(full) })
        assertFalse(holder.persist(older) { phone.write(partial) })
        assertEquals(full.form, CustomerCapture.parseDraft(phone.json)!!.form)
    }

    @Test fun signOutForgetsTheForm() {
        val holder = CustomerDraftHolder()
        holder.keep(full); holder.savedNotice = SAVED_ONLINE
        holder.reset()
        assertNull(holder.draft); assertFalse(holder.loaded); assertNull(holder.savedNotice)
    }

    @Test fun savedWordingSaysCustomer() {
        assertEquals("Customer saved. Sent to the office for approval.", SAVED_ONLINE)
        assertEquals("Saved. It will send when you have signal.", SAVED_OFFLINE)
        assertFalse(DRAFT_KEPT.contains("store"))
    }
}
