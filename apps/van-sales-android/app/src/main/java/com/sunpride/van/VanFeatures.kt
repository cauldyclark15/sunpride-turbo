package com.sunpride.van

import java.net.URI

/**
 * The beta feature list (SP-0125). Anything not ready for testers is hidden here, never deleted:
 * its code, screens and tests stay, and a DEV debug build still shows it. See `docs/beta.md`.
 */
enum class VanFeature {
    /** Practice (fixture) data launched by an adb intent extra. Never part of a release build. */
    DEVELOPER_TOOLS,
}

data class VanFeatures(val enabled: Set<VanFeature>, val reportIssueUrl: String? = null) {
    operator fun contains(feature: VanFeature) = feature in enabled

    companion object {
        /** Switched off in every release build (beta included). */
        val HIDDEN_IN_RELEASE: Set<VanFeature> = setOf(VanFeature.DEVELOPER_TOOLS)

        /** Everything on: DEV debug builds and UI tests. */
        val ALL = VanFeatures(VanFeature.entries.toSet())

        /** What a build shows; [webUrl] is the web app the "Report an issue" link opens. */
        fun forBuild(debug: Boolean, webUrl: String): VanFeatures {
            val enabled = if (debug) VanFeature.entries.toSet() else VanFeature.entries.toSet() - HIDDEN_IN_RELEASE
            return VanFeatures(enabled, reportIssueUrl(webUrl))
        }

        /**
         * `<web>/issues/new`, or null (link hidden) when the web URL is blank or not a plain
         * https address (http only for localhost). Trailing slashes are dropped.
         */
        fun reportIssueUrl(webUrl: String): String? {
            val base = webUrl.trim().trimEnd('/')
            if (base.isEmpty() || base.any { it.isWhitespace() }) return null
            val uri = runCatching { URI(base) }.getOrNull() ?: return null
            val host = uri.host?.lowercase() ?: return null
            val local = host == "localhost" || host == "10.0.2.2"
            if (uri.scheme != "https" && !(uri.scheme == "http" && local)) return null
            if (uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) return null
            return "$base/issues/new"
        }
    }
}
