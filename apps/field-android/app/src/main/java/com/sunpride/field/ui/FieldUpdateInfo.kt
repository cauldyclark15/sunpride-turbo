package com.sunpride.field.ui

import org.json.JSONObject
import java.net.URI

/** Public publisher facts only; no sessions, customer data or device registration. */
data class FieldUpdateInfo(val version: Int, val name: String, val download: String, val minimum: Int) {
    fun required(installed: Int) = installed < minimum
    companion object {
        fun decode(json: String, packageName: String, installed: Int): FieldUpdateInfo? {
            val o = JSONObject(json)
            if (o.has("release") && o.isNull("release")) return null
            require(o.getString("package_name") == packageName && o.getString("app") == "field")
            val version = o.getLong("version_code")
            val minimum = o.getLong("minimum_supported_version_code")
            require(o.get("version_code") is Number && o.getDouble("version_code") == version.toDouble())
            require(o.get("minimum_supported_version_code") is Number && o.getDouble("minimum_supported_version_code") == minimum.toDouble())
            require(version in 1..Int.MAX_VALUE.toLong() && minimum in 0..version)
            val name = o.getString("version_name"); require(name.isNotBlank() && name.length <= 100)
            val download = o.getString("download_url"); val u = URI(download)
            require(download.length <= 1000 && u.scheme == "https" && u.rawUserInfo == null && u.port == -1 && u.rawFragment == null)
            require((u.host == "drive.google.com" && Regex("/file/d/[A-Za-z0-9_-]+/view").matches(u.rawPath) &&
                u.rawQuery in listOf(null, "usp=drivesdk", "usp=sharing")) ||
                (u.host == "sunpride.cauldnclark.com" && Regex("/downloads/[A-Za-z0-9._/-]+\\.apk").matches(u.rawPath) && u.rawQuery == null))
            return if (version <= installed) null else FieldUpdateInfo(version.toInt(), name, download, minimum.toInt())
        }
    }
}
