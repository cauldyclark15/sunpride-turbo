package com.sunpride.van.sync

import com.sunpride.van.data.*
import com.sunpride.van.storage.*
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject
import java.util.UUID

class VanSyncTest {
    private fun fixture() = javaClass.classLoader!!.getResourceAsStream("bootstrap-response.json")!!.bufferedReader().readText()
    private class Store(val cancelAfterAcks: Int = 0) : VanSyncStore {
        override val scope = StoreScope("issuer|test","d")
        val rows = linkedMapOf<String,OutboxRow>(); val acks = linkedMapOf<String,PushAck>(); val events = mutableListOf<String>(); var held=false; var health="never_synced"
        fun enqueue(i: Int) { val id=UUID.randomUUID().toString(); rows[id]=OutboxRow(scope.fullAuthSubject,"d",id,"t","trip.start",JSONObject().put("kind","trip.start").put("clientRequestId",id).put("payload",JSONObject().put("tripId","t").put("deviceTime",i)).toString(),i.toLong()) }
        override suspend fun pending(excluding: Set<String>) = if(held) emptyList() else rows.values.filter { it.status=="pending" && it.clientRequestId !in excluding }.sortedBy { it.createdAt }.take(20)
        override suspend fun resetSending() { rows.replaceAll { _,r -> r.copy(status=OutboxRules.interrupted(r.status)) } }
        override suspend fun markSending(ids: List<String>) { ids.forEach { rows[it]=rows.getValue(it).copy(status="sending") } }
        override suspend fun hold() { held=true }
        override suspend fun setHealth(health: String, successTime: Long?) { this.health=health }
        override suspend fun recordResult(row: OutboxRow, result: PushResult) {
            if(result.status=="accepted") { acks[row.clientRequestId]=result.ack!!; events+="ack"; rows[row.clientRequestId]=row.copy(status=OutboxRules.acknowledge(rows.getValue(row.clientRequestId).status,true)); events+="done"; if (acks.size == cancelAfterAcks) throw CancellationException() }
            else rows[row.clientRequestId]=row.copy(status=OutboxRules.reject(rows.getValue(row.clientRequestId).status,result.status))
        }
        override suspend fun replaceBootstrap(text: String) = VanBootstrapCodec.decode(text).also { events+="bootstrap" }
    }
    @Test fun pushesAtMost20InOrderAndPersistsAckBeforeDone() = runBlocking {
        val store = Store().apply { repeat(25) { enqueue(it) } }; val sizes=mutableListOf<Int>(); val times=mutableListOf<Long>()
        val backend = object : VanGateway {
            override suspend fun bootstrap()=fixture()
            override suspend fun push(operations: List<OutboxRow>): List<PushResult> { sizes+=operations.size; times+=operations.map { it.createdAt }; return operations.map { PushResult(it.kind,it.clientRequestId,"accepted",PushAck("e",null,2)) } }
        }
        VanSync(store,backend).syncNow(); assertEquals(listOf(20,5),sizes); assertEquals(times.sorted(),times); assertEquals(25,store.acks.size)
        assertTrue(store.rows.values.all { it.status=="done" }); assertEquals(listOf("ack","done"),store.events.filter { it!="bootstrap" }.take(2)); Unit
    }
    @Test fun transportFailureResetsSendingAndReplaysOriginalIdsAndBytes() = runBlocking {
        val store=Store().apply { enqueue(1) }; var fail=true; val payloads=mutableListOf<List<Pair<String,String>>>()
        val backend=object : VanGateway {
            override suspend fun bootstrap()=fixture()
            override suspend fun push(operations: List<OutboxRow>): List<PushResult> { payloads+=operations.map { it.clientRequestId to it.operationJson }; if(fail) throw VanSyncFailure("offline",true); return operations.map { PushResult(it.kind,it.clientRequestId,"accepted",PushAck("e",null,2)) } }
        }
        val sync=VanSync(store,backend); assertTrue(runCatching { sync.syncNow() }.isFailure); assertEquals("pending",store.rows.values.single().status)
        fail=false; sync.syncNow(); assertEquals(payloads[0],payloads[1]); Unit
    }
    @Test fun rejectedAndConflictAreNeverRetried() = runBlocking {
        val store=Store().apply { enqueue(1); enqueue(2) }; var calls=0
        val backend=object : VanGateway {
            override suspend fun bootstrap()=fixture()
            override suspend fun push(operations: List<OutboxRow>): List<PushResult> { calls++; return operations.mapIndexed { i,r -> PushResult(r.kind,r.clientRequestId,if(i==0) "rejected" else "conflict",code="conflict") } }
        }
        val sync=VanSync(store,backend); sync.syncNow(); sync.syncNow(); assertEquals(1,calls); assertEquals(setOf("rejected","conflict"),store.rows.values.map { it.status }.toSet()); Unit
    }
    @Test fun cancelledPushLeavesPendingAndKeepsAlreadyDurableAcks() = runBlocking {
        val store=Store().apply { enqueue(1) }
        val backend=object : VanGateway { override suspend fun bootstrap()=fixture(); override suspend fun push(operations: List<OutboxRow>): List<PushResult> { throw CancellationException() } }
        assertTrue(runCatching { VanSync(store,backend).syncNow() }.exceptionOrNull() is CancellationException); assertEquals("pending",store.rows.values.single().status); Unit
    }
    @Test fun cancellationAfterFirstAckKeepsItDurableAndResetsRemainingRows() = runBlocking {
        val store=Store(cancelAfterAcks=1).apply { repeat(3) { enqueue(it) } }
        val backend=object : VanGateway {
            override suspend fun bootstrap()=fixture()
            override suspend fun push(operations: List<OutboxRow>)=operations.map { PushResult(it.kind,it.clientRequestId,"accepted",PushAck("e",null,2)) }
        }
        assertTrue(runCatching { VanSync(store,backend).syncNow() }.exceptionOrNull() is CancellationException)
        assertEquals(1,store.acks.size); assertEquals(1,store.rows.values.count { it.status=="done" }); assertEquals(2,store.rows.values.count { it.status=="pending" }); Unit
    }
    @Test fun mismatchedResponseCannotAcknowledgeOtherWork() = runBlocking {
        val store=Store().apply { enqueue(1) }
        val backend=object : VanGateway { override suspend fun bootstrap()=fixture(); override suspend fun push(operations: List<OutboxRow>)=listOf(PushResult("trip.start",UUID.randomUUID().toString(),"accepted",PushAck("e",null,1))) }
        assertTrue(runCatching { VanSync(store,backend).syncNow() }.exceptionOrNull() is VanWireFailure); assertTrue(store.acks.isEmpty()); assertEquals("pending",store.rows.values.single().status); Unit
    }
}
