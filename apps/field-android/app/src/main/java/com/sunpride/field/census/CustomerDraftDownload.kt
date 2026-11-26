package com.sunpride.field.census

import org.json.JSONObject

/** Stage all pages before changing the encrypted draft book. Filtered empty pages
 * still have a continuation; a broken/partial download is never an empty list. */
object CustomerDraftDownload {
    fun load(fetch: (String?) -> JSONObject): List<JSONObject> {
        val downloaded = mutableListOf<JSONObject>()
        val cursors = mutableSetOf<String>()
        var cursor: String? = null
        do {
            val result = fetch(cursor)
            val rows = result.getJSONArray("rows")
            for (i in 0 until rows.length()) downloaded += rows.getJSONObject(i)
            cursor = result.optString("nextCursor").takeUnless { it.isBlank() || it == "null" }
            check(cursor == null || cursors.add(cursor)) { "Repeated draft page" }
            check(cursors.size <= 1000) { "Too many draft pages" }
        } while (cursor != null)
        return downloaded
    }
}
