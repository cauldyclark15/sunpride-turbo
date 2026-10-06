package com.sunpride.van.sync

import com.sunpride.van.data.PushResult
import com.sunpride.van.data.VanBootstrap
import com.sunpride.van.storage.OutboxRow
import com.sunpride.van.storage.StoreScope

interface VanSyncStore {
    val scope: StoreScope
    suspend fun pending(): List<OutboxRow>
    suspend fun resetSending()
    suspend fun markSending(ids: List<String>)
    suspend fun hold()
    suspend fun setHealth(health: String, successTime: Long? = null)
    suspend fun recordResult(row: OutboxRow, result: PushResult)
    suspend fun replaceBootstrap(text: String): VanBootstrap
}
