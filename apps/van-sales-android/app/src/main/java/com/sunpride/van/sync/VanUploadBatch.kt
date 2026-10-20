package com.sunpride.van.sync

import com.sunpride.van.storage.OutboxRow

/** F-113/F-123 inline JPEG + ink must not make a legal 20-operation queue exceed core's 1 MiB JSON cap.
 * Select a FIFO prefix, without reserializing or changing immutable captures. Leave room for v2 envelope fields.
 */
object VanUploadBatch {
    const val MAX_OPERATIONS=20
    const val CAPTURE_BUDGET_BYTES=768*1024
    fun select(rows: List<OutboxRow>): List<OutboxRow> {
        val selected=mutableListOf<OutboxRow>()
        var bytes=1024L
        for(row in rows) {
            val next=row.operationJson.toByteArray(Charsets.UTF_8).size.toLong()+512L
            if(selected.isNotEmpty() && bytes+next>CAPTURE_BUDGET_BYTES) break
            selected+=row
            bytes+=next
            // Do not hide a single oversized capture behind an empty prefix; the gateway must handle it on its own.
            if(selected.size==MAX_OPERATIONS || bytes>CAPTURE_BUDGET_BYTES) break
        }
        return selected
    }
}
