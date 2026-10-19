package com.sunpride.van.device

/**
 * Proof for v2 sync pull/push and media claims, exactly as
 * the van gateway verifies it:
 * `POST|<path>|<lowercase sha256 hex of raw body>|<nonce>|<timestamp ms>`, P1363 base64.
 * Callers must send the very [body] bytes that were signed.
 */
object RequestSigner {
    val PATHS = setOf("/api/sync/pull", "/api/sync/push", "/api/media/claims")
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
        require(timestamp.toString().matches(Regex("^[0-9]{13}$"))) { "Invalid proof timestamp" }
        val digest = bodyDigest(body)
        return linkedMapOf(
            "Content-Type" to "application/json",
            "x-device-id" to deviceId,
            "x-device-nonce" to nonce,
            "x-device-timestamp" to timestamp.toString(),
            "x-device-signature" to signer.sign("POST|$path|$digest|$nonce|$timestamp")
        )
    }
}
