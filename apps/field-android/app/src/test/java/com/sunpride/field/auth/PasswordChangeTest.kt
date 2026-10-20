package com.sunpride.field.auth

import com.sunpride.field.AppEnvironment
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

class PasswordChangeTest {
    private val server = MockWebServer().apply { start() }
    private val plain = InMemorySessionVault().apply { saveSession("sps_this-phone"); deviceId = "phone" }
    private val sealed = InMemorySealedTokenStore()
    private val memory = SessionMemory()
    private var deletions = 0
    private val vault = LockableSessionVault(plain, sealed, memory) { deletions++ }
    private val auth = AuthClient(AppEnvironment(server.url("/").toString().trimEnd('/')), vault)
    @After fun close() { server.shutdown() }

    private fun prepareAccess() {
        val now = System.currentTimeMillis()
        server.enqueue(MockResponse().setBody(JSONObject().put("version", 2).put("serverTime", now)
            .put("accessToken", "spa_this-phone").put("accessExpiresAt", now + 900000).toString()))
        auth.accessToken()
        assertEquals(AuthClient.REFRESH_PATH, server.takeRequest().path)
    }

    @Test fun validatesRequiredLengthSameAndConfirmationWithoutNetwork() {
        val cases = listOf(Triple("", "different", "different") to PasswordChangeFailure.Kind.CURRENT_REQUIRED,
            Triple("current-one", "short", "short") to PasswordChangeFailure.Kind.TOO_SHORT,
            Triple("current-one", "x".repeat(129), "x".repeat(129)) to PasswordChangeFailure.Kind.TOO_LONG,
            Triple("current-one", "current-one", "current-one") to PasswordChangeFailure.Kind.SAME,
            Triple("current-one", "different", "mismatch") to PasswordChangeFailure.Kind.MISMATCH)
        cases.forEach { (values, expected) ->
            val e = runCatching { auth.changePassword(values.first, values.second, values.third) }.exceptionOrNull()
            assertEquals(expected, (e as PasswordChangeFailure).kind)
        }
        assertEquals(0, server.requestCount)
    }

    @Test fun successUsesCurrentSessionDropsBiometricsAndKeepsDeviceAndSessionAcrossReopen() {
        prepareAccess()
        vault.seal(byteArrayOf(1, 2, 3), "sps_this-phone", vault.epoch)
        val epoch = vault.epoch
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        auth.changePassword("old-fake-password", "new-fake-password", "new-fake-password")
        val request = server.takeRequest()
        assertEquals(PasswordChange.PATH, request.path)
        assertEquals("POST", request.method)
        assertEquals("Bearer spa_this-phone", request.getHeader("Authorization"))
        assertNull(request.getHeader("Cookie"))
        val body = JSONObject(request.body.readUtf8())
        assertEquals(setOf("currentPassword", "newPassword"), body.keys().asSequence().toSet())
        assertEquals("old-fake-password", body.getString("currentPassword"))
        assertEquals("new-fake-password", body.getString("newPassword"))
        assertTrue(vault.epoch > epoch)
        assertFalse(vault.biometricOn)
        assertEquals(1, deletions)
        val reopened = LockableSessionVault(plain, sealed, SessionMemory())
        assertEquals("sps_this-phone", reopened.readSession())
        assertEquals("phone", reopened.deviceId)
        assertFalse(vault.unlock("sps_this-phone", epoch))
    }

    @Test fun errorsAreAllowlistedAndNeverEchoServerTextOrPassword() {
        prepareAccess()
        for ((code, expected) in listOf("wrong_password" to PasswordChangeFailure.Kind.WRONG_CURRENT,
            "weak_password" to PasswordChangeFailure.Kind.TOO_SHORT, "same_password" to PasswordChangeFailure.Kind.SAME,
            "secret-server-detail" to PasswordChangeFailure.Kind.SERVER)) {
            server.enqueue(MockResponse().setResponseCode(422).setBody(JSONObject().put("error",
                JSONObject().put("code", code).put("message", "secret-server-detail")).toString()))
            val e = runCatching { auth.changePassword("old-fake-password", "new-fake-password", "new-fake-password") }.exceptionOrNull()
            assertEquals(expected, (e as PasswordChangeFailure).kind)
            assertFalse(e.toString().contains("secret-server-detail"))
            assertEquals("sps_this-phone", vault.readSession())
        }
    }

    @Test fun failedRequestLeavesBiometricSessionIntact() {
        prepareAccess()
        vault.seal(byteArrayOf(1), "sps_this-phone", vault.epoch)
        server.enqueue(MockResponse().setResponseCode(503).setBody("untrusted"))
        assertTrue(runCatching { auth.changePassword("old-fake-password", "new-fake-password", "new-fake-password") }.isFailure)
        assertTrue(vault.biometricOn)
        assertEquals(0, deletions)
    }
}
