package com.sunpride.field

import java.net.URI

/** No request is permitted until both independent endpoint origins are configured. */
data class AppEnvironment(val siteUrl: String, val convexUrl: String) {
    val errors: List<String> = listOfNotNull(
        validate("CONVEX_SITE_URL", siteUrl, ".convex.site"),
        validate("CONVEX_URL", convexUrl, ".convex.cloud")
    )
    val isReady: Boolean get() = errors.isEmpty()

    companion object {
        private fun validate(label: String, raw: String, expectedSuffix: String): String? {
            if (raw.isBlank()) return "$label is missing. Set the flavor endpoint in local.properties or the environment."
            val uri = try { URI(raw.trim()) } catch (_: Exception) { return "$label is not a valid URL." }
            val host = uri.host?.lowercase() ?: return "$label must have a valid host."
            val local = host == "localhost" || host == "10.0.2.2"
            if (uri.scheme != "https" && !(uri.scheme == "http" && local))
                return "$label must use HTTPS (HTTP is allowed only for localhost/10.0.2.2)."
            if (uri.userInfo != null || uri.query != null || uri.fragment != null || uri.path !in listOf("", "/"))
                return "$label must be an origin without credentials, path, query or fragment."
            if (!local && !host.endsWith(expectedSuffix))
                return "$label must point to a $expectedSuffix host."
            return null
        }
    }
}
