package com.sunpride.integrity

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.Base64

/** F-007: hold -> server-sealed recovery -> erase -> acknowledge -> sign out, with crash markers.
 * Markers contain only digests/file keys, never business data or credentials.
 */
object RemoteErasure {
    /** All in-process photo writers and remote snapshots share this fence. Persisted held rows gate other business transactions. */
    val recordingLock = kotlinx.coroutines.sync.Mutex()
    data class RecoveryFile(val key:String,val bytes:ByteArray)
    fun perform(context:Context,me:JSONObject,bundle:JSONObject,files:List<RecoveryFile>,
        sign:(String)->String,post:(String,JSONObject)->JSONObject,erase:()->Unit,
        deleteFile:(String)->Unit,lockOut:()->Unit) {
        val control=me.getJSONObject("deviceControl")
        val id=control.getString("id")
        require(id.matches(Regex("[0-9a-f-]{36}")))
        val prefs=context.getSharedPreferences("sunpride_remote_erasure",Context.MODE_PRIVATE)
        val previous=prefs.getString("$id.digest",null)
        val rows=bundle.getJSONArray("tables")
        val empty=(0 until rows.length()).all {rows.getJSONObject(it).getJSONArray("rows").length()==0}
        val tableDigest=PartitionRecovery.digest(bundle)
        fun contact(stage:String,value:Any):JSONObject {
            val signed=if(stage=="recover") PartitionRecovery.bytesDigest(value.toString().toByteArray(Charsets.UTF_8))
                else PartitionRecovery.digest(JSONObject().put("digest",value))
            val timestamp=me.getLong("serverTime")
            val body=JSONObject().put("controlId",id).put("timestamp",timestamp)
                .put("signature",sign("CONTROL|$stage|$id|$signed|$timestamp"))
            // Preserve exact native numeric encodings (including scientific notation and 64-bit integers).
            if(stage=="recover") body.put("bundleJson",value.toString()) else body.put("digest",value)
            return post("/api/devices/control/$stage",body)
        }
        val digest:String
        val keys:List<String>
        if(previous==null) {
            val recovery=JSONObject(bundle.toString()).put("photos",JSONArray(files.sortedBy { it.key }.map { JSONObject().put("key",it.key).put("jpegBase64",Base64.getEncoder().encodeToString(it.bytes)) }))
            check(recovery.toString().length<=900_000) { "Saved work is held. A supervised larger recovery is required before erasure." }
            val response=contact("recover",recovery)
            digest=PartitionRecovery.bytesDigest(recovery.toString().toByteArray(Charsets.UTF_8))
            check(response.optBoolean("held") && response.getString("digest")==digest) {"Recovery was not confirmed"}
            keys=files.map {it.key}
            check(prefs.edit().putString("$id.digest",digest).putString("$id.tables",tableDigest)
                .putString("$id.files",JSONArray(keys).toString()).commit())
        } else {
            check(empty || tableDigest==prefs.getString("$id.tables",null)) {"Saved work changed after recovery. Keep the phone held for review."}
            digest=previous
            val stored=JSONArray(prefs.getString("$id.files","[]"))
            keys=(0 until stored.length()).map {stored.getString(it)}
        }
        // If a DELETE or file erase fails, DO NOT acknowledge or call the phone wiped.
        erase()
        keys.forEach(deleteFile)
        val ack=contact("ack",digest)
        check(ack.optBoolean("acknowledged")) {"Erasure acknowledgment is pending"}
        lockOut()
        check(prefs.edit().remove("$id.digest").remove("$id.tables").remove("$id.files").commit())
    }
}
