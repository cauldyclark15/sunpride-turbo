package com.sunpride.van.ui

import com.sunpride.van.auth.AuthFailure
import com.sunpride.van.auth.NativeApiFailure
import com.sunpride.van.sync.VanSyncFailure
import org.junit.Assert.*
import org.junit.Test

/** IP-P0 (SPEC 8.4): the catalogue maps codes and known texts to plain sentences and never echoes anything else. */
class UserMessagesTest {
    @Test fun section84TableByCode() {
        assertEquals("Stock moved on this line while you counted. It will be rechecked automatically.",UserMessages.forCode("stale_snapshot"))
        assertEquals("Too many batches on one line. Split this line in two.",UserMessages.forCode("too_many_lots"))
        assertEquals("Case size not set for this product. Enter pieces.",UserMessages.forCode("base"))
        assertEquals("Settings changed in the office. Tap Sync.",UserMessages.forCode("config_outdated"))
        assertEquals("This handheld is not set up for you. Ask your supervisor to hand it over.",UserMessages.forCode("device_not_set_up_for_you"))
        assertNull(UserMessages.forCode("some_new_code")); assertNull(UserMessages.forCode(null))
    }
    @Test fun section84TableByOldText() {
        assertEquals(UserMessages.STALE_COUNT,UserMessages.forText("Start a new count"))
        assertEquals(UserMessages.TOO_MANY_LOTS,UserMessages.forText("This movement needs more than 50 lots; split the document"))
        assertEquals(UserMessages.SETTINGS_CHANGED,UserMessages.forText("Download the register's current configuration"))
        assertEquals(UserMessages.LOAD_DIFFERENCE_SENT,UserMessages.forText("Waiting for supervisor approval"))
        assertEquals(UserMessages.NOT_SET_UP,UserMessages.forText("Phone removed"))
        assertNull(UserMessages.forText("totally unknown")); assertNull(UserMessages.forText(null))
    }
    @Test fun loadDifferenceNamesTheSupervisorWhenKnown() {
        assertEquals("Load difference sent to Juan Dela Cruz. You will be told here when it is decided.",UserMessages.loadDifferenceSent("Juan Dela Cruz"))
        assertEquals(UserMessages.LOAD_DIFFERENCE_SENT,UserMessages.loadDifferenceSent(null))
        assertEquals(UserMessages.LOAD_DIFFERENCE_SENT,UserMessages.loadDifferenceSent(" "))
    }
    @Test fun phoneRemovedGetsTheCallButton() {
        assertTrue(UserMessages.needsCall(UserMessages.forFailure(NativeApiFailure("device_revoked",403))))
        assertTrue(UserMessages.needsCall(UserMessages.forFailure(IllegalStateException("Phone removed"))))
        assertFalse(UserMessages.needsCall(UserMessages.forFailure(NativeApiFailure("rate_limited",429))))
    }
    @Test fun recountAskedShowsTheOfficeReason() {
        assertEquals("Office asked for a recount: Recount the second pallet",UserMessages.recountAsked("  Recount the second pallet "))
        assertEquals("Office asked for a recount.",UserMessages.recountAsked(null))
        assertEquals("Office asked for a recount.",UserMessages.recountAsked("  "))
    }
    @Test fun failuresMapByTypeAndNeverEchoRawText() {
        assertEquals("Incorrect email or password.",UserMessages.forFailure(AuthFailure(AuthFailure.Kind.INVALID_CREDENTIALS)))
        assertEquals("Could not reach the office. Your work is kept here. Try again.",UserMessages.forFailure(VanSyncFailure("temporarily_unavailable",true)))
        assertEquals("Couldn't verify this phone. Try again.",UserMessages.forFailure(NativeApiFailure("brand_new",400)))
        val secret = RuntimeException("https://sunpride.example.test/api?token=abc stale 500 SQLiteException")
        assertEquals(UserMessages.DEFAULT,UserMessages.forFailure(secret))
        assertEquals("fallback",UserMessages.forFailure(secret,"fallback",passLocal = true))
        assertEquals(UserMessages.STALE_COUNT,UserMessages.forFailure(IllegalStateException("stale_snapshot: Start a new count")))
    }
    @Test fun localChecksPassOnlyWhenTheyAreShortPlainSentences() {
        assertEquals("A fresh precise location is required.",UserMessages.forFailure(IllegalStateException("A fresh precise location is required."),"x",passLocal = true))
        assertEquals("x",UserMessages.forFailure(IllegalStateException("A fresh precise location is required."),"x"))
        assertEquals("x",UserMessages.forFailure(IllegalStateException("bad_state_code happened"),"x",passLocal = true))
        assertEquals("x",UserMessages.forFailure(IllegalStateException("see https://x.test/y"),"x",passLocal = true))
        assertEquals("x",UserMessages.forFailure(IllegalStateException("id 3f2b8c1a-1111-4222-8333-444455556666 refused"),"x",passLocal = true))
        assertEquals("x",UserMessages.forFailure(IllegalStateException("a".repeat(200)),"x",passLocal = true))
        assertEquals("x",UserMessages.forFailure(java.io.IOException("Connection reset"),"x",passLocal = true))
    }
    @Test fun onlyTheCatchAllSentenceCountsAsGeneric() {
        assertTrue(UserMessages.isGeneric(UserMessages.DEFAULT))
        assertFalse(UserMessages.isGeneric(UserMessages.STALE_COUNT))
        assertFalse(UserMessages.isGeneric(null))
    }

