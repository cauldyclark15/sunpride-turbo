package com.sunpride.field.device

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.ProviderException
import java.security.spec.ECGenParameterSpec

/**
 * Non-exportable EC P-256 signing key in AndroidKeyStore: StrongBox when the device has it,
 * otherwise TEE (emulators may report Software). The alias survives activity/process recreation;
 * it is deleted only by uninstall or "clear data".
 */
object KeystoreDeviceKey {
    const val DEFAULT_ALIAS = "sunpride-field-device-p256-v1"
    private const val PROVIDER = "AndroidKeyStore"

    fun loadOrCreate(context: Context, alias: String = DEFAULT_ALIAS): JcaDeviceSigner {
        val store = KeyStore.getInstance(PROVIDER).apply { load(null) }
        if (!store.containsAlias(alias)) {
            val strongBox = context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)
            try { generate(alias, strongBox) }
            catch (e: StrongBoxUnavailableException) { generate(alias, false) }
            catch (e: ProviderException) { if (strongBox) generate(alias, false) else throw e }
        }
        val privateKey = store.getKey(alias, null) as PrivateKey
        val publicKey = store.getCertificate(alias).publicKey
        return JcaDeviceSigner(privateKey, publicKey, protectionOf(privateKey))
    }

    fun delete(alias: String) {
        KeyStore.getInstance(PROVIDER).apply { load(null) }.deleteEntry(alias)
    }

    private fun generate(alias: String, strongBox: Boolean) {
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(false)
            .apply { if (strongBox) setIsStrongBoxBacked(true) }
            .build()
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, PROVIDER).run {
            initialize(spec)
            generateKeyPair()
        }
    }

    private fun protectionOf(key: PrivateKey): KeyProtection {
        val info = KeyFactory.getInstance(key.algorithm, PROVIDER).getKeySpec(key, KeyInfo::class.java)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) when (info.securityLevel) {
            KeyProperties.SECURITY_LEVEL_STRONGBOX -> KeyProtection.STRONGBOX
            KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> KeyProtection.TEE
            else -> KeyProtection.SOFTWARE
        } else {
            @Suppress("DEPRECATION")
            if (info.isInsideSecureHardware) KeyProtection.TEE else KeyProtection.SOFTWARE
        }
    }
}
