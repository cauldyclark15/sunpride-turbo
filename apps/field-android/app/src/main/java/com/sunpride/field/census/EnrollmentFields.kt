package com.sunpride.field.census

import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate

/** SP-0229: downloaded office form; string values preserve blank versus explicit No/zero. */
object EnrollmentFields {
    data class Field(val key: String, val label: String, val kind: String, val choices: List<String>,
        val requiredChannels: List<String>, val requiredTypes: List<String>) {
        fun required(form: CustomerCapture.Form) = form.distributionChannelCode in requiredChannels || form.typeOfBusiness in requiredTypes
    }
    private fun strings(a: JSONArray?) = if (a == null) emptyList() else (0 until a.length()).map { a.getString(it) }
    fun parse(a: JSONArray?): List<Field> = if (a == null) emptyList() else (0 until a.length()).map { i ->
        val f = a.getJSONObject(i)
        Field(f.getString("key"), f.getString("label"), f.getString("kind"), strings(f.optJSONArray("choices")),
            strings(f.optJSONArray("requiredChannels")), strings(f.optJSONArray("requiredTypes")))
    }
    fun values(o: JSONObject?): Map<String, String> = o?.keys()?.asSequence()?.associateWith { o.optString(it, "") }.orEmpty()
    fun validPhoto(s: String): Boolean {
        if (!Regex("data:image/jpeg;base64,/9j/[A-Za-z0-9+/]*={0,2}").matches(s) || s.length > ((100*1024+2)/3)*4+23) return false
        return runCatching {
            val encoded = s.substringAfter(","); val bytes = java.util.Base64.getDecoder().decode(encoded)
            bytes.size in 4..100*1024 && java.util.Base64.getEncoder().encodeToString(bytes) == encoded && bytes[bytes.size-2] == 0xff.toByte() && bytes.last() == 0xd9.toByte()
        }.getOrDefault(false)
    }
    fun errors(fields: List<Field>, form: CustomerCapture.Form): Map<String, String> = buildMap {
        for (f in fields) {
            val s = form.customFields[f.key].orEmpty().trim()
            val problem = when {
                s.isEmpty() -> if (f.required(form)) "is required for this customer." else null
                f.kind == "text" && s.length > 500 -> "use 500 characters or fewer."
                f.kind == "number" && (!Regex("[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)").matches(s) || s.toDoubleOrNull()?.let { !it.isFinite() || kotlin.math.abs(it) > 1e12 } != false) -> "enter a number."
                f.kind == "date" && (!Regex("\\d{4}-\\d{2}-\\d{2}").matches(s) || runCatching { LocalDate.parse(s).toString() != s }.getOrDefault(true)) -> "enter a real date as YYYY-MM-DD."
                f.kind == "choice" && s !in f.choices -> "choose from the list."
                f.kind == "boolean" && s !in listOf("true", "false") -> "choose Yes or No."
                f.kind == "photo" && !validPhoto(s) -> "choose a JPEG photo no larger than 100 KB."
                f.kind !in listOf("text", "number", "date", "choice", "boolean", "photo") -> "download the latest app to fill this field."
                else -> null
            }
            if (problem != null) put("customFields.${f.key}", "${f.label}: $problem")
        }
    }
}
