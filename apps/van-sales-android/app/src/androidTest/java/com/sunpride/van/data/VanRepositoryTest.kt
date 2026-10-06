package com.sunpride.van.data

import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.van.auth.EnrollmentState
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.first
import org.junit.Assert.*
import org.junit.Test

class VanRepositoryTest {
    @Test fun debugRepositoryRestoresAndBootstrapsWithoutAnyConfiguredServer() = runBlocking {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        // Same real factory used by WorkManager, with scheduling disabled to keep the device test deterministic.
        val repository=VanRepository.forWorker(context,true)
        try {
            repository.restoreSession()
            assertTrue(repository.sessionState.value.signedIn)
            assertTrue(repository.enrollmentState.value is EnrollmentState.Ready)
            repository.syncNow()
            assertNotNull(repository.currentTrip.first()); assertEquals(2,repository.products.first().size)
            assertTrue(repository.policy.first()!!.walkInAllowed)
            assertEquals(3,repository.customers.first().count { !it.localOnly })
            assertNotNull(repository.syncStatus.first().lastSyncTime)
        } finally { repository.close() }; Unit
    }
}
