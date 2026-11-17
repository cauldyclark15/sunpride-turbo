package com.sunpride.field.sell

import org.json.JSONObject

/**
 * SP-0192: whether the office switched Selling on for this person. Read from the Field app's own signed-in `/api/me`
 * answer (`selling` at the top, or inside `profile`). Absent, null or anything but `true` means off, so an older server
 * (or a person nobody switched on) keeps today's Field app exactly as it is.
 */
object SellingFlag {
    fun from(me: JSONObject?): Boolean {
        if (me == null) return false
        if (me.opt("selling") == true) return true
        return me.optJSONObject("profile")?.opt("selling") == true
    }
}
