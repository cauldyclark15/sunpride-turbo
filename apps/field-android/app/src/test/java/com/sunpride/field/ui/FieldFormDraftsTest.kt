package com.sunpride.field.ui

import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class FieldFormDraftsTest {
    @Test fun unfinishedFormsRoundTripThroughDiskWithoutPostingAnyDomainOperation() = runBlocking {
        val folder=File(System.getenv("TMPDIR") ?: System.getProperty("java.io.tmpdir"))
        for (kind in listOf("visit","order","activity","photo","remittance","customer-edit","collector")) {
            val file=File.createTempFile("sp241-$kind-",".json",folder)
            try {
                file.delete()
                val state=FormDraftState({if(file.exists())file.readText() else null},{if(it==null)file.delete() else file.writeText(it)})
                state.load { fail("A new form has no saved answer") }
                val incomplete=JSONObject().put("amount","12.").put("person","").put("choice","")
                    .put("photo",JSONObject.NULL).put("unknownOption","Typed place")
                state.save(incomplete)
                assertTrue(state.message!!.startsWith("Draft saved"))
                var restored:JSONObject?=null
                val reopened=FormDraftState({file.readText()},{if(it==null)file.delete() else file.writeText(it)})
                reopened.load { restored=it }
                val fields=incomplete.keys().asSequence().toList()
                assertEquals(fields.toSet(),restored!!.keys().asSequence().toSet())
                fields.forEach { assertEquals(incomplete.opt(it),restored!!.opt(it)) }
                reopened.clear();assertFalse(file.exists())
            } finally { file.delete() }
        }
        Unit
    }
    @Test fun failedWritesRetainThePreviousDraftAndDoNotClaimSuccess() = runBlocking {
        var disk:String?=null;var failWrite=false
        val state=FormDraftState({disk},{if(failWrite)error("storage unavailable") else disk=it})
        state.load {}
        state.save(JSONObject().put("text","first"));val before=disk
        failWrite=true
        state.save(JSONObject().put("text","second"))
        assertEquals(before,disk);assertTrue(state.message!!.startsWith("Could not save"))
        failWrite=false;state.save(JSONObject().put("text","second"))
        assertEquals("second",JSONObject(disk!!).getString("text"))
        Unit
    }
    @Test fun unreadableOrCorruptStorageCannotBeOverwrittenAsAnEmptyForm() = runBlocking {
        var writes=0
        val state=FormDraftState({"broken"},{writes++})
        state.load {};assertFalse(state.loaded)
        state.save(JSONObject());assertEquals(0,writes)
        assertThrows(IllegalArgumentException::class.java) { FieldFormDrafts.encode(JSONObject().put("photo","x".repeat(FieldFormDrafts.MAX_BYTES+1))) }
        Unit
    }
}
