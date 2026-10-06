package com.sunpride.field.auth

/**
 * SP-0128 fingerprint/face sign-in. The password is never stored. When the person turns biometric
 * sign-in on, the Better Auth session token is re-sealed under a Keystore key that needs a strong
 * biometric (or the phone's screen lock on Android 11+) for every use, and the ordinary copy is removed.
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

/** Where the biometric-sealed blob lives (ciphertext only). */
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

/** The unlocked session for this process only; gone when the process dies. */
class SessionMemory {
    @Volatile var token: String? = null
    companion object { val process = SessionMemory() }
}

/**
 * The app's [SessionVault]: reads the unlocked in-memory session first, else the ordinary Keystore copy
 * (biometric sign-in off). Background workers in a process where the person has not unlocked see no
 * session and do nothing (they never wipe or hold data for it); the next unlocked launch schedules them.
 */
class LockableSessionVault(
    private val plain: SessionVault,
    private val sealed: SealedTokenStore,
    private val memory: SessionMemory = SessionMemory.process,
    private val deleteKey: () -> Unit = {},
) : SessionVault {
    override fun readSession(): String? = memory.token ?: plain.readSession()

    /** A password sign-in replaces any session; biometric sign-in stays off until offered again. */
    @Synchronized override fun saveSession(token: String) {
        dropBiometric()
        runCatching { deleteKey() }
        plain.saveSession(token)
    }

    override var deviceId: String?
        get() = plain.deviceId
        set(value) { plain.deviceId = value }

    /** Sign-out / dead session: unlocked token, sealed token, biometric key and the ordinary copy. */
    @Synchronized override fun wipe() {
        memory.token = null
        runCatching { sealed.clear() }
        runCatching { deleteKey() }
        plain.wipe()
    }

    @Synchronized override fun clearSession() {
        memory.token = null
        runCatching { sealed.clear() }
        plain.clearSession()
    }

    val biometricOn: Boolean get() = sealed.read() != null

    /** A sealed session exists and nothing has unlocked it in this process. */
    val isLocked: Boolean get() = memory.token == null && sealed.read() != null && plain.readSession() == null

    fun sealedToken(): ByteArray? = sealed.read()

    /** The prompt opened the sealed session: keep it in memory only. */
    @Synchronized fun unlock(token: String) {
        require(token.isNotBlank() && token.length <= AuthClient.MAX_SESSION_TOKEN_LENGTH)
        memory.token = token
    }

    /** Biometric sign-in on: [blob] (sealed current session) replaces the ordinary copy. */
    @Synchronized fun seal(blob: ByteArray) {
        val token = readSession() ?: throw AuthFailure(AuthFailure.Kind.SESSION_EXPIRED)
        sealed.write(blob)
        memory.token = token
        plain.clearSession()
    }

    /** Biometric sign-in off: the session goes back to the ordinary Keystore copy (no prompt needed). */
    @Synchronized fun unseal() {
        val token = readSession()
        if (token != null) plain.saveSession(token)
        sealed.clear()
        memory.token = null
    }

    /** Sealed session can no longer be opened (key invalidated): forget it; sign in with the password. */
    @Synchronized fun dropBiometric() {
        sealed.clear()
        memory.token = null
    }
}
