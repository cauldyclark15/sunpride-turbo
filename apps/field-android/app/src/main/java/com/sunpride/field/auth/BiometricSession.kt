package com.sunpride.field.auth

/**
 * SP-0128 fingerprint/face sign-in. The password is never stored. When the person turns biometric
 * sign-in on, the Better Auth session token is re-sealed under a Keystore key that needs a strong
 * biometric (never the screen lock, so new enrollments invalidate it) for every use, and the ordinary copy is removed.
 * At launch the system prompt unlocks it into this process's memory only; server calls still exchange
 * that session for a short-lived Convex JWT exactly as before.
 */
enum class BiometricAvailability { AVAILABLE, NOT_ENROLLED, UNAVAILABLE }

/** Result of one system-prompt + cipher round. Never carries prompt error text. */
sealed interface CryptoOutcome {
    class Done(val bytes: ByteArray) : CryptoOutcome
    /** Person closed the prompt or chose "Use password". */
    data object Cancelled : CryptoOutcome
    /** Key gone or invalidated (new fingerprint/face enrolled, screen lock removed). */
    data object Invalidated : CryptoOutcome
    /** Too many failed attempts; the sensor is locked for now. */
    data object LockedOut : CryptoOutcome
    data object Failed : CryptoOutcome
}

/** The system prompt + biometric-bound key. Callbacks run on the main thread. */
interface BiometricCrypto {
    fun availability(): BiometricAvailability
    /** Prompts, then returns IV + ciphertext of [plain]. */
    fun encrypt(plain: ByteArray, done: (CryptoOutcome) -> Unit)
    /** Prompts, then returns the plaintext of a blob made by [encrypt]. */
    fun decrypt(sealed: ByteArray, done: (CryptoOutcome) -> Unit)
    fun deleteKey()
}

/** Where the biometric-sealed blob lives (ciphertext only). Writes and clears throw when not durably saved. */
interface SealedTokenStore {
    fun read(): ByteArray?
    fun write(blob: ByteArray)
    fun clear()
}

class InMemorySealedTokenStore : SealedTokenStore {
    @Volatile private var blob: ByteArray? = null
    override fun read() = blob?.copyOf()
    override fun write(blob: ByteArray) { this.blob = blob.copyOf() }
    override fun clear() { blob = null }
}

/** Local storage refused a write/remove. Fixed message; no stored value ever enters it. */
class SessionStorageFailure : IllegalStateException("Couldn't save sign-in on this phone. Try again.")

/**
 * The unlocked session for this process only; gone when the process dies. [epoch] changes whenever the
 * stored session changes (password sign-in, sign-out, biometric on/off), so a prompt callback that
 * started before the change can tell it is stale and must not touch the session. Shared by every vault
 * instance in the process (activity and background workers).
 */
class SessionMemory {
    @Volatile var token: String? = null
    @Volatile var epoch: Long = 0L
        private set
    internal fun bump() { epoch += 1 }
    companion object { val process = SessionMemory() }
}

/**
 * The app's [SessionVault]: reads the unlocked in-memory session first, else the ordinary Keystore copy
 * (biometric sign-in off). While a sealed session exists the ordinary copy is NEVER used, even if its
 * removal failed: that copy cannot bypass the prompt. Background workers in a process where the person
 * has not unlocked see no session and do nothing (they never wipe or hold data for it); the next
 * unlocked launch schedules them.
 */
class LockableSessionVault(
    private val plain: SessionVault,
    private val sealed: SealedTokenStore,
    private val memory: SessionMemory = SessionMemory.process,
    private val deleteKey: () -> Unit = {},
) : SessionVault {
    override fun readSession(): String? = memory.token ?: if (sealed.read() != null) null else plain.readSession()

    /** Changes whenever the stored session changes; see [SessionMemory.epoch]. */
    val epoch: Long get() = memory.epoch

    /**
     * A password sign-in replaces any session; biometric sign-in stays off until offered again. The old
     * sealed session must be gone first, or it would keep hiding the new ordinary copy.
     */
    override fun saveSession(token: String) = synchronized(memory) {
        memory.bump()
        memory.token = null
        sealed.clear()
        if (sealed.read() != null) throw SessionStorageFailure()
        runCatching { deleteKey() }
        plain.saveSession(token)
    }

    override var deviceId: String?
        get() = plain.deviceId
        set(value) { plain.deviceId = value }

    /**
     * Sign-out / dead session: unlocked token, sealed token, biometric key and the ordinary copy. Every
     * step runs even if an earlier one fails; the first storage failure is rethrown afterwards.
     */
    override fun wipe() = synchronized(memory) {
        memory.bump()
        memory.token = null
        val sealedCleared = runCatching { sealed.clear() }
        runCatching { deleteKey() }
        val plainWiped = runCatching { plain.wipe() }
        sealedCleared.getOrThrow(); plainWiped.getOrThrow()
    }

    override fun clearSession() = synchronized(memory) {
        memory.bump()
        memory.token = null
        val sealedCleared = runCatching { sealed.clear() }
        plain.clearSession()
        sealedCleared.getOrThrow()
    }

    val biometricOn: Boolean get() = sealed.read() != null

    /** A sealed session exists and nothing has unlocked it in this process. The ordinary copy never counts. */
    val isLocked: Boolean get() = memory.token == null && sealed.read() != null

    fun sealedToken(): ByteArray? = sealed.read()

    /**
     * The prompt opened the sealed session: keep it in memory only. Refused (false) when the session changed
     * since the prompt started at [startedAt] (sign-out, another sign-in) or the sealed session is gone.
     */
    fun unlock(token: String, startedAt: Long): Boolean = synchronized(memory) {
        require(token.isNotBlank() && token.length <= AuthClient.MAX_SESSION_TOKEN_LENGTH)
        if (memory.epoch != startedAt || sealed.read() == null) return false
        memory.token = token
        true
    }

    /**
     * Biometric sign-in on: [blob] (the sealed form of [token]) replaces the ordinary copy. Refused (false)
     * when the session changed since the prompt started at [startedAt]. The sealed copy is written durably
     * before the ordinary copy is removed; if that removal fails, the sealed copy still wins on every read.
     */
    fun seal(blob: ByteArray, token: String, startedAt: Long): Boolean = synchronized(memory) {
        if (memory.epoch != startedAt || readSession() != token) return false
        sealed.write(blob)
        if (sealed.read()?.contentEquals(blob) != true) { runCatching { sealed.clear() }; throw SessionStorageFailure() }
        memory.bump()
        memory.token = token
        runCatching { plain.clearSession() }
        true
    }

    /**
     * Biometric sign-in off: the session goes back to the ordinary Keystore copy (no prompt needed). The
     * ordinary copy is saved before the sealed one is removed, so a failure leaves the person signed in.
     */
    fun unseal() = synchronized(memory) {
        val token = readSession()
        if (token != null) plain.saveSession(token)
        sealed.clear()
        memory.bump()
        memory.token = null
    }

    /** Sealed session can no longer be opened (key invalidated): forget it; sign in with the password. */
    fun dropBiometric() = synchronized(memory) {
        memory.bump()
        memory.token = null
        sealed.clear()
    }
}
