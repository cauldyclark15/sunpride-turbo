package com.sunpride.field.sell.sync

import com.sunpride.field.sell.data.PushResult
import com.sunpride.field.sell.data.VanBootstrap
import com.sunpride.field.sell.storage.OutboxRow
import com.sunpride.field.sell.storage.StoreScope

interface VanSyncStore {
    val scope: StoreScope
    fun authorizationEpoch(): Long = 0
    suspend fun pending(excluding: Set<String> = emptySet()): List<OutboxRow>
    suspend fun canSync(): Boolean = true
    suspend fun cleanupAcknowledgedPhotos() {}
    suspend fun resetSending()
    suspend fun markSending(ids: List<String>)
    suspend fun hold()
    suspend fun setHealth(health: String, successTime: Long? = null)
    suspend fun recordResult(row: OutboxRow, result: PushResult)
    suspend fun replaceBootstrap(text: String): VanBootstrap
    /** SP-0137 live-location pings ready to upload (none by default). */
    suspend fun pendingPings(): List<com.sunpride.field.sell.storage.LocationPingRow> = emptyList()
    suspend fun recordPingResults(results: List<Pair<com.sunpride.field.sell.storage.LocationPingRow,com.sunpride.field.sell.location.LocationPingCodec.Result>>) {}
    suspend fun prunePings() {}
}
