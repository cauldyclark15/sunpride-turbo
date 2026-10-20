package com.sunpride.field.auth

import com.sunpride.field.AppEnvironment
import com.sunpride.integrity.CompanySignInClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CompanySignInTest {
    @Test fun F007_companySessionIsValidatedBeforeReplacingTheVault() {
        val vault=InMemorySessionVault()
        val now=1_780_000_000_000L
        val auth=AuthClient(AppEnvironment("https://sample.example.test"),vault,clock={now})
        val tokens=JSONObject().put("version",2).put("status","signed_in").put("serverTime",now)
            .put("sessionToken","sps_sample_session").put("accessToken","spa_sample_access")
            .put("sessionExpiresAt",now+604800000).put("accessExpiresAt",now+900000)
        auth.acceptCompanySession(tokens)
        assertEquals("sps_sample_session",vault.readSession()); assertEquals("spa_sample_access",auth.accessToken())
        try { auth.acceptCompanySession(JSONObject(tokens.toString()).put("accessToken","broken token")); fail("invalid token") } catch(_: AuthFailure) { }
        assertEquals("sps_sample_session",vault.readSession())
    }
    @Test fun F007_sharedClientDiscoversProvidersAndSignsPollingWithoutCookiesOrPasswords() {
        MockWebServer().use { server ->
            server.start()
            val origin=server.url("/").toString().trimEnd('/')
            val messages=mutableListOf<String>()
            val client=CompanySignInClient(origin,"field-android",{JSONObject().put("keyId","sample-key").put("publicKeySpki","sample-spki")},{messages.add(it); "sample-signature"})
            server.enqueue(MockResponse().setBody("""{"providers":[{"code":"sample","label":"SAMPLE Company"}]}"""))
            assertEquals("SAMPLE Company",client.providers().single().label)
            server.takeRequest()
            server.enqueue(MockResponse().setHeader("Set-Cookie","ignored=secret").setBody("""{"requestId":"sample-request","pollSecret":"sample-poll","authorizationUrl":"$origin/api/auth/oidc/start?native=sample"}"""))
            val request=client.start("sample")
            val start=server.takeRequest(); assertNull(start.getHeader("Cookie")); assertFalse(start.body.readUtf8().contains("password"))
            server.enqueue(MockResponse().setBody("""{"status":"waiting"}""")); assertNull(client.poll(request))
            val poll=server.takeRequest(); assertNull(poll.getHeader("Cookie")); assertEquals(listOf("SSO|sample-request|sample-poll"),messages)
            server.enqueue(MockResponse().setBody("""{"status":"signed_in","sessionToken":"sample"}"""))
            assertEquals("signed_in",client.poll(request)!!.getString("status"))
        }
    }
}
