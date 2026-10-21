package com.sunpride.field.auth

import com.sunpride.integrity.replacementPairingBody
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ReplacementPairingTest {
 @Test fun F007_pairingSignsTheExactAppKeyAndTimestampWithoutSendingPrivateMaterial() {
  var signed=""
  val body=replacementPairingBody("field-android",JSONObject().put("keyId","sample-key").put("publicKeySpki","sample-public"),{signed=it;"sample-signature"},1234)
  assertEquals("PAIR|field-android|sample-key|1234",signed)
  assertEquals("sample-public",body.getString("publicKeySpki"))
  assertEquals("sample-signature",body.getString("signature"))
  assertEquals(1234L,body.getLong("timestamp"))
  assertEquals(setOf("publicKeySpki","signature","timestamp"),body.keys().asSequence().toSet())
 }
}
