package com.sunpride.van.storage

import org.junit.Assert.*
import org.junit.Test

class OutboxRulesTest {
    @Test fun transportUncertaintyReplaysAndNeverDeletesWork() { assertEquals("sending",OutboxRules.sending("pending")); assertEquals("pending",OutboxRules.interrupted("sending")) }
    @Test fun ackMustExistBeforeDone() { assertThrows(IllegalStateException::class.java) { OutboxRules.acknowledge("sending",false) }; assertEquals("done",OutboxRules.acknowledge("sending",true)); assertEquals("done",OutboxRules.acknowledge("done",true)) }
    @Test fun businessRefusalsStayFrozen() { for(s in listOf("rejected","conflict")) { assertEquals(s,OutboxRules.interrupted(s)); assertEquals(s,OutboxRules.sending(s)); assertEquals(s,OutboxRules.reject("sending",s)); assertThrows(IllegalStateException::class.java) { OutboxRules.acknowledge(s,true) } } }
}
