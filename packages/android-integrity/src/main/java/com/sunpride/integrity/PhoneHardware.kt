package com.sunpride.integrity

import android.os.Build
import java.net.URLEncoder

/** Optional display facts, never identifiers or a condition of phone access. */
object PhoneHardware {
    fun headers(manufacturer: String? = Build.MANUFACTURER, model: String? = Build.MODEL): Map<String, String> =
        listOf("x-device-manufacturer" to manufacturer, "x-device-model" to model).mapNotNull { (key, raw) ->
            val value = raw?.trim()?.takeIf { it.isNotEmpty() && it.length <= 120 && it.none(Char::isISOControl) }
            value?.let { key to URLEncoder.encode(it, "UTF-8").replace("+", "%20") }
        }.toMap()
}
