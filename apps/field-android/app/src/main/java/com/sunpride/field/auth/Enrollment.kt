package com.sunpride.field.auth

import com.sunpride.field.device.DeviceSigner
import org.json.JSONObject
import java.util.UUID

/** What the phone knows about its own registration. */
sealed interface EnrollmentState {
    data object SignedOut : EnrollmentState
    data object Unregistered : EnrollmentState
    data class Ready(val deviceId: String) : EnrollmentState
    data object Removed : EnrollmentState
}

/** `mobile/devices:mine` result: `null` or `{deviceId, status, bound, allowedApp}`. */
data class DeviceRecord(val deviceId: String, val status: String, val bound: Boolean, val allowedApp: String)

/** Online device functions (see packages/backend/convex/mobile/devices.ts). */
interface DeviceApi {
    fun mine(publicKey: String): DeviceRecord?
    /** Returns nonce and server expiry (epoch ms). */
    fun challenge(deviceId: String): Pair<String, Long>
    fun bind(deviceId: String, credentialId: String, attestationFormat: String, keyId: String?,
             nonce: String, timestamp: Long, proof: String)
}

class ConvexDeviceApi(private val functions: ConvexFunctions) : DeviceApi {
    override fun mine(publicKey: String): DeviceRecord? {
        val value = functions.query("mobile/devices:mine",
            JSONObject().put("publicKey", publicKey).put("app", APP)) ?: return null
        val record = value as? JSONObject ?: throw AuthFailure(AuthFailure.Kind.SERVER)
        return DeviceRecord(record.getString("deviceId"), record.getString("status"),
            record.getBoolean("bound"), record.getString("allowedApp"))
    }

    override fun challenge(deviceId: String): Pair<String, Long> {
        val value = functions.mutation("mobile/devices:challenge", JSONObject().put("deviceId", deviceId))
            as? JSONObject ?: throw AuthFailure(AuthFailure.Kind.SERVER)
        return value.getString("nonce") to value.getLong("expiresAt")
    }

    override fun bind(deviceId: String, credentialId: String, attestationFormat: String, keyId: String?,
                      nonce: String, timestamp: Long, proof: String) {
        val attestation = JSONObject().put("format", attestationFormat)
        if (keyId != null) attestation.put("keyId", keyId)
        val value = functions.mutation("mobile/devices:bind", JSONObject()
            .put("deviceId", deviceId).put("credentialId", credentialId).put("attestation", attestation)
            .put("nonce", nonce).put("timestamp", timestamp).put("proof", proof)) as? JSONObject
        if (value?.optString("bindingStatus") != "bound") throw AuthFailure(AuthFailure.Kind.SERVER)
    }

    companion object { const val APP = "ANDROID" }
}

/**
 * Registration is admin-only. The phone looks itself up by its exact SPKI (`mine`); when an admin has
 * registered it but it is not yet bound, it proves key possession once (challenge → sign
 * `BIND|deviceId|credentialId|nonce|timestamp` → bind) and then reads the bound state back.
 * Blocking; run off the main thread.
 */
class Enrollment(
    private val api: DeviceApi,
    private val signer: DeviceSigner,
    private val vault: SessionVault,
    private val monotonicMillis: () -> Long = { System.nanoTime() / 1_000_000 },
    private val newCredentialId: () -> String = { UUID.randomUUID().toString() }
) {
    /** One lookup (and, if needed, one bind). Throws [AuthFailure]/[ConvexFunctionError] on failure. */
    fun refresh(): EnrollmentState {
        val record = api.mine(signer.publicKeyBase64)
        val state = classify(record)
        if (record != null && state == null) {
            bindOnce(record.deviceId)
            val after = api.mine(signer.publicKeyBase64) // never trust a bare success: read back
            return persist(after, classify(after) ?: throw AuthFailure(AuthFailure.Kind.SERVER))
        }
        return persist(record, state!!)
    }

    /** `null` means "registered, active, not yet bound" — bind required. */
    private fun classify(record: DeviceRecord?): EnrollmentState? = when {
        record == null -> EnrollmentState.Unregistered
        record.allowedApp != ConvexDeviceApi.APP -> EnrollmentState.Unregistered
        record.status != "active" -> EnrollmentState.Removed // revoked or suspended: stop, ask admin
        record.bound -> EnrollmentState.Ready(record.deviceId)
        else -> null
    }

    private fun persist(record: DeviceRecord?, state: EnrollmentState): EnrollmentState {
        vault.deviceId = if (state is EnrollmentState.Ready) record?.deviceId else null
        return state
    }

    private fun bindOnce(deviceId: String) {
        val (nonce, expiresAt) = api.challenge(deviceId)
        val received = monotonicMillis()
        // Server time ≈ expiresAt − TTL at issue; derive the proof timestamp from it so a phone with a
        // skewed wall clock still lands inside the server's ±60 s window.
        val timestamp = expiresAt - CHALLENGE_TTL_MS + (monotonicMillis() - received)
        val credentialId = newCredentialId()
        val proof = signer.sign(bindMessage(deviceId, credentialId, nonce, timestamp))
        try {
            api.bind(deviceId, credentialId, ATTESTATION_FORMAT, signer.protection.name.lowercase(),
                nonce, timestamp, proof)
        } catch (e: ConvexFunctionError) {
            // A concurrent/previous attempt may already have bound this key; the read-back decides.
            if (e.code != "Device already bound or missing key") throw e
        }
    }

    companion object {
        const val CHALLENGE_TTL_MS = 60_000L
        /** Metadata only; the server records it as unverified, never as hardware attestation. */
        const val ATTESTATION_FORMAT = "android-keystore-unverified"
        const val POLL_INTERVAL_MS = 10_000L
        fun bindMessage(deviceId: String, credentialId: String, nonce: String, timestamp: Long) =
            "BIND|$deviceId|$credentialId|$nonce|$timestamp"
    }
}
