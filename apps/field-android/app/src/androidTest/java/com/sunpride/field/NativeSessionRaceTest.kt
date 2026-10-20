package com.sunpride.field

import android.content.Context
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.field.auth.SessionVault
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.JcaDeviceSigner
import com.sunpride.field.device.KeyProtection
import com.sunpride.field.ui.LiveFieldBackend
import org.junit.Assert.assertEquals
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.util.UUID

/** Real encrypted-store reader while session teardown removes the cache-index authorization. No HTTP/fake rows. */
class NativeSessionRaceTest {
    private fun race(read: (LiveFieldBackend, DeviceSigner) -> String?) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val token = "sps_test-only-${UUID.randomUUID()}"
        val key = MessageDigest.getInstance("SHA-256").digest(token.toByteArray())
            .joinToString("") { "%02x".format(it.toInt() and 255) }
        val prefs = context.getSharedPreferences("field_v2_cache_index", Context.MODE_PRIVATE)
        prefs.edit().putString("$key.subject", "test-race-$key").putString("$key.device", "test-race-device")
            .putString("$key.scope", "test-race-scope").commit()
        val vault = object : SessionVault {
            var reads = 0
            override fun readSession(): String? = if (++reads == 1) token else null
            override fun saveSession(token: String) = Unit
            override var deviceId: String? = "test-race-device"
            override fun wipe() = Unit
            override fun clearSession() = Unit
        }
        val pair = KeyPairGenerator.getInstance("EC").apply { initialize(256) }.generateKeyPair()
        val signer = JcaDeviceSigner(pair.private, pair.public, KeyProtection.SOFTWARE)
        val backend = LiveFieldBackend(AppEnvironment("http://127.0.0.1:1"), vault, context) { signer }
        try { assertEquals("Sign in again", read(backend, signer)?.substringBefore(" to")) }
        finally { prefs.edit().remove("$key.subject").remove("$key.device").remove("$key.scope").commit() }
    }
    @Test fun cachedTodayDoesNotCrashWhenSignOutRemovesTheProjectionScope() = race { backend, signer ->
        backend.today("test-race-device", signer, sync = false).sales.message
    }
    @Test fun teamDoesNotCrashWhenSignOutRemovesTheProjectionScope() = race { backend, _ ->
        backend.team(true).message
    }
}
