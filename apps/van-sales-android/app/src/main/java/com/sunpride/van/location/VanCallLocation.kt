package com.sunpride.van.location

import android.content.Context
import com.sunpride.callflow.AndroidCallLocation
import com.sunpride.van.BuildConfig

/**
 * NF-3: the van call flow's location capture. It passes the build's E2E_MOCK_LOCATION switch (true only in an
 * opted-in dev build) like every other van location reader, so the bench's adb test provider is accepted there
 * and still refused by prod, staging and beta.
 */
object VanCallLocation {
    val benchTestProvider: Boolean get() = BuildConfig.E2E_MOCK_LOCATION
    suspend fun capture(context: Context) = AndroidCallLocation.capture(context, benchTestProvider)
}
