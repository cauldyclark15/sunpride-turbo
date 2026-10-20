package com.sunpride.van.auth

import com.sunpride.van.AppEnvironment
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

class PasswordChangeTest {
    private fun signedInClient(server: MockWebServer, vault: SessionVault): AuthClient {
        val auth=AuthClient(AppEnvironment("http://localhost:${server.port}"),vault)
        val now=System.currentTimeMillis()
        server.enqueue(MockResponse().setBody(JSONObject().put("version",2).put("accessToken","spa_test_access")
            .put("serverTime",now).put("accessExpiresAt",now+900000).toString()))
        auth.accessToken(); server.takeRequest(1,TimeUnit.SECONDS)
        return auth
    }
    @Test fun validatesWithoutTrimmingOrSavingPasswords() {
        assertEquals(PasswordProblem.CURRENT_REQUIRED,PasswordChange.problem("","abcdefgh","abcdefgh"))
        assertEquals(PasswordProblem.WEAK,PasswordChange.problem("old","short","short"))
        assertEquals(PasswordProblem.SAME,PasswordChange.problem("abcdefgh","abcdefgh","abcdefgh"))
        assertEquals(PasswordProblem.MISMATCH,PasswordChange.problem("old","abcdefgh","different"))
        assertEquals(PasswordProblem.WEAK,PasswordChange.problem("old","a".repeat(129),"a".repeat(129)))
        assertNull(PasswordChange.problem("old"," abcdef "," abcdef "))
    }
    @Test fun postsCurrentAndNewToExactEndpointWithExistingSessionAndKeepsIt() {
        MockWebServer().use { server ->
            server.start(); val vault = InMemorySessionVault().apply { saveSession("test-session"); deviceId = "test-device" }
            val auth = signedInClient(server,vault)
            server.enqueue(MockResponse().setBody("{\"ok\":true}"))
            auth.changePassword("old-password","new-password","new-password")
            val request = server.takeRequest(1,TimeUnit.SECONDS)!!
            assertEquals("/api/auth/change-password",request.path); assertEquals("POST",request.method)
            assertEquals("Bearer spa_test_access",request.getHeader("Authorization")); assertNull(request.getHeader("Cookie"))
            val body = JSONObject(request.body.readUtf8())
            assertEquals(setOf("currentPassword","newPassword"),body.keys().asSequence().toSet())
            assertEquals("old-password",body.getString("currentPassword")); assertEquals("new-password",body.getString("newPassword"))
            assertEquals("test-session",vault.readSession()); assertEquals("test-device",vault.deviceId)
        }
    }
    @Test fun errorsAreAllowlistedAndNeverShowRawServerTextOrChangeSession() {
        MockWebServer().use { server ->
            server.start(); val vault = InMemorySessionVault().apply { saveSession("test-session") }
            val auth = signedInClient(server,vault)
            for ((status,code,expected) in listOf(Triple(422,"wrong_password",PasswordProblem.WRONG),
                Triple(422,"weak_password",PasswordProblem.WEAK),Triple(422,"same_password",PasswordProblem.SAME),
                Triple(401,"unauthorized",PasswordProblem.SESSION),Triple(429,"rate_limited",PasswordProblem.RATE_LIMITED),
                Triple(500,"private-secret",PasswordProblem.SERVER))) {
                server.enqueue(MockResponse().setResponseCode(status).setBody("""{"error":{"code":"$code","message":"private-secret"}}"""))
                try { auth.changePassword("old-password","new-password","new-password"); fail() }
                catch (e: PasswordChangeFailure) { assertEquals(expected,e.problem); assertFalse(e.message!!.contains("private-secret")) }
                assertEquals("test-session",vault.readSession())
            }
            server.enqueue(MockResponse().setBody("not-json"))
            try { auth.changePassword("old-password","new-password","new-password"); fail() }
            catch (e: PasswordChangeFailure) { assertEquals(PasswordProblem.SERVER,e.problem) }
        }
    }
    @Test fun invalidDraftNeverMakesANetworkRequest() {
        MockWebServer().use { server ->
            server.start(); val vault = InMemorySessionVault().apply { saveSession("test-session") }
            val auth = AuthClient(AppEnvironment("http://localhost:${server.port}"),vault)
            try { auth.changePassword("old-password","new-password","mismatch"); fail() }
            catch (e: PasswordChangeFailure) { assertEquals(PasswordProblem.MISMATCH,e.problem) }
            assertEquals(0,server.requestCount)
        }
    }
}
