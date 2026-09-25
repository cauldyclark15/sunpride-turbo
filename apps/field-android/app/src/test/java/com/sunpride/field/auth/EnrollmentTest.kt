package com.sunpride.field.auth

import com.sunpride.field.device.CryptoVectors
import com.sunpride.field.device.JcaDeviceSigner
import com.sunpride.field.device.KeyProtection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class EnrollmentTest {
    private val signer = JcaDeviceSigner(CryptoVectors.privateKey, CryptoVectors.publicKey, KeyProtection.TEE)
    private val vault = InMemorySessionVault()

    private class FakeApi(var record: DeviceRecord?) : DeviceApi {
        val calls = mutableListOf<String>()
        var lookedUpKey: String? = null
        var bindArgs: List<Any?>? = null
        var bindError: ConvexFunctionError? = null
        val serverNow = 1_780_000_000_000L
        override fun mine(publicKey: String): DeviceRecord? { calls += "mine"; lookedUpKey = publicKey; return record }
        override fun challenge(deviceId: String): Pair<String, Long> {
            calls += "challenge"; return "10000000-0000-4000-8000-00000000000a" to serverNow + 60_000
        }
        override fun bind(deviceId: String, credentialId: String, attestationFormat: String, keyId: String?,
                          nonce: String, timestamp: Long, proof: String) {
            calls += "bind"
            bindArgs = listOf(deviceId, credentialId, attestationFormat, keyId, nonce, timestamp, proof)
            bindError?.let { throw it }
            record = record!!.copy(bound = true)
        }
    }

    private fun enrollment(api: DeviceApi) = Enrollment(api, signer, vault, monotonicMillis = { 5L }, newCredentialId = { "cred-1" })

    @Test fun notFoundIsUnregisteredAndLooksUpExactSpki() {
        val api = FakeApi(null)
        vault.deviceId = "stale"
        assertEquals(EnrollmentState.Unregistered, enrollment(api).refresh())
        assertEquals(CryptoVectors.json.getString("publicKeySpkiBase64"), api.lookedUpKey)
        assertEquals(listOf("mine"), api.calls)
        assertNull(vault.deviceId)
    }

    @Test fun boundActiveIsReadyAndPersistsDeviceId() {
        val api = FakeApi(DeviceRecord("dev1", "active", true, "ANDROID"))
        assertEquals(EnrollmentState.Ready("dev1"), enrollment(api).refresh())
        assertEquals(listOf("mine"), api.calls)
        assertEquals("dev1", vault.deviceId)
    }

    @Test fun revokedOrSuspendedStops() {
        for (status in listOf("revoked", "suspended")) {
            val api = FakeApi(DeviceRecord("dev1", status, true, "ANDROID"))
            vault.deviceId = "dev1"
            assertEquals(EnrollmentState.Removed, enrollment(api).refresh())
            assertEquals(listOf("mine"), api.calls)
            assertNull(vault.deviceId)
        }
    }

    @Test fun registeredUnboundChallengesSignsBindsAndReadsBack() {
        val api = FakeApi(DeviceRecord("dev1", "active", false, "ANDROID"))
        assertEquals(EnrollmentState.Ready("dev1"), enrollment(api).refresh())
        assertEquals(listOf("mine", "challenge", "bind", "mine"), api.calls)
        val (deviceId, credential, format, keyId, nonce, timestamp, proof) = api.bindArgs!!.let {
            Septuple(it[0] as String, it[1] as String, it[2] as String, it[3] as String?, it[4] as String, it[5] as Long, it[6] as String)
        }
        assertEquals("dev1", deviceId); assertEquals("cred-1", credential)
        assertEquals("android-keystore-unverified", format); assertEquals("tee", keyId)
        assertEquals("10000000-0000-4000-8000-00000000000a", nonce)
        assertEquals("proof timestamp derives from server challenge time", api.serverNow, timestamp)
        val message = "BIND|dev1|cred-1|$nonce|$timestamp"
        assertTrue(CryptoVectors.verifyP1363(CryptoVectors.publicKey, message.toByteArray(), proof))
        assertEquals("dev1", vault.deviceId)
    }

    @Test fun alreadyBoundRaceIsResolvedByReadBack() {
        val api = FakeApi(DeviceRecord("dev1", "active", false, "ANDROID"))
        api.bindError = ConvexFunctionError("Device already bound or missing key")
        val wrapped = object : DeviceApi by api {
            override fun bind(deviceId: String, credentialId: String, attestationFormat: String, keyId: String?,
                              nonce: String, timestamp: Long, proof: String) {
                api.record = api.record!!.copy(bound = true) // the other attempt won
                api.bind(deviceId, credentialId, attestationFormat, keyId, nonce, timestamp, proof)
            }
        }
        assertEquals(EnrollmentState.Ready("dev1"), enrollment(wrapped).refresh())
    }

    @Test fun bindRejectionPropagatesAndDoesNotMarkReady() {
        val api = FakeApi(DeviceRecord("dev1", "active", false, "ANDROID"))
        api.bindError = ConvexFunctionError("Invalid device proof")
        vault.deviceId = null
        assertThrows(ConvexFunctionError::class.java) { enrollment(api).refresh() }
        assertNull(vault.deviceId)
    }

    @Test fun bindThatDoesNotStickIsAServerError() {
        val api = object : DeviceApi {
            override fun mine(publicKey: String) = DeviceRecord("dev1", "active", false, "ANDROID")
            override fun challenge(deviceId: String) = "10000000-0000-4000-8000-00000000000b" to 1L
            override fun bind(deviceId: String, credentialId: String, attestationFormat: String, keyId: String?,
                              nonce: String, timestamp: Long, proof: String) = Unit
        }
        AuthClientTest.expect(AuthFailure.Kind.SERVER) { enrollment(api).refresh() }
    }

    @Test fun wrongAppRecordIsTreatedAsUnregistered() {
        assertEquals(EnrollmentState.Unregistered, enrollment(FakeApi(DeviceRecord("d", "active", true, "IOS"))).refresh())
    }

    private data class Septuple<A, B, C, D, E, F, G>(val a: A, val b: B, val c: C, val d: D, val e: E, val f: F, val g: G)
}
