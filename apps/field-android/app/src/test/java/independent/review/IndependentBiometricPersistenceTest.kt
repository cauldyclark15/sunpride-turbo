package independent.review

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import com.sunpride.field.AppEnvironment
import com.sunpride.field.auth.*
import com.sunpride.field.ui.BiometricGate
import java.lang.reflect.Proxy
import java.security.Key
import java.security.KeyStoreSpi
import java.security.Provider
import java.security.Security
import java.security.cert.Certificate
import java.util.Collections
import java.util.Date
import java.util.UUID
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.*
import org.junit.Test
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer

/** Real production gate/vault, KeystoreSessionVault AES-GCM/preferences, and PrefsSealedTokenStore;
 * auth HTTP uses localhost. BiometricCrypto and the AndroidKeyStore provider are replaced.
 * Failure model: durable data remains readable when a write fails. Each preference file fails
 * independently. Never contacts a deployment or touches a phone. */
class IndependentBiometricPersistenceTest {
    private class Disk {
        val values = linkedMapOf<String, String>()
        var reject = false
        var rejectedWrites = 0
        val prefs: SharedPreferences = Proxy.newProxyInstance(SharedPreferences::class.java.classLoader,
            arrayOf(SharedPreferences::class.java)) { _, method, args ->
            when (method.name) {
                "getString" -> values[args!![0]] ?: args[1]
                "contains" -> values.containsKey(args!![0])
                "getAll" -> values.toMap()
                "edit" -> editor()
                "registerOnSharedPreferenceChangeListener", "unregisterOnSharedPreferenceChangeListener" -> null
                else -> error("unused preference method ${method.name}")
            }
        } as SharedPreferences
        private fun editor(): SharedPreferences.Editor {
            val puts = linkedMapOf<String, String?>()
            var clear = false
            return Proxy.newProxyInstance(SharedPreferences.Editor::class.java.classLoader,
                arrayOf(SharedPreferences.Editor::class.java)) { self, method, args ->
                when (method.name) {
                    "putString" -> { puts[args!![0] as String] = args[1] as String?; self }
                    "remove" -> { puts[args!![0] as String] = null; self }
                    "clear" -> { clear = true; self }
                    "commit" -> {
                        if (reject) { rejectedWrites++; false } else {
                            if (clear) values.clear()
                            puts.forEach { (k, v) -> if (v == null) values.remove(k) else values[k] = v }
                            true
                        }
                    }
                    else -> error("unused editor method ${method.name}")
                }
            } as SharedPreferences.Editor
        }
    }
    private class FakeContext(private val disk: Disk) : ContextWrapper(null) {
        override fun getApplicationContext(): Context = this
        override fun getSharedPreferences(name: String, mode: Int): SharedPreferences = disk.prefs
    }
    /** Test-only AndroidKeyStore provider. Keys are seeded before construction so the production
     * key-generation branch is not used. All production AES-GCM and preference bodies run unchanged. */
    class ReviewKeyStore : KeyStoreSpi() {
        companion object { val keys = linkedMapOf<String, Key>() }
        override fun engineGetKey(alias: String, password: CharArray?) = keys[alias]
        override fun engineGetCertificateChain(alias: String): Array<Certificate>? = null
        override fun engineGetCertificate(alias: String): Certificate? = null
        override fun engineGetCreationDate(alias: String) = Date(0)
        override fun engineSetKeyEntry(alias: String, key: Key, password: CharArray?, chain: Array<Certificate>?) { keys[alias] = key }
        override fun engineSetKeyEntry(alias: String, key: ByteArray, chain: Array<Certificate>?) { error("unused") }
        override fun engineSetCertificateEntry(alias: String, cert: Certificate) { error("unused") }
        override fun engineDeleteEntry(alias: String) { keys.remove(alias) }
        override fun engineAliases() = Collections.enumeration(keys.keys)
        override fun engineContainsAlias(alias: String) = keys.containsKey(alias)
        override fun engineSize() = keys.size
        override fun engineIsKeyEntry(alias: String) = keys.containsKey(alias)
        override fun engineIsCertificateEntry(alias: String) = false
        override fun engineGetCertificateAlias(cert: Certificate): String? = null
        override fun engineStore(stream: java.io.OutputStream?, password: CharArray?) = Unit
        override fun engineLoad(stream: java.io.InputStream?, password: CharArray?) = Unit
    }
    class ReviewProvider : Provider("IndependentReviewKeyStore", 1.0, "JVM key boundary only") {
        init { put("KeyStore.AndroidKeyStore", ReviewKeyStore::class.java.name) }
    }
    private class Crypto : BiometricCrypto {
        var held: (() -> Unit)? = null
        var hold = false
        var invalidated = false
        var deletes = 0
        override fun availability() = BiometricAvailability.AVAILABLE
        private fun deliver(result: CryptoOutcome, done: (CryptoOutcome) -> Unit) {
            if (hold) held = { done(result) } else done(result)
        }
        override fun encrypt(plain: ByteArray, done: (CryptoOutcome) -> Unit) =
            deliver(CryptoOutcome.Done(byteArrayOf(42) + plain), done)
        override fun decrypt(sealed: ByteArray, done: (CryptoOutcome) -> Unit) =
            deliver(if (invalidated) CryptoOutcome.Invalidated else CryptoOutcome.Done(sealed.drop(1).toByteArray()), done)
        override fun deleteKey() { deletes++ }
    }
    private class Rig {
        val ordinaryDisk = Disk()
        val sealedDisk = Disk()
        val alias = "review-${UUID.randomUUID()}"
        init {
            Security.addProvider(ReviewProvider())
            ReviewKeyStore.keys[alias] = SecretKeySpec(ByteArray(32) { it.toByte() }, "AES")
        }
        val plain = KeystoreSessionVault(FakeContext(ordinaryDisk), "ordinary-review", alias)
        val sealed = PrefsSealedTokenStore(FakeContext(sealedDisk))
        val memory = SessionMemory()
        val crypto = Crypto()
        val vault = LockableSessionVault(plain, sealed, memory) { crypto.deleteKey() }
        val gate = BiometricGate(vault, crypto)
        fun signInA() { vault.saveSession("session-account-A"); gate.passwordSignedIn() }
        fun enable() { signInA(); gate.enable(); assertTrue(gate.enabled) }
        fun cold(): Pair<LockableSessionVault, BiometricGate> {
            val coldPlain = KeystoreSessionVault(FakeContext(ordinaryDisk), "ordinary-review", alias)
            val v = LockableSessionVault(coldPlain, PrefsSealedTokenStore(FakeContext(sealedDisk)), SessionMemory())
            return v to BiometricGate(v, crypto)
        }
    }

