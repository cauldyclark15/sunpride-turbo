package com.sunpride.van.auth

import com.sunpride.van.AppEnvironment
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CompanySignInTest {
    @Test fun F007_companySessionUsesExistingVaultAndRejectsInvalidCredentials() {
        val vault=InMemorySessionVault()
        val now=1_780_000_000_000L
        val auth=AuthClient(AppEnvironment("https://sample.example.test"),vault,clock={now})
        val tokens=JSONObject().put("version",2).put("status","signed_in").put("serverTime",now)
            .put("sessionToken","sps_sample_session").put("accessToken","spa_sample_access")
            .put("sessionExpiresAt",now+604800000).put("accessExpiresAt",now+900000)
        auth.acceptCompanySession(tokens)
        assertEquals("sps_sample_session",vault.readSession()); assertEquals("spa_sample_access",auth.accessToken())
        try { auth.acceptCompanySession(JSONObject(tokens.toString()).put("sessionToken","wrong-prefix")); fail("invalid token") } catch(_: AuthFailure) { }
        assertEquals("sps_sample_session",vault.readSession())
    }
}
