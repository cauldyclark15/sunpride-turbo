package com.sunpride.van.scanning

import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SenraiseScannerBroadcastTest {
    @Test fun receivesExportedVendorBroadcast() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val scanner = SenraiseScanner(context)
        try {
            scanner.start()
            val received = async(start = CoroutineStart.UNDISPATCHED) {
                withTimeout(5_000) { scanner.scans.first() }
            }
            context.sendBroadcast(Intent(SenraiseScanner.ACTION).setPackage(context.packageName)
                .putExtra(SenraiseScanner.RESULT_EXTRA, "4800000000017"))
            val scan = received.await()
            assertEquals("4800000000017", scan.code)
            assertEquals(ScanSource.BROADCAST, scan.source)
        } finally { scanner.close() }
    }
}