    @Test fun ordinaryRemoveFailureAloneDoesNotBypassAnExistingSealedMarker() {
        val r = Rig(); r.signInA(); r.ordinaryDisk.reject = true; r.gate.enable()
        assertTrue(r.ordinaryDisk.rejectedWrites > 0)
        assertEquals("session-account-A", r.plain.readSession())
        val (cold, gate) = r.cold()
        println("retain ordinary / sealed present: step=${gate.step}, token=${cold.readSession()}")
        assertNull(cold.readSession()); assertEquals(BiometricGate.Step.LOCKED, gate.step)
    }

    @Test fun invalidationMustNotResurrectAnOrdinaryCopyWhoseRemovalFailed() {
        val r = Rig(); r.signInA(); r.ordinaryDisk.reject = true; r.gate.enable()
        val (cold, gate) = r.cold(); r.crypto.invalidated = true; gate.unlock()
        val (reopened, reopenedGate) = r.cold()
        println("retain ordinary / invalidated: gate=${gate.step}, message=${gate.message}, current=${cold.readSession()}, cold=${reopenedGate.step}, coldToken=${reopened.readSession()}")
        assertNull("invalidated biometric must require password, never ordinary fallback", reopened.readSession())
    }

    @Test fun failedOrdinaryWipeMustNotReopenAfterProductionAuthSignOut() {
        val r = Rig(); r.signInA(); r.ordinaryDisk.reject = true; r.gate.enable()
        val auth = AuthClient(AppEnvironment("", ""), r.vault)
        assertTrue(runCatching { auth.signOut() }.exceptionOrNull() is SessionStorageFailure)
        r.gate.signedOut()
        val (cold, gate) = r.cold()
        println("sign-out / ordinary wipe failed only: step=${gate.step}, current=${r.vault.readSession()}, cold=${cold.readSession()}, sealed=${r.sealed.read() != null}")
        assertNull("sign-out must not reopen the kept ordinary session", cold.readSession())
    }

