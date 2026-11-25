package com.sunpride.field

import android.content.Context
import com.sunpride.field.auth.SessionVaults
import com.sunpride.field.device.KeystoreDeviceKey
import com.sunpride.field.ui.LiveFieldBackend
import com.sunpride.integrity.PhoneSupportService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** One process-owned backend for the service and visible app; never retains an Activity or UI controller. */
object FieldPhoneSupport {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var current: LiveFieldBackend? = null
    @Synchronized fun backend(context: Context): LiveFieldBackend {
        val app = context.applicationContext
        return current ?: LiveFieldBackend(AppEnvironment(BuildConfig.SUNPRIDE_API_ORIGIN),
            SessionVaults.app(app), app) { KeystoreDeviceKey.loadOrCreate(app) }.also { current = it }
    }
    fun start(context: Context) {
        val app = context.applicationContext
        scope.launch {
            if (runCatching { backend(app).phoneSupportNeeded() }.getOrDefault(false))
                withContext(Dispatchers.Main) { PhoneSupportService.start(app, FieldPhoneSupportService::class.java) }
        }
    }
}

class FieldPhoneSupportService : PhoneSupportService() {
    override fun needed() = FieldPhoneSupport.backend(this).phoneSupportNeeded()
    override suspend fun checkPhone() {
        val backend = FieldPhoneSupport.backend(this)
        if (backend.phoneControls()) return
        // Waiting phones must also notice office registration while their screen is gone.
        if (backend.isSignedIn && backend.cachedDeviceId == null) backend.refreshEnrollment(backend.loadSigner())
    }
}
