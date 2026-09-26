package com.sunpride.field.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import android.content.Context
import com.sunpride.field.storage.EncryptedFieldDatabase
import kotlinx.coroutines.runBlocking
import com.sunpride.field.storage.RoomFieldStore
import com.sunpride.field.storage.StoreScope
import com.sunpride.field.sync.BootstrapClient
import com.sunpride.field.sync.BootstrapFailure
import com.sunpride.field.sync.LiveBootstrapTransport
import com.sunpride.field.sync.BootstrapCodec
import com.sunpride.field.device.RequestSigner
import org.json.JSONObject
import java.util.Base64
import java.time.LocalDate
import java.time.ZoneId
import java.security.MessageDigest
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
    fun today(deviceId: String, signer: DeviceSigner, sync: Boolean): TodayData = TodayData()
    val cachedDeviceId: String? get() = null
}

data class VisitDisplay(val outlet: String, val planned: String, val status: String)
data class TodayData(val visits: List<VisitDisplay> = emptyList(), val lastSynced: Long? = null,
                     val stale: Boolean = true, val warning: String? = null, val updateRequired: Boolean = false)

class LiveFieldBackend(
    environment: AppEnvironment,
    private val vault: SessionVault,
    private val context: Context,
    private val signerLoader: () -> DeviceSigner
) : FieldBackend {
    private val auth = AuthClient(environment, vault)
    private val functions = ConvexFunctions(environment, auth)
    private val syncTransport = LiveBootstrapTransport(environment, auth, functions)
    private val prefs = context.getSharedPreferences("field_cache_index", Context.MODE_PRIVATE)
    private fun sessionKey(): String? = vault.readSession()?.let {
        MessageDigest.getInstance("SHA-256").digest(it.toByteArray(Charsets.UTF_8))
            .joinToString("") { b -> "%02x".format(b.toInt() and 255) }
    }
    private fun subjectFromToken(): String {
        val token = auth.convexToken()
        val claims = JSONObject(String(Base64.getUrlDecoder().decode(token.split('.')[1]), Charsets.UTF_8))
        val issuer = claims.getString("iss")
        val subject = claims.getString("sub")
        check(issuer.startsWith("https://") && subject.isNotBlank())
        return "$issuer|$subject"
    }
    override fun today(deviceId: String, signer: DeviceSigner, sync: Boolean): TodayData {
        val key = sessionKey() ?: return TodayData()
        var subject = prefs.getString("$key.subject", null)
        var fingerprint = prefs.getString("$key.scope", null)
        var warning: String? = null
        var failed = prefs.getBoolean("$key.failed", true)
        val terminal = prefs.getInt("$key.updateVersion", -1) == com.sunpride.field.BuildConfig.VERSION_CODE
        if (sync && !terminal) {
            try {
                val authenticated = subjectFromToken()
                val p = BootstrapClient(syncTransport, signer, deviceId,
                    { fp -> RoomFieldStore(EncryptedFieldDatabase.open(context), StoreScope(authenticated, deviceId, fp)) })
                    .fetch(subject = authenticated)
                subject = authenticated; fingerprint = p.fingerprint
                prefs.edit().putString("$key.subject", subject).putString("$key.scope", fingerprint)
                    .putString("$key.device", deviceId).putLong("$key.synced", p.serverTime)
                    .putBoolean("$key.failed", false).apply()
                failed = false
            } catch (e: Exception) {
                failed = true
                prefs.edit().putBoolean("$key.failed", true).apply()
                warning = when (e) {
                    is BootstrapFailure -> when (e.kind) {
                        BootstrapFailure.Kind.REMOVED -> "Phone removed"
                        BootstrapFailure.Kind.UPDATE_REQUIRED -> "Update required"
                        BootstrapFailure.Kind.UNAUTHORIZED -> "Sign in again"
                        else -> "Sync unavailable — showing saved visits"
                    }
                    else -> "Sync unavailable — showing saved visits"
                }
                if (e is BootstrapFailure && e.kind == BootstrapFailure.Kind.UNAUTHORIZED) {
                    // HTTP gateway returns 401 for failed device authorization, including revocation.
                    // Distinguish it by a fresh authenticated enrollment read when possible.
                    val revoked = runCatching { ConvexDeviceApi(functions).mine(signer.publicKeyBase64)?.status }
                        .getOrNull() in setOf("revoked", "suspended")
                    if (revoked) warning = "Phone removed"
                }
                if (warning == "Update required") prefs.edit()
                    .putInt("$key.updateVersion", com.sunpride.field.BuildConfig.VERSION_CODE).apply()
                if (warning == "Phone removed" ||
                    (e is BootstrapFailure && e.kind == BootstrapFailure.Kind.UNAUTHORIZED)) {
                    runBlocking { EncryptedFieldDatabase.holdExisting(context) }
                }
            }
        }
        if (subject == null || fingerprint == null || prefs.getString("$key.device", null) != deviceId)
            return TodayData(warning = warning ?: if (terminal) "Update required" else null, updateRequired = terminal)
        val db = EncryptedFieldDatabase.open(context)
        try {
            val store = RoomFieldStore(db, StoreScope(subject, deviceId, fingerprint))
            return runBlocking {
                val day = LocalDate.now(ZoneId.of("Asia/Manila")).toString()
                val outlets = store.outlets().associate { it.id to JSONObject(it.json).optString("name", "Outlet") }
                val visits = store.todaysVisits(day).map { row ->
                    val v = JSONObject(row.json)
                    VisitDisplay(outlets[v.optString("outletId")] ?: "Outlet unavailable", "Planned", "Scheduled")
                }
                TodayData(visits, prefs.getLong("$key.synced", 0).takeIf { it > 0 },
                    failed || !store.isLeaseValid(System.currentTimeMillis()),
                    warning ?: if (terminal) "Update required" else null,
                    terminal || warning == "Update required")
            }
        } finally { db.close() }
    }
    override val cachedDeviceId get() = vault.deviceId
    override val isSignedIn get() = auth.isSignedIn
    override fun loadSigner() = signerLoader()
    override fun signIn(email: String, password: String) = auth.signIn(email, password)
    override fun signOut() {
        runBlocking { EncryptedFieldDatabase.holdExisting(context) }
        auth.signOut()
    }
    override fun refreshEnrollment(signer: DeviceSigner): EnrollmentState {
        val state = try {
            Enrollment(ConvexDeviceApi(functions), signer, vault).refresh()
        } catch (e: AuthFailure) {
            if (e.kind == AuthFailure.Kind.SESSION_EXPIRED)
                runBlocking { EncryptedFieldDatabase.holdExisting(context) }
            throw e
        }
        if (state == EnrollmentState.Removed || state == EnrollmentState.Unregistered)
            runBlocking { EncryptedFieldDatabase.holdExisting(context) }
        return state
    }
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
    var today by mutableStateOf(TodayData()); private set
    private var signer: DeviceSigner? = null

    /** On launch: restore a stored session and re-verify the device with the server. */
    fun start(configured: Boolean = true) = scope.launch(ui) {
        runCatching { ensureKey() } // create the device key on first launch; failures surface on refresh
        if (!configured) return@launch
        val signedIn = runCatching { withContext(io) { backend.isSignedIn } }.getOrDefault(false)
        if (signedIn) {
            val cached = runCatching { withContext(io) { backend.cachedDeviceId } }.getOrNull()
            if (cached != null) {
                state = EnrollmentState.Ready(cached)
                loadToday(sync = false)
                today = today.copy(stale = true, warning = "Offline verification pending")
            }
            refresh()
        }
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
            if (state is EnrollmentState.Ready) loadToday(sync = true)
        } catch (e: AuthFailure) {
            if (e.kind == AuthFailure.Kind.SESSION_EXPIRED) state = EnrollmentState.SignedOut
            error = userMessage(e)
        } catch (e: Exception) {
            error = userMessage(e)
        } finally {
            busy = false
        }
    }

    private suspend fun loadToday(sync: Boolean) {
        val ready = state as? EnrollmentState.Ready ?: return
        val loaded = ensureKey()
        today = withContext(io) { backend.today(ready.deviceId, loaded, sync) }
    }
    fun refreshCache() = scope.launch(ui) {
        if (state is EnrollmentState.Ready && !busy) {
            runCatching { loadToday(sync = false) }.onFailure { today = today.copy(stale = true) }
        }
    }
    fun syncNow() = scope.launch(ui) {
        if (busy || state !is EnrollmentState.Ready || today.updateRequired) return@launch
        busy = true
        try { loadToday(sync = true) }
        catch (_: Exception) { today = today.copy(stale = true, warning = "Sync unavailable — showing saved visits") }
        finally { busy = false }
    }
    fun checkAgain() = scope.launch(ui) { refresh() }

    fun signOut() = scope.launch(ui) {
        busy = true
        runCatching { withContext(io) { backend.signOut() } }
        state = EnrollmentState.SignedOut; today = TodayData(); error = null; busy = false
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
