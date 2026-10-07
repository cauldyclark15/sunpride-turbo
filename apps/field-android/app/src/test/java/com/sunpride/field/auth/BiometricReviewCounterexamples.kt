package com.sunpride.field.auth


import com.sunpride.field.ui.BiometricGate
import org.junit.Assert.*
import org.junit.Test

/** Release-check probes, verbatim: production Gate/Vault; scripted asynchronous BiometricCrypto, no hardware or network. */
class BiometricReviewCounterexamples {
    private class HoldingCrypto : BiometricCrypto {
        var hold = false
        var completion: (() -> Unit)? = null
        override fun availability() = BiometricAvailability.AVAILABLE
        override fun encrypt(plain: ByteArray, done: (CryptoOutcome) -> Unit) {
            val blob = ByteArray(12) + plain.reversedArray()
            if (hold) completion = { done(CryptoOutcome.Done(blob)) }
            else done(CryptoOutcome.Done(blob))
        }
        override fun decrypt(sealed: ByteArray, done: (CryptoOutcome) -> Unit) {
            val opened = sealed.copyOfRange(12, sealed.size).reversedArray()
            if (hold) completion = { done(CryptoOutcome.Done(opened)) }
            else done(CryptoOutcome.Done(opened))
        }
        override fun deleteKey() = Unit
    }
    private fun prepared(): Triple<InMemorySessionVault, InMemorySealedTokenStore, HoldingCrypto> {
        val plain = InMemorySessionVault()
        val sealed = InMemorySealedTokenStore()
        val crypto = HoldingCrypto()
        val vault = LockableSessionVault(plain, sealed, SessionMemory())
        vault.saveSession("session-account-A")
        BiometricGate(vault, crypto).enable()
        return Triple(plain, sealed, crypto)
    }

    @Test fun oldUnlockMustNotReplaceNewPasswordSession() {
        val (plain, sealed, crypto) = prepared()
        val vault = LockableSessionVault(plain, sealed, SessionMemory())
        val gate = BiometricGate(vault, crypto)
        crypto.hold = true
        gate.unlock()
        gate.usePassword()
        vault.saveSession("session-account-B")
        gate.passwordSignedIn()
        crypto.completion!!.invoke()
        println("late unlock after password replacement: ${vault.readSession()}")
        assertEquals("session-account-B", vault.readSession())
    }

    @Test fun oldUnlockMustNotUndoLocalSignOut() {
        val (plain, sealed, crypto) = prepared()
        val vault = LockableSessionVault(plain, sealed, SessionMemory())
        val gate = BiometricGate(vault, crypto)
        crypto.hold = true
        gate.unlock()
        gate.usePassword()
        vault.wipe()
        gate.signedOut()
        crypto.completion!!.invoke()
        println("late unlock after local wipe: token=${vault.readSession()}, sealed=${vault.biometricOn}, step=${gate.step}")
        assertNull(vault.readSession())
    }

    @Test fun oldEnableMustNotPersistThePreviousAccountAfterSessionReplacement() {
        val plain = InMemorySessionVault()
        val sealed = InMemorySealedTokenStore()
        val crypto = HoldingCrypto()
        val vault = LockableSessionVault(plain, sealed, SessionMemory())
        vault.saveSession("session-account-A")
        val gate = BiometricGate(vault, crypto)
        crypto.hold = true
        gate.enable()
        vault.saveSession("session-account-B")
        gate.passwordSignedIn()
        crypto.completion!!.invoke()
        val coldVault = LockableSessionVault(plain, sealed, SessionMemory())
        crypto.hold = false
        BiometricGate(coldVault, crypto).unlock()
        println("old enable after password replacement, cold unlock: ${coldVault.readSession()}")
        assertEquals("session-account-B", coldVault.readSession())
    }

    /** Models disk deletion failing silently, as ignored SharedPreferences.commit(false) does after cold start. */
    @Test fun retainedOrdinarySessionMustNotBypassEnabledBiometricsOnColdStart() {
        val oldDisk = object : SessionVault {
            var token: String? = null
            override var deviceId: String? = "device"
            override fun readSession() = token
            override fun saveSession(token: String) { this.token = token }
            override fun wipe() { token = null }
            override fun clearSession() = Unit // failed durable remove, without throwing
        }
        val sealed = InMemorySealedTokenStore()
        val crypto = HoldingCrypto()
        val vault = LockableSessionVault(oldDisk, sealed, SessionMemory())
        vault.saveSession("session-account-A")
        val gate = BiometricGate(vault, crypto)
        gate.enable()
        val coldVault = LockableSessionVault(oldDisk, sealed, SessionMemory())
        val coldGate = BiometricGate(coldVault, crypto)
        println("failed ordinary removal: enabled=${gate.enabled}, cold step=${coldGate.step}, cold token=${coldVault.readSession()}")
        assertTrue(coldVault.isLocked)
    }
}