    // Beta.28 device: a refused store sale showed the catch-all "Could not save this change" and hid the real reason.
    @Test fun everyStoreSaleRefusalIsAClearCashierSentenceNotTheCatchAll() {
        val refusals = listOf(
            "Review the refused store sale before recording more", "Open a cashier session first", "Cart identifier has different content",
            "A senior, PWD or other statutory discount cannot be combined with the employee discount or points", "Prices or discount changed",
            "Choose how the customer pays", "Each payment must be more than zero", "Tenders must equal the total", "Tender is not enabled",
            "Enter the provider reference", "Use the approval reference, never a card number", "Cash received is short",
            "Look up the customer before redeeming points", "Not enough available points",
            "Download an authorized document range before selling", "Document range belongs to another handheld", "Fiscal authorization expired",
            "Document range exhausted; sync before issuing again", "Z closing has stopped sales for this day", "Discounts exceed this basket", "Loyalty is off",
            "Supervisor PIN was not accepted", "Failed requirement.",
        )
        refusals.forEach { text ->
            listOf<Throwable>(IllegalStateException(text), IllegalArgumentException(text)).forEach { e ->
                val sentence = UserMessages.forStoreSale(e)
                assertNotEquals(text, UserMessages.DEFAULT, sentence)
                assertNotEquals(text, UserMessages.STORE_SALE_DEFAULT, sentence)
                assertTrue(text, UserMessages.isPlainSentence(sentence))
            }
        }
        assertEquals("Prices or the discount changed while you were paying. Go Back, check the total and pay again.", UserMessages.forStoreSale(IllegalStateException("Prices or discount changed")))
        assertEquals("This till has no receipt numbers yet. Tap Sync. If it stays, ask the office to give this handheld a receipt range.", UserMessages.forStoreSale(IllegalStateException("Download an authorized document range before selling")))
    }
    @Test fun unknownStoreSaleFailuresStayPlainAndNeverEchoRawText() {
        assertEquals(UserMessages.STORE_SALE_DEFAULT, UserMessages.forStoreSale(org.json.JSONException("No value for taxBasisPoints")))
        assertEquals(UserMessages.STORE_SALE_DEFAULT, UserMessages.forStoreSale(RuntimeException("boom")))
        assertEquals(UserMessages.STORE_SALE_DEFAULT, UserMessages.forStoreSale(IllegalStateException("java.lang.IllegalStateException at com.x.Y {id}")))
        assertEquals("Sold out of mangoes", UserMessages.forStoreSale(IllegalStateException("Sold out of mangoes")))
    }
}
