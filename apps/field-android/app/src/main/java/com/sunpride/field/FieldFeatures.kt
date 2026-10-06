package com.sunpride.field

/**
 * The beta feature list (SP-0124). Anything not used in the beta yet is hidden here, never
 * deleted: its code, screens and tests stay, and removing it from [FieldFeatures.HIDDEN_IN_BETA]
 * switches it back on. `docs/BETA_FEATURES.md` lists every entry and why.
 */
enum class FieldFeature {
    /** Start/End call, activities, call sheet, orders and visit photos (from Today, Route and Customers). */
    VISITS,

    /** The "Unplanned visit" list on Today (needs [VISITS]). */
    UNPLANNED_VISITS,

    /** The supervisor-only Team page. */
    TEAM,

    /** Key storage and fingerprint rows on Account: technical phone-key details. */
    PHONE_KEY_DETAILS,

    /** Developer tools: the public-key file for `adb pull`. Never part of a release build. */
    DEVELOPER_TOOLS,
}

data class FieldFeatures(val enabled: Set<FieldFeature>, val reportIssueUrl: String? = null) {
    operator fun contains(feature: FieldFeature) = feature in enabled

    companion object {
        /** Switched off in the beta build. Remove an entry (and rebuild) to switch it back on. */
        val HIDDEN_IN_BETA: Set<FieldFeature> = setOf(FieldFeature.UNPLANNED_VISITS, FieldFeature.PHONE_KEY_DETAILS)

        /** Only a debuggable DEV build carries these, whatever the beta list says. */
        val DEVELOPER_ONLY: Set<FieldFeature> = setOf(FieldFeature.DEVELOPER_TOOLS)

        /** Everything on: DEV debug builds and UI tests. */
        val ALL = FieldFeatures(FieldFeature.entries.toSet())

        /** Visits and their screens hidden: the old non-DEV behaviour, kept for existing tests. */
        val READ_ONLY = FieldFeatures(setOf(FieldFeature.TEAM, FieldFeature.PHONE_KEY_DETAILS))

        /** What a build of [flavor] shows; [webUrl] is the web app the "Report an issue" link opens. */
        fun forBuild(flavor: String, debug: Boolean, webUrl: String): FieldFeatures {
            val developer = debug && flavor == "dev"
            val enabled = if (developer) FieldFeature.entries.toSet()
            else FieldFeature.entries.toSet() - DEVELOPER_ONLY - HIDDEN_IN_BETA
            return FieldFeatures(enabled, reportIssueUrl(webUrl))
        }

        /**
         * `<web>/issues/new`, or null (link hidden) when the web URL is blank or not an
         * http(s) address. Trailing slashes are dropped.
         */
        fun reportIssueUrl(webUrl: String): String? {
            val base = webUrl.trim().trimEnd('/')
            if (base.isEmpty() || base.any { it.isWhitespace() }) return null
            val uri = runCatching { java.net.URI(base) }.getOrNull() ?: return null
            if (uri.scheme !in setOf("https", "http") || uri.host.isNullOrBlank()) return null
            if (uri.rawQuery != null || uri.rawFragment != null) return null
            return "$base/issues/new"
        }
    }
}
