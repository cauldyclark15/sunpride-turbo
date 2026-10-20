package com.sunpride.integrity

import android.database.Cursor
import androidx.sqlite.db.SupportSQLiteDatabase
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.util.Base64

/** F-007: account/device-scoped export+erase. Never removes another account on a shared phone.
 * Caller holds its authorization mutex and durably holds the partition BEFORE this boundary.
 * No credentials/Keystore material are exported. Recovery is never automatically replayed.
 */
object PartitionRecovery {
    private val identifier=Regex("[A-Za-z_][A-Za-z0-9_]*")
    data class Partition(val accountColumn:String,val accountPattern:String,val deviceId:String,val prefix:Boolean=false)
    private fun quote(s:String):String {require(identifier.matches(s));return "\"$s\""}
    private fun tables(db:SupportSQLiteDatabase,p:Partition):List<String> {
        val names=mutableListOf<String>()
        db.query("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").use { c -> while(c.moveToNext()) {
            val name=c.getString(0);if(!identifier.matches(name)) continue
            val columns=mutableSetOf<String>()
            db.query("pragma table_info(${quote(name)})").use { info->while(info.moveToNext()) columns.add(info.getString(1)) }
            if(p.accountColumn in columns && "deviceId" in columns) names.add(name)
        } }
        return names
    }
    private fun where(p:Partition)="${quote(p.accountColumn)} ${if(p.prefix) "like" else "="} ? and \"deviceId\"=?"
    fun snapshot(db:SupportSQLiteDatabase,p:Partition):JSONObject {
        val all=JSONArray();var queued=0
        db.beginTransaction()
        try {
            for(table in tables(db,p)) {
                val rows=JSONArray()
                db.query("select * from ${quote(table)} where ${where(p)} order by rowid",arrayOf(p.accountPattern,p.deviceId)).use { c ->
                    while(c.moveToNext()) {
                        val row=JSONObject()
                        for(n in 0 until c.columnCount) row.put(c.getColumnName(n),when(c.getType(n)) {
                            Cursor.FIELD_TYPE_NULL->JSONObject.NULL
                            Cursor.FIELD_TYPE_INTEGER->c.getLong(n)
                            Cursor.FIELD_TYPE_FLOAT->c.getDouble(n)
                            Cursor.FIELD_TYPE_BLOB->Base64.getEncoder().encodeToString(c.getBlob(n))
                            else->c.getString(n)
                        })
                        rows.put(row)
                        if(table=="outbox" && (row.optString("state",row.optString("status")) !in setOf("done","acknowledged"))) queued++
                    }
                }
                all.put(JSONObject().put("table",table).put("rows",rows))
            }
            db.setTransactionSuccessful()
        } finally {db.endTransaction()}
        return JSONObject().put("tables",all).put("queuedCount",queued)
    }
    fun erase(db:SupportSQLiteDatabase,p:Partition) {
        db.query("pragma secure_delete=ON").use { check(it.moveToFirst() && it.getInt(0)==1) }
        db.beginTransaction()
        try {
            for(table in tables(db,p).asReversed()) db.execSQL("delete from ${quote(table)} where ${where(p)}",arrayOf(p.accountPattern,p.deviceId))
            db.setTransactionSuccessful()
        } finally {db.endTransaction()}
        check(snapshot(db,p).getJSONArray("tables").let { tables -> (0 until tables.length()).all { tables.getJSONObject(it).getJSONArray("rows").length()==0 } })
        // SQLCipher secure_delete overwrites freed content; checkpoint excludes recoverable live WAL pages.
        db.query("pragma wal_checkpoint(TRUNCATE)").use { check(it.moveToFirst() && it.getInt(0)==0) { "Encrypted store is busy; retry erasure" } }
    }
    fun canonical(value:Any?):String=when(value) {
        null,JSONObject.NULL->"null"
        is JSONObject->value.keys().asSequence().toList().sorted().joinToString(",","{","}") { JSONObject.quote(it)+":"+canonical(value.get(it)) }
        is JSONArray->(0 until value.length()).joinToString(",","[","]") {canonical(value.get(it))}
        is String->JSONObject.quote(value)
        is Number->JSONObject.numberToString(value)
        else->value.toString()
    }
    fun digest(value:Any?):String=bytesDigest(canonical(value).toByteArray(Charsets.UTF_8))
    fun bytesDigest(value:ByteArray):String=MessageDigest.getInstance("SHA-256").digest(value).joinToString("") {"%02x".format(it.toInt() and 255)}
}
