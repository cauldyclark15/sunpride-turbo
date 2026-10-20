package com.sunpride.van.ledger

import org.junit.Assert.*
import org.junit.Test

class FefoTest {
    private fun lot(id: String,expiry: Long?,qty: Long,quality: String="released",status: String="available")=BatchPosition("sku",id,"BATCH-$id",expiry,quality,status,qty)
    @Test fun `F-104 offline FEFO consumes earliest expiry and freezes exact allocations`() {
        val allocated=Fefo.allocate(listOf(lot("late",300,8),lot("early",200,3)),"sku",5,100)
        assertEquals(listOf("early","late"),allocated.map {it.lotId})
        assertEquals(listOf(3L,2L),allocated.map {it.quantityBase})
        assertEquals(listOf(200L,300L),allocated.map {it.expiresAt})
    }
    @Test fun `F-104 expires at the boundary and excludes quarantined and damaged stock`() {
        val rows=listOf(lot("expired",100,10),lot("held",500,10,"quarantined"),lot("damaged",500,10,status="damaged"),lot("good",200,2))
        assertEquals("good",Fefo.allocate(rows,"sku",2,100).single().lotId)
        assertThrows(IllegalStateException::class.java) {Fefo.allocate(rows,"sku",3,100)}
    }
    @Test fun `F-104 batches without expiry sort last and ties have deterministic identity order`() {
        val rows=listOf(lot("z",200,2),lot("a",200,2),lot("none",null,5))
        assertEquals(listOf("a","z","none"),Fefo.allocate(rows,"sku",5,100).map {it.lotId})
    }
    @Test fun `F-104 cannot sell a missing SKU or negative quantity`() {
        assertThrows(IllegalStateException::class.java) {Fefo.allocate(listOf(lot("x",300,100)),"foreign",1,100)}
        assertThrows(IllegalArgumentException::class.java) {Fefo.allocate(emptyList(),"sku",-1,100)}
    }
}
