package com.sunpride.field

import org.junit.Assert.*
import org.junit.Test

class AppEnvironmentTest {
    @Test fun validHttpsOrigins() {
        assertTrue(AppEnvironment("https://team.convex.site", "https://team.convex.cloud").isReady)
    }
    @Test fun emptyAndInvalidOrigins() {
        assertFalse(AppEnvironment("", "https://team.convex.cloud").isReady)
        assertFalse(AppEnvironment("https://team.convex.site", "").isReady)
        assertFalse(AppEnvironment("http://team.convex.site", "https://team.convex.cloud").isReady)
        assertFalse(AppEnvironment("https://team.convex.site/path", "https://team.convex.cloud").isReady)
        assertFalse(AppEnvironment("https://evil.test", "https://team.convex.cloud").isReady)
        assertFalse(AppEnvironment("https://user:pass@team.convex.site", "https://team.convex.cloud").isReady)
    }
    @Test fun localHttpOrigins() {
        assertTrue(AppEnvironment("http://10.0.2.2:3000", "http://localhost:3210").isReady)
        assertFalse(AppEnvironment("http://192.168.1.1:3000", "http://localhost:3210").isReady)
    }
}
