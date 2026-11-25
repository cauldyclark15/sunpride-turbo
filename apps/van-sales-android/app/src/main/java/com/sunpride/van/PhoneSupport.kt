package com.sunpride.van

import android.content.Context
import com.sunpride.integrity.PhoneSupportService
import com.sunpride.van.data.VanRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Production repository lives with the process, not the Activity. Practice fixtures keep their old lifetime. */
object VanPhoneSupport {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var current: VanRepository? = null
    @Synchronized fun repository(context: Context): VanRepository = current
        ?: VanRepository.create(context.applicationContext).also { current = it }
    fun start(context: Context, repository: VanRepository) {
        val app = context.applicationContext
        if (repository !== current) return // Never start live support for an injected/practice repository.
        scope.launch {
            if (runCatching { repository.phoneSupportNeeded() }.getOrDefault(false))
                withContext(Dispatchers.Main) { PhoneSupportService.start(app, VanPhoneSupportService::class.java) }
        }
    }
}

class VanPhoneSupportService : PhoneSupportService() {
    override fun needed() = VanPhoneSupport.repository(this).phoneSupportNeeded()
    override suspend fun checkPhone() { VanPhoneSupport.repository(this).backgroundPhoneCheck() }
}
