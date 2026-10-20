package com.sunpride.van.evidence

import org.junit.Assert.*
import org.junit.Test

class DamagePhotoPermissionsTest {
    @Test fun F312_executionPhotoNeedsCameraAndPreciseLocationWithoutEnablingTripSharing() {
        assertFalse(executionPhotoPermissionsGranted(true,false,true))
        assertFalse(executionPhotoPermissionsGranted(false,true,true))
        assertTrue(executionPhotoPermissionsGranted(true,true,true))
    }
    @Test fun F312_onlyExplicitSamplePracticeMayUseCameraWithoutLocation() {
        assertTrue(executionPhotoPermissionsGranted(true,false,false))
        assertFalse(executionPhotoPermissionsGranted(false,false,false))
    }
}
