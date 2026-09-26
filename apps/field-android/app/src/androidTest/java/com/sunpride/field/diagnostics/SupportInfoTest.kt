package com.sunpride.field.diagnostics

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.field.ui.syncstatus.SyncStatus
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SupportInfoTest {
    @Test fun handleIsStableAndSupportCopyIsFixedFieldOnly() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val info = SupportInfo(context)
        assertEquals(info.handle, SupportInfo(context).handle)
        val text = info.text(SyncStatus(queued = 1, review = 1,
            health = "Bearer secret seller@example.test name: Private Person"))
        assertTrue(text.contains("Queued: 1"))
        assertTrue(text.contains(info.handle))
        assertTrue(text.contains("Last outcome: unknown"))
        for (secret in listOf("secret", "seller@example.test", "Private Person", "publicKey", "deviceId"))
            assertFalse(text.contains(secret))
    }
}
