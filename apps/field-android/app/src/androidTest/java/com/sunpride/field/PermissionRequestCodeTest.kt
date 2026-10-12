package com.sunpride.field

import androidx.core.app.ActivityCompat
import androidx.fragment.app.FragmentActivity
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Test
import org.junit.runner.RunWith

/**
 * SP-0140 (release smoke on the Redmi): the location prompt crashed the app ("Can only use lower
 * 16 bits for requestCode") because biometric 1.1.0 pulled fragment 1.2.5, whose FragmentActivity
 * (MainActivity's base, SP-0128) rejects the request codes androidx.activity's permission launchers
 * generate (always above 0xFFFF). [ActivityCompat.requestPermissions] runs exactly this check first.
 */
@RunWith(AndroidJUnit4::class)
class PermissionRequestCodeTest {
    @Test fun fragmentActivityAcceptsPermissionLauncherRequestCodes() {
        var failure: Throwable? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            failure = runCatching {
                val activity: FragmentActivity = object : FragmentActivity() {}
                (activity as? ActivityCompat.RequestPermissionsRequestCodeValidator)
                    ?.validateRequestPermissionsRequestCode(0x1_0007) // androidx.activity codes start at 0x10000
            }.exceptionOrNull()
        }
        failure?.let { throw AssertionError("A permission launcher request code is rejected", it) }
    }
}
