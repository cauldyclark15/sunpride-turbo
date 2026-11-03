package com.sunpride.field.chat

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** SP-0147: the Messages page shows one top bar (the chat's own), never the app's bar above it. */
class FieldChatChromeTest {
    @Test fun `the app bar steps aside on Messages only`() {
        assertFalse(FieldChat.appBarVisible(ready = true, page = "messages"))
        assertTrue(FieldChat.appBarVisible(ready = true, page = "home"))
        assertTrue(FieldChat.appBarVisible(ready = true, page = "account"))
        // Before the day is ready the Messages page is not drawn, so the bar stays.
        assertTrue(FieldChat.appBarVisible(ready = false, page = "messages"))
    }
}
