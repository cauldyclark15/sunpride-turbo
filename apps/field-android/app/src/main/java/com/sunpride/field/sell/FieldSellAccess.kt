package com.sunpride.field.sell

import com.sunpride.field.AppEnvironment
import com.sunpride.field.auth.AuthClient
import com.sunpride.field.auth.SessionVault
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.RequestSigner
import com.sunpride.field.sell.auth.AuthFailure
import com.sunpride.field.sell.auth.SellAccess
import java.util.Base64

/**
 * SP-0192: the Field session lent to the Sell area. The same AuthClient (session in the Field vault, one access token in
 * memory), the same registered phone and device key; the Field app's failures are handed over in the Sell area's words.
 */
class FieldSellAccess(private val environment: AppEnvironment, private val auth: AuthClient, private val vault: SessionVault,
    private val signerLoader: () -> DeviceSigner, private val key: () -> String?) : SellAccess {
    override val siteUrl: String get() = environment.apiOrigin
    override val ready: Boolean get() = environment.isReady
    override val isSignedIn: Boolean get() = auth.isSignedIn
    override fun sessionKey(): String? = key()
    override fun accessToken(refresh: Boolean): String = try { auth.accessToken(refresh) } catch (e: com.sunpride.field.auth.AuthFailure) { throw translate(e) }
    override fun invalidateAccessToken() = auth.invalidateAccessToken()
    override fun deviceId(): String? = vault.deviceId
    override fun signer(): DeviceSigner = signerLoader()
    override fun deviceKeyId(): String? = RequestSigner.bodyDigest(Base64.getDecoder().decode(signerLoader().publicKeyBase64))
    override fun passwordChangeRequired() { com.sunpride.field.auth.PasswordChange.requiredSink?.invoke(true) }
    companion object {
        /** Same failure, the Sell area's kind (by name; anything unknown is a server problem, never a sign-out). */
        fun translate(e: com.sunpride.field.auth.AuthFailure): AuthFailure =
            AuthFailure(AuthFailure.Kind.entries.firstOrNull { it.name == e.kind.name } ?: AuthFailure.Kind.SERVER, removed = e.removed)
    }
}
