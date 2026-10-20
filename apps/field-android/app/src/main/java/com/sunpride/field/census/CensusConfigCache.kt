package com.sunpride.field.census

import org.json.JSONObject

/** F-011 one single-flight setup cache. Invalidate durably BEFORE the request, so a
 * later denial cannot leave readable old data when storage subsequently fails.
 * A bootstrap generation is a grant boundary, not permission to revive old setup. */
object CensusConfigCache {
    private val lock=Any()
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