    @Test fun sealedWriteFailureIsCheckedIndependentlyAndEnableFails() {
        val r = Rig(); r.signInA(); r.sealedDisk.reject = true; r.gate.enable()
        assertTrue(r.sealedDisk.rejectedWrites > 0)
        assertFalse(r.gate.enabled); assertEquals(BiometricGate.ENABLE_FAILED, r.gate.message)
        assertEquals("session-account-A", r.plain.readSession())
    }

    @Test fun sealedClearFailureRejectsReplacementPasswordSession() {
        val r = Rig(); r.enable(); r.sealedDisk.reject = true
        assertTrue(runCatching { r.vault.saveSession("session-account-B") }.exceptionOrNull() is SessionStorageFailure)
        assertNull(r.vault.readSession()); assertTrue(r.vault.isLocked)
        assertNull(r.plain.readSession())
    }

    @Test fun ordinarySaveFailureCannotSuccessfullyDisableBiometrics() {
        val r = Rig(); r.enable(); r.ordinaryDisk.reject = true; r.gate.disable()
        assertTrue(r.gate.enabled); assertEquals(BiometricGate.DISABLE_FAILED, r.gate.message)
        val (cold, gate) = r.cold(); assertNull(cold.readSession()); assertEquals(BiometricGate.Step.LOCKED, gate.step)
    }

    @Test fun delayedUnlockCannotUndoSuccessfulDisable() {
        val r = Rig(); r.enable(); val (cold, gate) = r.cold()
        r.crypto.hold = true; gate.unlock(); gate.usePassword(); gate.disable(); r.crypto.held!!.invoke()
        assertNull(cold.readSession()); assertFalse(cold.biometricOn); assertEquals(0, gate.unlocks)
    }

    @Test fun delayedEnableCannotUndoSuccessfulDisable() {
        val r = Rig(); r.signInA(); r.crypto.hold = true; r.gate.enable()
        // Independent vault instance simulates the shared storage transition; gate itself is busy,
        // and the real Account switch is intentionally disabled until prompt returns.
        r.vault.unseal(); r.crypto.held!!.invoke()
        assertFalse(r.vault.biometricOn); assertEquals("session-account-A", r.vault.readSession())
    }

    @Test fun delayedUnlockCannotUndoProductionAuthSignOut() {
        val r = Rig(); r.enable(); val (cold, gate) = r.cold()
        r.crypto.hold = true; gate.unlock()
        AuthClient(AppEnvironment("", ""), cold).signOut()
        gate.signedOut(); r.crypto.held!!.invoke()
        assertNull(cold.readSession()); assertEquals(0, gate.unlocks)
    }

    @Test fun delayedUnlockCannotUndoProductionPasswordReplacement() {
        val r = Rig(); r.enable(); val (cold, gate) = r.cold()
        r.crypto.hold = true; gate.unlock(); gate.usePassword()
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("{\"token\":\"session-account-B\"}")); server.start()
            val env = AppEnvironment(server.url("/").toString(), "http://localhost:${server.port}")
            AuthClient(env, cold).signIn("b@example.invalid", "test-fixture-only")
            gate.passwordSignedIn(); r.crypto.held!!.invoke()
            assertEquals("session-account-B", cold.readSession()); assertEquals(0, gate.unlocks)
            assertFalse(cold.biometricOn)
        }
    }

    @Test fun delayedEnableCannotUndoProductionAuthSignOut() {
        val r = Rig(); r.signInA(); r.crypto.hold = true; r.gate.enable()
        AuthClient(AppEnvironment("", ""), r.vault).signOut()
        r.gate.signedOut(); r.crypto.held!!.invoke()
        assertNull(r.vault.readSession()); assertFalse(r.vault.biometricOn)
    }

    @Test fun delayedEnableCannotUndoProductionPasswordReplacement() {
        val r = Rig(); r.signInA(); r.crypto.hold = true; r.gate.enable()
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("{\"token\":\"session-account-B\"}")); server.start()
            val env = AppEnvironment(server.url("/").toString(), "http://localhost:${server.port}")
            AuthClient(env, r.vault).signIn("b@example.invalid", "test-fixture-only")
            r.gate.passwordSignedIn(); r.crypto.held!!.invoke()
            assertEquals("session-account-B", r.vault.readSession()); assertFalse(r.vault.biometricOn)
        }
    }
}
