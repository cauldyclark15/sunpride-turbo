package com.sunpride.field

import java.net.URI

/** The single Sunpride server origin (API, sync, media). No request is permitted until it is valid. */
data class AppEnvironment(val apiOrigin: String) {
    val errors: List<String> = listOfNotNull(validate(apiOrigin))
    val isReady: Boolean get() = errors.isEmpty()

    companion object {
        const val LABEL = "SUNPRIDE_API_ORIGIN"

        private fun validate(raw: String): String? {
            if (raw.isBlank()) return "$LABEL is missing. Set it in local.properties or the environment."
            val uri = try { URI(raw.trim()) } catch (_: Exception) { return "$LABEL is not a valid URL." }
            val host = uri.host?.lowercase() ?: return "$LABEL must have a valid host."
            val local = host == "localhost" || host == "127.0.0.1" || host == "10.0.2.2"
            if (uri.scheme != "https" && !(uri.scheme == "http" && local))
                return "$LABEL must use HTTPS (HTTP is allowed only for localhost/10.0.2.2)."
            if (uri.userInfo != null || uri.query != null || uri.fragment != null || uri.path !in listOf("", "/"))
                return "$LABEL must be an origin without credentials, path, query or fragment."
            return null
        }
    }
}
