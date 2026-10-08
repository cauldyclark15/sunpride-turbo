package com.sunpride.van.sync

import com.sunpride.van.data.PushResult
import com.sunpride.van.location.LocationFix
import com.sunpride.van.location.LocationPingCodec
import com.sunpride.van.storage.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

/** SP-0137: buffered pings go out after the operations, never block them, and are done only on a result. */
class VanLocationSyncTest {
    private fun fixture() = javaClass.classLoader!!.getResourceAsStream("bootstrap-response.json")!!.bufferedReader().readText()
    private class Store : VanSyncStore {
        override val scope = StoreScope("issuer|test","d")
        val pings = linkedMapOf<String,LocationPingRow>(); var held = false; var health = "never_synced"; var pruned = 0
        fun add(n: Int) = repeat(n) { i ->
            val id = LocationPingCodec.newPingId(); val fix = LocationFix(1_760_000_000_000L+i*60_000L,10.3,123.9,8.0,2.0,90.0,"gps",false)
            pings[id] = LocationPingRow(scope.fullAuthSubject,"d",id,"t",fix.recordedAt,fix.latitude,fix.longitude,"moving",LocationPingCodec.ping(id,"t",fix,"moving",80))
        }
        override suspend fun pending(excluding: Set<String>) = emptyList<OutboxRow>()
        override suspend fun canSync() = !held
        override suspend fun resetSending() {}
        override suspend fun markSending(ids: List<String>) {}
        override suspend fun hold() { held = true }
        override suspend fun setHealth(health: String, successTime: Long?) { this.health = health }
        override suspend fun recordResult(row: OutboxRow, result: PushResult) {}
        override suspend fun replaceBootstrap(text: String) = VanBootstrapCodec.decode(text)
        override suspend fun pendingPings() = pings.values.filter { it.status == "pending" }.sortedBy { it.recordedAt }.take(100)
        override suspend fun recordPingResults(results: List<Pair<LocationPingRow,LocationPingCodec.Result>>) = results.forEach { (row,r) ->
            if (r.status == "rejected") pings[row.clientPingId] = row.copy(status = "rejected",rejectionCode = r.code) else pings.remove(row.clientPingId)
        }
        override suspend fun prunePings() { pruned++; pings.values.removeIf { it.status == "rejected" } }
    }
    private open inner class Gateway(val answer: (List<String>) -> List<LocationPingCodec.Result>) : VanGateway {
        val batches = mutableListOf<List<String>>()
        override suspend fun bootstrap() = fixture()
        override suspend fun push(operations: List<OutboxRow>) = emptyList<PushResult>()
        override suspend fun location(pings: List<String>): List<LocationPingCodec.Result> { batches += pings; return answer(pings) }
    }
    private fun id(json: String) = org.json.JSONObject(json).getString("clientPingId")

    @Test fun sendsBatchesOfAtMost100AndDeletesAcknowledged() = runBlocking {
        val store = Store().apply { add(150) }
        val gateway = Gateway { p -> p.map { LocationPingCodec.Result(id(it),"accepted",null) } }
        VanSync(store,gateway).syncNow()
        assertEquals(listOf(100,50),gateway.batches.map { it.size })
        assertTrue(store.pings.isEmpty()); assertEquals("synced",store.health); assertEquals(1,store.pruned)
    }

    @Test fun duplicateIsDoneAndRejectedIsNeverRetried() = runBlocking {
        val store = Store().apply { add(3) }
        val gateway = Gateway { p -> p.mapIndexed { i,it -> LocationPingCodec.Result(id(it),listOf("accepted","duplicate","rejected")[i],if (i == 2) "too_frequent" else null) } }
        val sync = VanSync(store,gateway)
        sync.syncNow()
        assertEquals(1,store.pings.size); assertEquals("too_frequent",store.pings.values.single().rejectionCode)
        sync.syncNow()
        assertEquals(1,gateway.batches.size); assertTrue(store.pings.isEmpty())
    }

    @Test fun transportFailureKeepsPingsAndTheSameBytesWithoutFailingTheSync() = runBlocking {
        val store = Store().apply { add(2) }; var fail = true
        val gateway = Gateway { p -> if (fail) throw VanSyncFailure("offline",true) else p.map { LocationPingCodec.Result(id(it),"accepted",null) } }
        val sync = VanSync(store,gateway)
        sync.syncNow()
        assertEquals(2,store.pings.size); assertEquals("retry_pending",store.health)
        fail = false; sync.syncNow()
        assertEquals(gateway.batches[0],gateway.batches[1]); assertTrue(store.pings.isEmpty()); assertEquals("synced",store.health)
    }

    @Test fun malformedResponseKeepsPings() = runBlocking {
        val store = Store().apply { add(2) }
        VanSync(store,Gateway { throw VanWireFailure() }).syncNow()
        assertEquals(2,store.pings.size); assertEquals("retry_pending",store.health)
    }

    @Test fun invalidRequestDropsTheBatchInsteadOfLooping() = runBlocking {
        val store = Store().apply { add(2) }
        val gateway = Gateway { throw VanSyncFailure("invalid_request",false) }
        VanSync(store,gateway).syncNow()
        assertEquals(1,gateway.batches.size); assertTrue(store.pings.values.all { it.status == "rejected" && it.rejectionCode == "invalid_request" })
    }

    @Test fun unauthorizedHoldsThePartitionAndSendsNothingMore() = runBlocking {
        val store = Store().apply { add(2) }
        val failure = runCatching { VanSync(store,Gateway { throw VanSyncFailure("unauthorized",false) }).syncNow() }.exceptionOrNull()
        assertTrue(failure is VanSyncFailure); assertTrue(store.held); assertEquals(2,store.pings.size)
    }

    @Test fun gatewayWithoutLocationSupportLeavesPingsWaiting() = runBlocking {
        val store = Store().apply { add(1) }
        val gateway = object : VanGateway { override suspend fun bootstrap() = fixture(); override suspend fun push(operations: List<OutboxRow>) = emptyList<PushResult>() }
        VanSync(store,gateway).syncNow()
        assertEquals(1,store.pings.size); assertEquals("retry_pending",store.health)
    }

    @Test fun heldPartitionSendsNoPingsAndDoesNotFailTheSync() = runBlocking {
        val store = Store().apply { add(2); held = true }
        val gateway = Gateway { p -> p.map { LocationPingCodec.Result(id(it),"accepted",null) } }
        VanSync(store,gateway).syncNow()
        assertTrue(gateway.batches.isEmpty()); assertEquals(2,store.pings.size)
    }
}
