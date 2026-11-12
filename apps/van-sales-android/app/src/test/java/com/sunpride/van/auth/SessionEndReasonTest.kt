package com.sunpride.van.auth

import com.sunpride.van.AppEnvironment
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** FLD-014/FLD-171 (van): an ended session says why; a revoked phone is named plainly. Fake tokens only. */
class SessionEndReasonTest {
    private lateinit var server: MockWebServer
    private lateinit var env: AppEnvironment
    @Before fun setup() { server = MockWebServer().apply { start() }; env = AppEnvironment("http://localhost:${server.port}") }
    @After fun close() { server.shutdown() }

    private fun refuse(body: String): Pair<AuthFailure, InMemorySessionVault> {
        val vault = InMemorySessionVault().apply { saveSession("fake-session") }
        server.enqueue(MockResponse().setResponseCode(401).setBody(body))
        val e = try { AuthClient(env, vault).accessToken(); null } catch (f: AuthFailure) { f }
        return e!! to vault
    }

    @Test fun `FLD-014 revoked phone refresh says the office removed it`() {
        val (e, vault) = refuse("""{"error":{"code":"device_revoked"}}""")
        assertEquals(AuthFailure.Kind.SESSION_EXPIRED, e.kind)
        assertTrue(e.removed)
        assertTrue(e.text.startsWith("This phone was removed by the office"))
        assertEquals(e.text, com.sunpride.van.ui.UserMessages.forFailure(e))
        assertNull(vault.readSession())
    }

    @Test fun `FLD-171 a plain ended session keeps the session-ended words`() {
        val (e, _) = refuse("""{"error":{"code":"session_invalid"}}""")
        assertFalse(e.removed)
        assertEquals("Your session has ended. Sign in again.", com.sunpride.van.ui.UserMessages.forFailure(e))
    }
}
