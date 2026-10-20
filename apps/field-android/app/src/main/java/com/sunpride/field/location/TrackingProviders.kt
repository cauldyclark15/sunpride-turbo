package com.sunpride.field.location

/** Same platform-provider policy as visit capture; no Play-services task can silently lose the subscription. */
object TrackingProviders {
    fun choose(api: Int, enabled: Set<String>, precise: Boolean): List<String> =
        if (api >= 31 && "fused" in enabled) listOf("fused")
        else buildList {
            if ("network" in enabled) add("network")
            if (precise && "gps" in enabled) add("gps")
        }
}
