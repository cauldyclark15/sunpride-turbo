package com.sunpride.field.census

import org.json.JSONObject

/** F-011 one single-flight setup cache. Invalidate durably BEFORE the request, so a
 * later denial cannot leave readable old data when storage subsequently fails.
 * A bootstrap generation is a grant boundary, not permission to revive old setup. */
object CensusConfigCache {
    private val lock=Any()
    /** R6F3/SP-0176: the cache is keyed by the signed-in person on this phone (account, device, scope), NOT by the
     * bootstrap generation or the rotating session token: every sync made a new generation, so the lists fetched
     * minutes earlier were unreadable offline ("Connect once to download the customer lists"). [cacheValid] is the
     * partition's own offline window (not held, cache not expired), so a removed/held phone still reads nothing. */
    fun grantFor(scope:com.sunpride.field.storage.StoreScope?,cacheValid:Boolean):String? =
        if(scope==null||!cacheValid)null else "scope:${scope.account}|${scope.deviceId}|${scope.fingerprint}"
    /** R6F3/SP-0176: every "could not reach the office" failure falls back to the saved lists: no network, refused
     * connection, timeout, DNS, captive-portal garbage, 5xx and throttling. Only an explicit refusal (the server
     * said no, or the session ended) still blocks the saved copy. */
    fun isUnreachable(error:Throwable):Boolean = when(error){
        is com.sunpride.field.auth.AuthFailure -> error.kind in setOf(com.sunpride.field.auth.AuthFailure.Kind.OFFLINE,
            com.sunpride.field.auth.AuthFailure.Kind.SERVER,com.sunpride.field.auth.AuthFailure.Kind.RATE_LIMITED)
        is com.sunpride.field.auth.ServerError -> false
        is java.io.IOException, is org.json.JSONException -> true
        else -> false
    }
    fun load(now:Long,epoch:()->Long,generation:()->String?,read:()->String?,block:()->Unit,
             write:(String)->Unit,fetch:()->String,isOffline:(Throwable)->Boolean):String? = synchronized(lock) {
        val started=epoch();val grant=generation()?:return@synchronized null
        fun current()=epoch()==started&&generation()==grant
        val saved=read()?.let { raw->runCatching { JSONObject(raw) }.getOrNull() }
            ?.takeIf { it.optInt("version")==1&&it.optString("generation")==grant&&it.optLong("savedAt")>0&&it.optLong("savedAt")<=now }
        // If this write fails, make no HTTP request and return no cached answer.
        block()
        try {
            val text=fetch();val config=JSONObject(text)
            check(current()){ "Census authorization changed" }
            val envelope=JSONObject().put("version",1).put("generation",grant).put("savedAt",now).put("config",config).toString()
            write(envelope)
            check(current()){ "Census authorization changed" }
            text
        }catch(error:Throwable){
            if(!isOffline(error))throw error
            check(current()){ "Census authorization changed" }
            val cached=saved?.optJSONObject("config")?:return@synchronized null
            // Restore the original grant/time, never renew it using an offline clock.
            write(saved.toString())
            check(current()){ "Census authorization changed" }
            cached.toString()
        }
    }
}
