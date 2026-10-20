package com.sunpride.field.census

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

class CensusConfigCacheTest {
    private class Offline:IOException()
    private class Refused:RuntimeException()
    private class Cache {
        var row:String?=null
        var grant:String?="snapshot-one:session-one"
        var epoch=0L
        var now=100L
        var writable=true
        fun load(fetch:()->String):String?=CensusConfigCache.load(now,{epoch},{grant},{row},
            {check(writable);row=null},{check(writable);row=it},fetch,{it is Offline})
        fun seed(){load { "{\"batches\":[]}" }}
    }
    @Test fun f011offlineRestoresTheOriginalAuthorizedTimeAndSurvivesReopen(){
        val c=Cache();c.seed();val saved=c.row;c.now=200
        assertNotNull(c.load {throw Offline()});assertEquals(saved,c.row)
        assertEquals(100L,JSONObject(c.row!!).getLong("savedAt"))
        val reopened=Cache().also {it.row=c.row;it.now=300}
        assertNotNull(reopened.load {throw Offline()})
    }
    @Test fun f011preflightFailureReturnsNoDataAndNeverCallsTheServer(){
        val c=Cache();c.seed();c.writable=false;var called=false
        assertThrows(IllegalStateException::class.java){c.load {called=true;throw Refused()}}
        assertFalse(called);assertNotNull(c.row)
        assertThrows(IllegalStateException::class.java){c.load {throw Offline()}}
    }
    @Test fun f011denialCannotRestoreReadableOldDataWhenSubsequentWritesFail(){
        val c=Cache();c.seed()
        assertThrows(Refused::class.java){c.load {c.writable=false;throw Refused()}}
        assertNull(c.row)
        val reopened=Cache().also {it.row=c.row}
        assertNull(reopened.load {throw Offline()})
    }
    @Test fun f011renewingADifferentSnapshotOrSessionDoesNotRenewThisProjection(){
        val c=Cache();c.seed();val old=c.row;c.grant="snapshot-two:session-one"
        assertNull(c.load {throw Offline()})
        c.row=old;c.grant="snapshot-one:session-two"
        assertNull(c.load {throw Offline()})
        assertNotNull(c.load {"{\"batches\":[]}"})
    }
    @Test fun f011oldSuccessCannotPublishAcrossScopeAtoBtoAOrAnEndedSession(){
        val c=Cache();c.seed()
        assertThrows(IllegalStateException::class.java){c.load {c.epoch+=2;"{\"batches\":[]}"}}
        assertNull(c.row)
        assertNull(c.load {throw Offline()})
    }
    @Test fun f011aChangedGrantAfterTransportCannotBeSavedOrPublished(){
        val c=Cache();c.seed()
        assertThrows(IllegalStateException::class.java){c.load {c.grant="snapshot-two:session-two";"{\"batches\":[]}"}}
        assertNull(c.row)
    }
    @Test fun f011heldExpiredOrUnverifiedPartitionsDoNotReadOrFetch(){
        val c=Cache();c.seed();c.grant=null;var called=false
        assertNull(c.load {called=true;"{}"});assertFalse(called)
    }
    @Test fun f011overlappingRequestsAreSingleFlightAndLaterRefusalWins(){
        val c=Cache();c.seed()
        val firstEntered=CountDownLatch(1);val release=CountDownLatch(1)
        val active=AtomicInteger();val maximum=AtomicInteger();val failure=AtomicReference<Throwable?>()
        fun enter(){val n=active.incrementAndGet();maximum.updateAndGet { maxOf(it,n) }}
        val first=Thread {try {c.load {enter();firstEntered.countDown();check(release.await(5,TimeUnit.SECONDS));active.decrementAndGet();"{\"batches\":[]}"}}catch(t:Throwable){failure.set(t)}}
        val second=Thread {try {c.load {enter();active.decrementAndGet();throw Refused()};failure.set(AssertionError("Expected refusal"))}catch(_:Refused){}catch(t:Throwable){failure.set(t)}}
        first.start();assertTrue(firstEntered.await(5,TimeUnit.SECONDS));second.start()
        val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(5)
        while(second.state!=Thread.State.BLOCKED&&second.isAlive&&System.nanoTime()<deadline)Thread.yield()
        try {assertEquals(Thread.State.BLOCKED,second.state)}finally {release.countDown()}
        first.join(5000);second.join(5000);assertFalse(first.isAlive);assertFalse(second.isAlive)
        failure.get()?.let {throw it};assertEquals(1,maximum.get());assertNull(c.row)
        assertNull(c.load {throw Offline()})
    }
}
