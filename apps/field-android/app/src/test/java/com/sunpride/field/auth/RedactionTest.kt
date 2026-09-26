package com.sunpride.field.auth

import com.sunpride.field.AppEnvironment
import com.sunpride.field.ui.FieldController
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** No password, session token, JWT or server-provided text may surface in errors shown or logged. */
class RedactionTest {
    private val secrets = listOf("fake-password-XYZ", "fake-session-XYZ", "eyJfakeJwt", "Uncaught", "Request ID")

    private fun assertClean(text: String?) {
        if (text == null) return
        secrets.forEach { assertFalse("leaked '$it' in '$text'", text.contains(it)) }
    }

    @Test fun failuresCarryOnlyFixedCopyAndNoCause() {
        AuthFailure.Kind.entries.forEach { kind ->
            val e = AuthFailure(kind)
            assertNull(e.cause)
            assertClean(e.message); assertClean(e.toString()); assertClean(e.stackTraceToString().lineSequence().first())
        }
        val convex = ConvexFunctionError("Device unavailable")
        assertNull(convex.cause)
        assertClean(convex.toString())
    }

    @Test fun realFailurePathsDoNotEchoSecrets() {
        val server = MockWebServer().apply { start() }
        try {
            val origin = "http://localhost:${server.port}"
            val vault = InMemorySessionVault()
            val auth = AuthClient(AppEnvironment(origin, origin), vault)
            server.enqueue(MockResponse().setResponseCode(401).setBody("""{"message":"fake-password-XYZ fake-session-XYZ"}"""))
            val signIn = runCatching { auth.signIn("a@example.test", "fake-password-XYZ") }.exceptionOrNull()!!
            assertClean(signIn.message); assertClean(signIn.toString()); assertClean(FieldController.userMessage(signIn))

            server.enqueue(MockResponse().setResponseCode(200)
                .setBody("""{"token":"fake-session-XYZ invalid"}"""))
            val malformed = runCatching { auth.signIn("a@example.test", "fake-password-XYZ") }.exceptionOrNull()!!
            assertClean(malformed.message); assertClean(malformed.toString())
            assertClean(malformed.stackTraceToString().lineSequence().first())
            assertClean(FieldController.userMessage(malformed))
            assertNull(vault.readSession())

            vault.saveSession("fake-session-XYZ")
            server.enqueue(MockResponse().setResponseCode(500).setBody("fake-session-XYZ eyJfakeJwt"))
            val exchange = runCatching { auth.convexToken() }.exceptionOrNull()!!
            assertClean(exchange.message); assertClean(FieldController.userMessage(exchange))
        } finally { server.shutdown() }
    }

    @Test fun userMessagesForConvexErrorsAreFixed() {
        listOf("Device unavailable", "Device identity mismatch", "Device scope changed", null, "Uncaught eyJfakeJwt")
            .forEach { code ->
                val text = FieldController.userMessage(ConvexFunctionError(code))
                assertClean(text); assertTrue(text.isNotBlank())
            }
        assertClean(FieldController.userMessage(IllegalStateException("fake-session-XYZ")))
    }
}
