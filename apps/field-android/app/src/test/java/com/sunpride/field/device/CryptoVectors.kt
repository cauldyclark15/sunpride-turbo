package com.sunpride.field.device

import org.json.JSONObject
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.PrivateKey
import java.security.PublicKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPrivateKeySpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

/** Frozen TEST-ONLY vectors read from packages/domain-contracts/fixtures/mobile-v1/crypto (test resources srcDir). */
object CryptoVectors {
    val json: JSONObject by lazy {
        val stream = checkNotNull(javaClass.classLoader!!.getResourceAsStream("request-proof.json")) {
            "request-proof.json missing: check the test resources srcDir in app/build.gradle.kts"
        }
        JSONObject(stream.bufferedReader(Charsets.UTF_8).readText())
    }
    val vectors: List<JSONObject> get() = (0 until json.getJSONArray("vectors").length()).map { json.getJSONArray("vectors").getJSONObject(it) }
    fun vector(name: String) = vectors.single { it.getString("name") == name }

    val publicKey: PublicKey by lazy {
        KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(unbase64(json.getString("publicKeySpkiBase64"))))
    }
    val privateKey: PrivateKey by lazy {
        val jwk = json.getJSONObject(json.keys().asSequence().single { it.startsWith("privateK") })
        val d = BigInteger(1, Base64.getUrlDecoder().decode(jwk.getString("d")))
        val params = AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }
            .getParameterSpec(ECParameterSpec::class.java)
        KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(d, params))
    }

    fun verifyP1363(publicKey: PublicKey, message: ByteArray, p1363Base64: String): Boolean =
        Signature.getInstance("SHA256withECDSA").run {
            initVerify(publicKey); update(message); verify(EcdsaEncoding.p1363ToDer(unbase64(p1363Base64)))
        }
}
