package com.sunpride.field.auth

import android.content.Context
import androidx.core.content.edit
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.KeyStore

@RunWith(AndroidJUnit4::class)
class KeystoreSessionVaultTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val prefs = "field_secure_session_test"
    private val alias = "sunpride-field-session-aes-test"
    private val fakeToken = "fake-session-token-for-instrumentation-only"

    @After fun cleanUp() {
        KeystoreSessionVault(context, prefs, alias).wipe()
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(alias)
    }

    @Test fun roundTripsAcrossInstancesAndIsNotPlaintextOnDisk() {
        KeystoreSessionVault(context, prefs, alias).apply { saveSession(fakeToken); deviceId = "dev1" }
        val reopened = KeystoreSessionVault(context, prefs, alias)
        assertEquals(fakeToken, reopened.readSession())
        assertEquals("dev1", reopened.deviceId)
        val stored = reopened.rawStoredValue()
        assertNotNull(stored)
        assertFalse(stored!!.contains(fakeToken))
        val xml = File(context.applicationInfo.dataDir, "shared_prefs/$prefs.xml").readText()
        assertFalse("token bytes must not be on disk", xml.contains(fakeToken))
    }

    @Test fun wipeRemovesSessionAndDeviceId() {
        val vault = KeystoreSessionVault(context, prefs, alias)
        vault.saveSession(fakeToken); vault.deviceId = "dev1"
        vault.wipe()
        assertNull(vault.readSession()); assertNull(vault.deviceId)
        assertNull(KeystoreSessionVault(context, prefs, alias).readSession())
    }

    @Test fun tamperedCiphertextIsDiscarded() {
        val vault = KeystoreSessionVault(context, prefs, alias)
        vault.saveSession(fakeToken)
        val raw = vault.rawStoredValue()!!
        val flipped = (if (raw[20] == 'A') 'B' else 'A').let { raw.substring(0, 20) + it + raw.substring(21) }
        context.getSharedPreferences(prefs, Context.MODE_PRIVATE).edit(commit = true) { putString("session.v1", flipped) }
        assertNull(vault.readSession())
        assertNull(vault.rawStoredValue())
    }

    @Test fun lostKeystoreKeyMeansSignedOut() {
        KeystoreSessionVault(context, prefs, alias).saveSession(fakeToken)
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(alias)
        assertNull(KeystoreSessionVault(context, prefs, alias).readSession())
    }
}
