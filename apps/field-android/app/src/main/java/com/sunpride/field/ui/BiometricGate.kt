package com.sunpride.field.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.sunpride.field.auth.BiometricAvailability
import com.sunpride.field.auth.BiometricCrypto
import com.sunpride.field.auth.CryptoOutcome
import com.sunpride.field.auth.LockableSessionVault

/**
 * SP-0128 launch gate and settings for fingerprint/face sign-in. State is Compose state written on the
 * main thread (prompt callbacks arrive there). The field app's data, held work and sync rules are untouched:
 * the gate only decides whether the stored session is opened before [FieldController.start] runs.
 */
class BiometricGate(private val vault: LockableSessionVault, private val crypto: BiometricCrypto) {
    enum class Step {
        /** No sealed session, or it is unlocked: the app runs as before. */
        OPEN,
        /** Sealed session waiting for the system prompt. */
        LOCKED,
        /** Prompt cancelled/failed: the password screen, optionally with "Use fingerprint or face" again. */
        PASSWORD,
    }

    var step by mutableStateOf(if (vault.isLocked) Step.LOCKED else Step.OPEN); private set
    var message by mutableStateOf<String?>(null); private set
    /** Offer shown once after a password sign-in on a phone with a strong biometric enrolled. */
    var offer by mutableStateOf(false); private set
    var enabled by mutableStateOf(vault.biometricOn); private set
    var busy by mutableStateOf(false); private set
    /** Bumps on every successful unlock so the app (re)starts with the opened session. */
    var unlocks by mutableIntStateOf(0); private set

    /**
     * Generation of the prompt in flight. A callback whose generation is no longer current (password
     * sign-in, sign-out, turning it off, a newer prompt) is ignored; the vault also refuses it when the
     * stored session changed since the prompt started ([LockableSessionVault.epoch]).
     */
    private var request = 0L

    private fun retirePending() { request += 1; busy = false }

    fun availability(): BiometricAvailability = runCatching { crypto.availability() }.getOrDefault(BiometricAvailability.UNAVAILABLE)

    /** The password screen may offer the prompt again while the sealed session still exists. */
    val canRetry: Boolean get() = step == Step.PASSWORD && enabled

    /** Shows the system prompt to open the sealed session. */
    fun unlock() {
        if (busy) return
        val sealed = vault.sealedToken()
        if (sealed == null) { enabled = false; step = Step.OPEN; return }
        busy = true
        val id = ++request
        val startedAt = vault.epoch
        crypto.decrypt(sealed) { outcome ->
            // usePassword() keeps the generation: a late success for the SAME session may still open it.
            if (id != request || vault.epoch != startedAt) {
                (outcome as? CryptoOutcome.Done)?.bytes?.fill(0)
                return@decrypt
            }
            busy = false
            when (outcome) {
                is CryptoOutcome.Done -> {
                    val opened = runCatching { vault.unlock(String(outcome.bytes, Charsets.UTF_8), startedAt) }
                    outcome.bytes.fill(0)
                    when (opened.getOrNull()) {
                        true -> { message = null; step = Step.OPEN; unlocks += 1 }
                        false -> Unit // session changed while the prompt was up: stale, ignore
                        null -> invalidated()
                    }
                }
                CryptoOutcome.Cancelled -> { message = null; step = Step.PASSWORD }
                CryptoOutcome.Invalidated -> invalidated()
                CryptoOutcome.LockedOut -> { message = LOCKED_OUT; step = Step.PASSWORD }
                CryptoOutcome.Failed -> { message = FAILED; step = Step.PASSWORD }
            }
        }
    }

    private fun invalidated() {
        runCatching { vault.dropBiometric() }
        runCatching { crypto.deleteKey() }
        enabled = false
        message = INVALIDATED
        step = Step.PASSWORD
    }

    /**
     * From the lock screen. Always allowed: if a prompt vanished without reporting back (the system dismissed
     * it), the person must never be stuck behind it. A late success still unlocks; anything else is ignored.
     */
    fun usePassword() { busy = false; message = null; if (step == Step.LOCKED) step = Step.PASSWORD }

    /** A password sign-in succeeded (the vault already dropped any old sealed session). */
    fun passwordSignedIn() {
        retirePending()
        enabled = vault.biometricOn
        message = null
        step = Step.OPEN
        offer = !enabled && availability() == BiometricAvailability.AVAILABLE
    }

    /** "Turn on": prompt once, then seal the current session under the biometric key. */
    fun enable() {
        if (busy) return
        offer = false
        val token = vault.readSession() ?: return
        busy = true
        val id = ++request
        val startedAt = vault.epoch
        val bytes = token.toByteArray(Charsets.UTF_8)
        crypto.encrypt(bytes) { outcome ->
            bytes.fill(0)
            // Stale: the session changed (other account, sign-out) since the prompt opened. Never seal it,
            // and never delete the key: it may already belong to the newer session.
            if (id != request || vault.epoch != startedAt) return@encrypt
            busy = false
            when (outcome) {
                is CryptoOutcome.Done -> when (runCatching { vault.seal(outcome.bytes, token, startedAt) }.getOrNull()) {
                    true -> { enabled = true; message = null }
                    false -> Unit
                    null -> { runCatching { crypto.deleteKey() }; enabled = vault.biometricOn; message = ENABLE_FAILED }
                }
                CryptoOutcome.Cancelled -> message = null
                else -> { runCatching { crypto.deleteKey() }; message = ENABLE_FAILED }
            }
        }
    }

    fun decline() { offer = false }

    /** Account toggle off: the session returns to the ordinary Keystore copy; the biometric key is deleted. */
    fun disable() {
        if (busy) return
        retirePending()
        if (runCatching { vault.unseal() }.isFailure) { enabled = vault.biometricOn; message = DISABLE_FAILED; return }
        runCatching { crypto.deleteKey() }
        enabled = false
        message = null
    }

    /** Sign-out (the vault wipe already removed the sealed session and key) or session expiry. */
    fun signedOut() {
        retirePending()
        offer = false
        message = null
        enabled = vault.biometricOn
        if (step == Step.PASSWORD && !enabled) step = Step.OPEN
    }

    companion object {
        const val INVALIDATED = "Fingerprints or face on this phone changed. Sign in with your password, " +
            "then turn fingerprint sign-in on again in Account."
        const val LOCKED_OUT = "Too many tries. Sign in with your password."
        const val FAILED = "Couldn't use fingerprint or face. Sign in with your password."
        const val ENABLE_FAILED = "Couldn't turn on fingerprint sign-in. Try again from Account."
        const val DISABLE_FAILED = "Couldn't turn off fingerprint sign-in. Try again."
    }
}
