package com.sunpride.catalogue

import org.junit.Assert.*
import org.junit.Test
import java.math.BigDecimal

class TargetProgressTextTest {
    private fun row(unit:String,target:Long?,actual:Long?,prior:Long?,status:String)=
        TargetMeasure("calls","Calls",unit,target?.let(::BigDecimal),actual?.let(::BigDecimal),prior?.let(::BigDecimal),null,status,"Ask the office",null)
    @Test fun pesosDropWholeCentsAndKeepThousands(){
        assertEquals("₱0",TargetProgressText.value(BigDecimal.ZERO,"centavos"))
        assertEquals("₱354,895.51",TargetProgressText.value(BigDecimal(35489551),"centavos"))
        assertEquals("₱500,000",TargetProgressText.value(BigDecimal(50000000),"centavos"))
        assertEquals("₱12.50",TargetProgressText.value(BigDecimal(1250),"centavos"))
        assertEquals("1,200",TargetProgressText.big(BigDecimal(1200),"stores"))
    }
    @Test fun plainUnitWords(){
        assertEquals("212 products in stores",TargetProgressText.value(BigDecimal(212),"store-SKU points"))
        assertEquals("41 stores",TargetProgressText.value(BigDecimal(41),"stores"))
    }
    @Test fun noTargetHasNoBarStatusOrTargetLine(){
        val r=row("calls",null,0,96,"not_set")
        assertNull(TargetProgressText.fraction(r));assertNull(TargetProgressText.target(r));assertNull(TargetProgressText.status(r))
    }
    @Test fun targetGivesProgressAndPlainStatus(){
        val r=row("calls",120,30,null,"behind")
        assertEquals(0.25f,TargetProgressText.fraction(r)!!,0.001f);assertEquals("of 120 calls",TargetProgressText.target(r));assertEquals("Behind",TargetProgressText.status(r))
        assertEquals("On track",TargetProgressText.status(row("calls",10,9,null,"on_pace")))
        assertEquals("On track",TargetProgressText.status(row("calls",10,12,null,"on_target")))
        assertEquals(1f,TargetProgressText.fraction(row("calls",10,12,null,"on_target"))!!,0f)
        assertNull(TargetProgressText.status(row("calls",10,1,null,"unknown")))
    }
    @Test fun priorBecomesOneShortLine(){
        assertEquals("Last month ₱354,896",TargetProgressText.lastMonth(row("centavos",null,0,35489551,"not_set")))
        assertNull(TargetProgressText.lastMonth(row("calls",null,0,null,"not_set")))
    }
    @Test fun humanDate(){assertEquals("Updated Nov 9",TargetProgressText.updated("2026-11-09"))}
}
