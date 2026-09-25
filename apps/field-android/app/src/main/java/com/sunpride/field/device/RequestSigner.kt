package com.sunpride.field.device

/**
 * Proof for `POST {CONVEX_SITE_URL}/mobile/v1/{bootstrap,pull,push}`, exactly as
 * `packages/backend/convex/mobile/device_auth.ts` verifies it:
 * `POST|<path>|<lowercase sha256 hex of raw body>|<nonce>|<timestamp ms>`, P1363 base64.
 * Callers must send the very [body] bytes that were signed.
 */
object RequestSigner {
    val PATHS = setOf("/mobile/v1/bootstrap", "/mobile/v1/pull", "/mobile/v1/push")
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
