package com.sunpride.field.device

import java.security.PrivateKey
import java.security.PublicKey
import java.security.Signature

/** Where the private key lives, reported in diagnostics and bind metadata (unverified). */
enum class KeyProtection(val label: String) { STRONGBOX("StrongBox"), TEE("TEE"), SOFTWARE("Software") }

/** A P-256 device key. Implementations never expose private key material. */
interface DeviceSigner {
    /** DER SubjectPublicKeyInfo, exactly the bytes the admin registers (base64). */
    val publicKeySpki: ByteArray
    val protection: KeyProtection
    /** Raw JCA DER signature over [message]. */
    fun signDer(message: ByteArray): ByteArray

    val publicKeyBase64: String get() = base64(publicKeySpki)
    /** Standard base64 of the 64-byte P1363 `r||s` signature of the UTF-8 [message]. */
    fun sign(message: String): String =
        base64(EcdsaEncoding.derToP1363(signDer(message.toByteArray(Charsets.UTF_8))))
}

/** JCA signer over an existing key pair (Keystore-backed on device, plain keys in JVM tests). */
open class JcaDeviceSigner(
    private val privateKey: PrivateKey,
    publicKey: PublicKey,
    override val protection: KeyProtection
) : DeviceSigner {
    override val publicKeySpki: ByteArray = publicKey.encoded
    override fun signDer(message: ByteArray): ByteArray = Signature.getInstance("SHA256withECDSA").run {
        initSign(privateKey)
        update(message)
        sign()
    }
}
