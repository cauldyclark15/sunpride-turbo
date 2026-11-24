package com.sunpride.field.ui

/** Compiled only by the direct-APK build script, never into a Play bundle. Android/browser handles installation. */
object DistributionUpdateLink {
    const val apk = true
    fun urls(packageName: String, update: FieldUpdateInfo?, fromPlay: Boolean): List<String> =
        if (fromPlay || update == null) PlayStoreUpdate.uris(packageName) else listOf(update.download)
}
