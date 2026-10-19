package com.sunpride.field

import org.junit.Assert.*
import org.junit.Test

class AppEnvironmentTest {
    @Test fun validHttpsOrigin() {
        assertTrue(AppEnvironment("https://sunpride.cauldnclark.com").isReady)
        assertTrue(AppEnvironment("https://sunpride.cauldnclark.com/").isReady)
    }
    @Test fun emptyAndInvalidOrigins() {
        assertFalse(AppEnvironment("").isReady)
        assertFalse(AppEnvironment("http://sunpride.cauldnclark.com").isReady)
        assertFalse(AppEnvironment("https://sunpride.cauldnclark.com/path").isReady)
        assertFalse(AppEnvironment("https://sunpride.cauldnclark.com/?q=1").isReady)
        assertFalse(AppEnvironment("https://user:pass@sunpride.cauldnclark.com").isReady)
        assertFalse(AppEnvironment("not a url").isReady)
    }
    @Test fun errorNamesThePlainSetting() {
        assertTrue(AppEnvironment("").errors.single().startsWith("SUNPRIDE_API_ORIGIN"))
    }
    @Test fun localHttpOrigins() {
        assertTrue(AppEnvironment("http://10.0.2.2:3000").isReady)
        assertTrue(AppEnvironment("http://127.0.0.1:4380").isReady)
        assertFalse(AppEnvironment("http://192.168.1.1:3000").isReady)
    }
}
