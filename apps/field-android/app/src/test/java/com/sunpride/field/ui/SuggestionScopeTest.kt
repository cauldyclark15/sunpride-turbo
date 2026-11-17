package com.sunpride.field.ui

import com.sunpride.field.storage.StoreScope
import org.junit.Assert.*
import org.junit.Test

/** SP-0196: one scope tracker per process, shared by the app's backend and every background sync's backend. */
class SuggestionScopeTest {
    @Test fun aBackgroundSyncOnTheSameScopeDoesNotRetireTheLifetime() {
        SuggestionScope.forget()
        val a = StoreScope("v2:origin|person", "device", "fp-a")
        assertTrue("first look in this process", SuggestionScope.changed(a))
        // A worker builds a fresh LiveFieldBackend and looks at the same verified scope: no retire, so the
        // app does not rebuild the open Add customer form after every sync (it did before SP-0196).
        assertFalse(SuggestionScope.changed(StoreScope("v2:origin|person", "device", "fp-a")))
        assertFalse(SuggestionScope.changed(a))
        // A real scope change (and back) still retires.
        assertTrue(SuggestionScope.changed(a.copy(fingerprint = "fp-b")))
        assertTrue(SuggestionScope.changed(a))
        SuggestionScope.forget()
    }
}
