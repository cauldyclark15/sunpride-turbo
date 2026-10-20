package com.sunpride.van.sync

import com.sunpride.van.storage.OutboxRow
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class VanUploadBatchTest {
    private fun row(index: Int,body: String)=UUID.randomUUID().toString().let {id->
        OutboxRow("subject","device",id,"trip","return.record",JSONObject().put("kind","return.record").put("clientRequestId",id)
            .put("payload",JSONObject().put("deviceTime",index.toLong()).put("capture",body)).toString(),index.toLong())
    }
    private fun envelope(rows: List<OutboxRow>)=JSONObject().put("version",2).put("app","van-android").put("deviceId","device")
        .put("scopeId","scope").put("operations",JSONArray(rows.map(V2VanCodec::operation))).toString().toByteArray(Charsets.UTF_8)
    @Test fun F123_largeUtf8CapturesSplitBelowTheActualCoreBodyCapWithoutChangingBytes() {
        val rows=(1..20).map {row(it,"é".repeat(40_000))}
        val original=rows.map {it.operationJson}
        assertTrue(envelope(rows).size>1024*1024)
        val batch=VanUploadBatch.select(rows)
        assertTrue(batch.isNotEmpty() && batch.size<rows.size)
        assertTrue(envelope(batch).size<1024*1024)
        assertEquals(rows.take(batch.size),batch)
        batch.forEachIndexed {i,row->assertSame(rows[i],row)}
        assertEquals(original,rows.map {it.operationJson})
        assertEquals(rows.drop(batch.size).first(),VanUploadBatch.select(rows.drop(batch.size)).first())
    }
    @Test fun F123_smallOperationsRetainTheExistingTwentyItemLimit() {
        val rows=(1..25).map {row(it,"small")}
        assertEquals(rows.take(20),VanUploadBatch.select(rows))
        assertTrue(VanUploadBatch.select(emptyList()).isEmpty())
    }
}
