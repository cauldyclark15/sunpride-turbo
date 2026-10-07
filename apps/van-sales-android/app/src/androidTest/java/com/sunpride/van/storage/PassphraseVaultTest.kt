package com.sunpride.van.storage

import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.security.KeyStore
import java.util.UUID

class PassphraseVaultTest {
    @Test fun randomWrappedPassphraseSurvivesRestartAndMissingWrapperFailsClosed() = runBlocking {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val tag=UUID.randomUUID().toString(); val name="van-vault-test-$tag.db"; val prefs="van-vault-test-$tag"; val alias="van-vault-test-$tag"
        try {
            val first=PassphraseVault(context,name,prefs,alias).passphrase(); assertEquals(64,first.size)
            assertArrayEquals(first,PassphraseVault(context,name,prefs,alias).passphrase())
            val raw=context.getSharedPreferences(prefs,0).getString("wrapped.v1",null)!!
            assertFalse(raw.contains(String(first)))
            EncryptedVanDatabase.openWithPassphrase(context,first,name).close()
            context.getSharedPreferences(prefs,0).edit().clear().commit()
            assertTrue(runCatching { PassphraseVault(context,name,prefs,alias).passphrase() }.isFailure)
        } finally { context.deleteDatabase(name); context.getSharedPreferences(prefs,0).edit().clear().commit(); KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(alias) }; Unit
    }
}
