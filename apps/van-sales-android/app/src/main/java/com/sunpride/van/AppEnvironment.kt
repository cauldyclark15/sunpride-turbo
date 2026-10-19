package com.sunpride.van

import java.net.URI

/** No request is permitted until the Sunpride server origin is configured. */
data class AppEnvironment(val siteUrl: String, val apiUrl: String = siteUrl) {
    val errors: List<String> = listOfNotNull(
        validate("SUNPRIDE_API_ORIGIN", siteUrl),
        validate("SUNPRIDE_API_ORIGIN", apiUrl)
    )
    val isReady: Boolean get() = errors.isEmpty()

    companion object {
        private fun validate(label: String, raw: String): String? {
            if (raw.isBlank()) return "$label is missing. Set the flavor endpoint in local.properties or the environment."
            val uri = try { URI(raw.trim()) } catch (_: Exception) { return "$label is not a valid URL." }
            val host = uri.host?.lowercase() ?: return "$label must have a valid host."
            val local = host == "localhost" || host == "127.0.0.1" || host == "10.0.2.2"
            if (uri.scheme != "https" && !(uri.scheme == "http" && local))
                return "$label must use HTTPS (HTTP is allowed only for localhost/10.0.2.2)."
            if (uri.userInfo != null || uri.query != null || uri.fragment != null || uri.path !in listOf("", "/"))
                return "$label must be an origin without credentials, path, query or fragment."
            return null
        }
    }
}
