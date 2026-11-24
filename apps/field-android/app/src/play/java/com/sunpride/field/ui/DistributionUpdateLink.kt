package com.sunpride.field.ui

/** The default (including every Play bundle) contains no external APK update action. */
object DistributionUpdateLink {
    const val apk = false
    fun urls(packageName: String, @Suppress("UNUSED_PARAMETER") update: FieldUpdateInfo?,
        @Suppress("UNUSED_PARAMETER") fromPlay: Boolean): List<String> = PlayStoreUpdate.uris(packageName)
}
