package com.sunpride.field.ui.route

/**
 * AND-018: hand an outlet to whatever map or navigation provider the phone has.
 *
 * First choice is the `geo:` URI from [DailyRoutes.navigationUri] (verified pin, else address), which
 * opens the salesperson's own maps app (Google Maps, Waze, a stock maps app…). Phones with no `geo:`
 * handler (stripped or work-profile builds) still get directions through Google's documented
 * cross-platform Maps URL, which opens the Maps app when present and any browser otherwise.
 */
object MapLaunch {
    private val pin = Regex("""^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\?q=.*$""")
    private val address = Regex("""^geo:0,0\?q=(.+)$""")

    /** Ordered launch attempts for one `geo:` URI produced by [DailyRoutes.navigationUri]. */
    fun candidates(geoUri: String): List<String> = listOfNotNull(geoUri, webDirections(geoUri))

    /** `https://www.google.com/maps/dir/?api=1&destination=…`, or null for a URI this app did not build. */
    fun webDirections(geoUri: String): String? {
        val destination = address.matchEntire(geoUri)?.groupValues?.get(1)
            ?: pin.matchEntire(geoUri)?.let { "${it.groupValues[1]}%2C${it.groupValues[2]}" }
            ?: return null
        return "https://www.google.com/maps/dir/?api=1&destination=$destination"
    }

    /** Tries each candidate in order; [start] returns false when no installed app accepts it. */
    fun open(geoUri: String, start: (String) -> Boolean): Boolean = candidates(geoUri).any(start)
}
