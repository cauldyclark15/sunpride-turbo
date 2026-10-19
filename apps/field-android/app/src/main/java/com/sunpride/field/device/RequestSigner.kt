package com.sunpride.field.device

/**
 * Device proof for signed `POST /api/sync/pull|push` and `/api/media/claims`, as the server verifies it:
 * `POST|<path>|<lowercase sha256 hex of raw body>|<nonce>|<timestamp ms>`, P1363 base64.
 * Callers must send the very [body] bytes that were signed.
 */
object RequestSigner {
    // SP-0140: `/mobile/v1/location` (SP-0136 live-map pings) was missing, so every location upload
    // failed here before reaching the server and the worker retried forever.
    val PATHS = setOf("/api/sync/pull", "/api/sync/push", "/api/media/claims",
        // Frozen store/crypto regression fixtures. Live transports always prepare v2 before signing.
        "/mobile/v1/bootstrap", "/mobile/v1/pull", "/mobile/v1/push", "/mobile/v1/location")
    private val NONCE = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

    fun bodyDigest(body: ByteArray): String = hex(sha256(body))

    fun canonical(method: String, path: String, body: ByteArray, nonce: String, timestamp: Long): String =
        "$method|$path|${bodyDigest(body)}|$nonce|$timestamp"

    fun headers(
        signer: DeviceSigner,
        deviceId: String,
        path: String,
        body: ByteArray,
        nonce: String,
        timestamp: Long
    ): Map<String, String> {
        require(path in PATHS) { "Unsupported mobile path" }
        require(NONCE.matches(nonce)) { "Invalid challenge nonce" }
        require(deviceId.isNotBlank() && deviceId.none { it.isISOControl() }) { "Invalid device id" }
        val digest = bodyDigest(body)
        if (path.startsWith("/api/")) return linkedMapOf(
            "Content-Type" to "application/json",
            "x-device-id" to deviceId, "x-device-nonce" to nonce,
            "x-device-timestamp" to timestamp.toString(),
            "x-device-signature" to signer.sign("POST|$path|$digest|$nonce|$timestamp")
        )
        return linkedMapOf(
            "Content-Type" to "application/json",
            "x-mobile-contract-version" to "1",
            "x-mobile-device-id" to deviceId,
            "x-mobile-app" to "ANDROID",
            "x-mobile-nonce" to nonce,
            "x-mobile-timestamp" to timestamp.toString(),
            "x-mobile-body-digest" to digest,
            "x-mobile-signature" to signer.sign("POST|$path|$digest|$nonce|$timestamp")
        )
    }
}
