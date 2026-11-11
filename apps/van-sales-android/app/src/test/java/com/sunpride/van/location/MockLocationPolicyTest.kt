package com.sunpride.van.location

import com.sunpride.van.BuildConfig
import com.sunpride.integrity.DeviceIntegrity
import org.junit.Assert.*
import org.junit.Test

/** Only an opted-in dev build accepts adb's test location provider; every other build reports it as a mock. */
class MockLocationPolicyTest {
    @Test fun onlyTheBenchSwitchClearsAMockSignal() {
        assertTrue(DeviceIntegrity.reportedMock(raw = true, benchTestProvider = false))
        assertFalse(DeviceIntegrity.reportedMock(raw = true, benchTestProvider = true))
        assertFalse(DeviceIntegrity.reportedMock(raw = false, benchTestProvider = false))
    }
    @Test fun releaseFlavorsStillRejectMockLocations() {
        if (BuildConfig.FLAVOR != "dev") {
            assertFalse("${BuildConfig.FLAVOR} must never accept a mock location", BuildConfig.E2E_MOCK_LOCATION)
            assertTrue(DeviceIntegrity.reportedMock(true, BuildConfig.E2E_MOCK_LOCATION))
        }
    }
}
