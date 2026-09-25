package com.sunpride.field.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.sunpride.field.AppEnvironment
import com.sunpride.field.auth.AuthClient
import com.sunpride.field.auth.AuthFailure
import com.sunpride.field.auth.ConvexDeviceApi
import com.sunpride.field.auth.ConvexFunctionError
import com.sunpride.field.auth.ConvexFunctions
import com.sunpride.field.auth.Enrollment
import com.sunpride.field.auth.EnrollmentState
import com.sunpride.field.auth.SessionVault
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.fingerprint
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.coroutines.CoroutineContext

/** Everything the screen needs from the network/Keystore; blocking calls, run on [FieldController.io]. */
interface FieldBackend {
    val isSignedIn: Boolean
    fun loadSigner(): DeviceSigner
    fun signIn(email: String, password: String)
    fun signOut()
    fun refreshEnrollment(signer: DeviceSigner): EnrollmentState
}

class LiveFieldBackend(
    environment: AppEnvironment,
    private val vault: SessionVault,
    private val signerLoader: () -> DeviceSigner
) : FieldBackend {
    private val auth = AuthClient(environment, vault)
    private val functions = ConvexFunctions(environment, auth)
    override val isSignedIn get() = auth.isSignedIn
    override fun loadSigner() = signerLoader()
    override fun signIn(email: String, password: String) = auth.signIn(email, password)
    override fun signOut() { auth.signOut() }
    override fun refreshEnrollment(signer: DeviceSigner) =
        Enrollment(ConvexDeviceApi(functions), signer, vault).refresh()
}

/** Non-secret key facts shown on the enrollment screen and in diagnostics. */
data class DeviceKeyInfo(val publicKey: String, val fingerprint: String, val protection: String)

class FieldController(
    private val backend: FieldBackend,
    private val scope: CoroutineScope,
    val io: CoroutineDispatcher = Dispatchers.IO,
    /** Compose state is only written here (main thread in the app; tests may pass EmptyCoroutineContext). */
    private val ui: CoroutineContext = Dispatchers.Main.immediate,
    private val onKeyLoaded: (DeviceKeyInfo) -> Unit = {}
) {
    var state by mutableStateOf<EnrollmentState>(EnrollmentState.SignedOut); private set
    var busy by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null); private set
    var key by mutableStateOf<DeviceKeyInfo?>(null); private set
    private var signer: DeviceSigner? = null

    /** On launch: restore a stored session and re-verify the device with the server. */
    fun start(configured: Boolean = true) = scope.launch(ui) {
        runCatching { ensureKey() } // create the device key on first launch; failures surface on refresh
        if (!configured) return@launch
        val signedIn = runCatching { withContext(io) { backend.isSignedIn } }.getOrDefault(false)
        if (signedIn) refresh()
    }

    private suspend fun ensureKey(): DeviceSigner = signer ?: withContext(io) { backend.loadSigner() }.also { s ->
        signer = s
        val info = DeviceKeyInfo(s.publicKeyBase64, fingerprint(s.publicKeySpki), s.protection.label)
        key = info
        runCatching { withContext(io) { onKeyLoaded(info) } }
    }

    fun signIn(email: String, password: String) = scope.launch(ui) {
        busy = true; error = null
        try {
            withContext(io) { backend.signIn(email, password) }
            state = EnrollmentState.Unregistered // signed in; device status not yet known
        } catch (e: Exception) {
            error = userMessage(e)
            busy = false
            return@launch
        }
        busy = false
        refresh()
    }

    /** `mine` lookup (+ bind when registered but unbound). [quiet] polls keep the current message. */
    suspend fun refresh(quiet: Boolean = false): Unit = withContext(ui) { refreshOnUi(quiet) }

    private suspend fun refreshOnUi(quiet: Boolean) {
        if (busy) return
        busy = true
        if (!quiet) error = null
        try {
            val loaded = ensureKey()
            state = withContext(io) { backend.refreshEnrollment(loaded) }
            error = null
        } catch (e: AuthFailure) {
            if (e.kind == AuthFailure.Kind.SESSION_EXPIRED) state = EnrollmentState.SignedOut
            error = userMessage(e)
        } catch (e: Exception) {
            error = userMessage(e)
        } finally {
            busy = false
        }
    }

    fun checkAgain() = scope.launch(ui) { refresh() }

    fun signOut() = scope.launch(ui) {
        busy = true
        runCatching { withContext(io) { backend.signOut() } }
        state = EnrollmentState.SignedOut; error = null; busy = false
    }

    companion object {
        /** Fixed copy only — server text, URLs and credentials never reach the screen. */
        fun userMessage(e: Throwable): String = when (e) {
            is AuthFailure -> e.kind.message
            is ConvexFunctionError -> when (e.code) {
                "Device identity mismatch" -> "This phone is registered to a different account. Ask your administrator."
                "Device scope changed", "Device scope unavailable" ->
                    "Your assignment changed. Ask your administrator to re-register this phone."
                "Device unavailable" -> "This phone isn't available for your account. Ask your administrator."
                else -> "Couldn't verify this phone. Try again."
            }
            else -> "Something went wrong. Try again."
        }
    }
}
