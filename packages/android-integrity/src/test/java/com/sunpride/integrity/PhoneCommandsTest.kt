package com.sunpride.integrity

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.util.UUID

/** Local protocol fixtures, not installed-phone evidence. Both Android apps compile and run this suite. */
class PhoneCommandsTest {
    private fun response(vararg commands: Pair<String, String>) = JSONObject().put("version",2)
        .put("commands",JSONArray(commands.map { (id,kind) -> JSONObject().put("id",id).put("kind",kind) }))

    @Test fun refreshResendAndUpdateAreAcknowledgedOnlyAfterTheirEffect() {
        for(kind in listOf("refresh","resend","update")) {
            val id=UUID.randomUUID().toString(); val events=mutableListOf<String>()
            PhoneCommands.run({ acks ->
                events.add(if(acks.length()==0) "pickup" else "ack")
                if(acks.length()==0) response(id to kind) else response()
            },{true},{events.add(it)})
            assertEquals(listOf("pickup",kind,"ack"),events)
        }
    }
    @Test fun failedEffectAndUnknownCommandStayWaiting() {
        val id=UUID.randomUUID().toString(); var acknowledgements=0
        val exchange: (JSONArray)->JSONObject = { acks -> if(acks.length()>0) acknowledgements++;response(id to "refresh") }
        assertTrue(runCatching { PhoneCommands.run(exchange,{true},{throw IOException("sample unavailable")}) }.isFailure)
        PhoneCommands.run({response(id to "future_command")},{true},{fail("Unknown action must not run")})
        assertEquals(0,acknowledgements)
    }
    @Test fun sessionChangeDuringDownloadNeverAppliesOrAcknowledges() {
        var current=true; var applied=false
        assertTrue(runCatching { PhoneCommands.run({ current=false;response(UUID.randomUUID().toString() to "refresh") },
            {current},{applied=true}) }.isFailure)
        assertFalse(applied)
    }
    @Test fun terminalReceiptSurvivesLostReplyAndNewProcessWithoutSigningOutNewSession() {
        for(kind in listOf("sign_out","remove")) {
            val id=UUID.randomUUID().toString();var session:String?="SAMPLE old session";var receipt:String?=null
            var applies=0
            assertTrue(PhoneCommands.runSession({ _,acks ->
                if(acks.length()>0) throw IOException("sample lost reply") else response(id to kind)
            },{session},{receipt},{receipt=it},{applies++;session=null}))
            assertNull(session);assertNotNull(receipt);assertEquals(1,applies)
            // These closures stand in for freshly reopened encrypted vaults after process death.
            session="SAMPLE new session"
            val sent=mutableListOf<String>()
            assertFalse(PhoneCommands.runSession({ token,acks ->
                sent.add(token)
                if(acks.length()>0) {assertEquals(id,acks.getString(0));response()} else response()
            },{session},{receipt},{receipt=it},{fail("A delayed old receipt must not sign out a newer session")}))
            assertEquals(listOf("SAMPLE old session","SAMPLE new session"),sent)
            assertNull(receipt);assertEquals("SAMPLE new session",session)
        }
    }
    @Test fun newerTerminalRequestDoesNotOverwriteAnOlderUnconfirmedReceipt() {
        val oldId=UUID.randomUUID().toString();val nextId=UUID.randomUUID().toString()
        var receipt:String?=JSONObject().put("id",oldId).put("kind","sign_out").put("session","SAMPLE old").toString()
        var session:String?="SAMPLE next"
        assertTrue(PhoneCommands.runSession({_,acks ->
            if(acks.length()>0) throw IOException("sample lost reply") else response(nextId to "remove")
        },{session},{receipt},{receipt=it},{session=null}))
        assertEquals(setOf(oldId,nextId),(0 until JSONArray(receipt).length()).map { JSONArray(receipt).getJSONObject(it).getString("id") }.toSet())
        val acked=mutableListOf<String>()
        assertFalse(PhoneCommands.runSession({_,acks -> acked+=acks.getString(0);response()},
            {session},{receipt},{receipt=it},{fail("Already signed out")}))
        assertEquals(setOf(oldId,nextId),acked.toSet());assertNull(receipt)
    }
    @Test fun processDeathBeforeTerminalEffectFinishesIsRecoveredBeforeAcknowledgement() {
        val id=UUID.randomUUID().toString();var session:String?="SAMPLE session"
        var receipt:String?=JSONObject().put("id",id).put("kind","sign_out").put("session",session).toString()
        assertTrue(PhoneCommands.runSession({_,acks -> assertNull(session);assertEquals(id,acks.getString(0));response()},
            {session},{receipt},{receipt=it},{session=null}))
        assertNull(receipt)
    }
    @Test fun failedReceiptStoragePreventsUnrecoverableTerminalEffect() {
        var applied=false
        assertTrue(runCatching { PhoneCommands.runSession({_,_ -> response(UUID.randomUUID().toString() to "sign_out")},
            {"SAMPLE session"},{null},{throw IOException("sample storage failure")},{applied=true}) }.isFailure)
        assertFalse(applied)
    }
    @Test fun aTerminalEffectWhichLeavesTheSessionOpenIsNeverAcknowledged() {
        var receipt:String?=null;var acked=false
        assertTrue(runCatching { PhoneCommands.runSession({_,acks -> if(acks.length()>0) acked=true;response(UUID.randomUUID().toString() to "remove")},
            {"SAMPLE session"},{receipt},{receipt=it},{}) }.isFailure)
        assertFalse(acked);assertNotNull(receipt)
    }
}
