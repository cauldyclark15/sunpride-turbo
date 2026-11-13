package com.sunpride.field

import com.sunpride.integrity.DeviceIntegrity
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** FLD-066: only the opt-in DEV e2e bench accepts a mock location; beta/staging/prod never do. */
class FieldMockLocationBuildTest {
    @Test fun betaAndOtherFlavorsNeverAcceptMockLocationsAndTheFixIsRejected() {
        val gradle = File("build.gradle.kts").readText()
        val beta = gradle.substringAfter("create(\"beta\") {").substringBefore("\n        }")
        assertTrue(beta.contains("buildConfigField(\"boolean\", \"E2E_MOCK_LOCATION\", \"false\")"))
        assertTrue(gradle.contains("buildConfigField(\"boolean\", \"E2E_MOCK_LOCATION\", (name == \"dev\" && e2eMockLocation).toString())"))
        assertTrue(gradle.contains("providers.gradleProperty(\"SUNPRIDE_E2E_MOCK_LOCATION\").orNull == \"true\""))
        // A normal (gate) dev build without the bench property refuses mock fixes too.
        if (System.getProperty("sunpride.e2eMock") == null) assertFalse(BuildConfig.E2E_MOCK_LOCATION)
        assertTrue(DeviceIntegrity.reportedMock(raw = true, benchTestProvider = false))
        assertFalse(DeviceIntegrity.reportedMock(raw = false, benchTestProvider = false))
    }
}
