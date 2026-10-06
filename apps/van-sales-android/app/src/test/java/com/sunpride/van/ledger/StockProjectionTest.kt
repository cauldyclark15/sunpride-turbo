package com.sunpride.van.ledger

import com.sunpride.van.storage.*
import org.junit.Assert.*
import org.junit.Test

class StockProjectionTest {
    private fun movement(type: MovementType, qty: Long, status: String = "available") = MovementRow("a","d",type.name+status,"t","p",type.name,status,qty,null,"request",1)
    @Test fun allSixMovementTypesUseSignedIntegerMath() {
        val baseline = listOf(BaselineRow("a","d","t","p","available",20,10))
        val m = listOf(movement(MovementType.LOAD,100),movement(MovementType.SALE,-30),movement(MovementType.RETURN,5),movement(MovementType.DAMAGE,-2),movement(MovementType.DAMAGE,2,"damaged"),movement(MovementType.TRANSFER,-10),movement(MovementType.ADJUSTMENT,3))
        val p = StockProjection.project(baseline,m,emptySet()).single()
        assertEquals(86L,p.availableBase); assertEquals(2L,p.damagedBase)
    }
    @Test fun onlyAckPlusStrictlyLaterBootstrapSettles() {
        assertFalse(StockProjection.reflected(null,11)); assertFalse(StockProjection.reflected(10,10)); assertFalse(StockProjection.reflected(10,9)); assertTrue(StockProjection.reflected(10,11))
        val sale = movement(MovementType.SALE,-3)
        assertEquals(7L,StockProjection.project(listOf(BaselineRow("a","d","t","p","available",10,10)),listOf(sale),emptySet()).single().availableBase)
        assertEquals(7L,StockProjection.project(listOf(BaselineRow("a","d","t","p","available",7,11)),listOf(sale),setOf(sale.movementId)).single().availableBase)
    }
    @Test fun negativePolicyIsOffUnlessExplicitlyEnabled() {
        assertFalse(StockProjection.canRemove(1,2,false)); assertTrue(StockProjection.canRemove(1,2,true)); assertTrue(StockProjection.canRemove(2,2,false)); assertFalse(StockProjection.canRemove(2,0,true))
    }
    @Test fun overflowNeverWrapsStock() {
        assertThrows(ArithmeticException::class.java) { StockProjection.project(listOf(BaselineRow("a","d","t","p","available",Long.MAX_VALUE,1)),listOf(movement(MovementType.LOAD,1)),emptySet()) }
    }
}
