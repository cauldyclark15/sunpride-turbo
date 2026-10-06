package com.sunpride.van

import org.junit.Assert.*
import org.junit.Test

class VanFeaturesTest {
    @Test fun releaseBuildsHideSellingPreviewAndDeveloperTools() {
        val beta = VanFeatures.forBuild(debug = false, webUrl = "")
        assertFalse(VanFeature.SELLING_PREVIEW in beta)
        assertFalse(VanFeature.DEVELOPER_TOOLS in beta)
        assertNull(beta.reportIssueUrl)
    }

    @Test fun debugBuildsKeepEverything() {
        val dev = VanFeatures.forBuild(debug = true, webUrl = "")
        assertEquals(VanFeature.entries.toSet(), dev.enabled)
        assertEquals(VanFeatures.ALL.enabled, dev.enabled)
    }

    @Test fun reportIssueOpensTheWebIssueForm() {
        assertEquals("https://beta.sunpride.example/issues/new",
            VanFeatures.forBuild(false, " https://beta.sunpride.example/ ").reportIssueUrl)
        assertEquals("https://beta.sunpride.example/app/issues/new",
            VanFeatures.reportIssueUrl("https://beta.sunpride.example/app"))
        assertEquals("http://localhost:3000/issues/new", VanFeatures.reportIssueUrl("http://localhost:3000"))
    }

    @Test fun reportIssueHiddenForBlankOrUnsafeUrls() {
        listOf("", "   ", "beta.sunpride.example", "http://beta.sunpride.example", "ftp://x.example",
            "https://user:pw@x.example", "https://x.example?a=1", "https://x.example#top", "https://x .example",
            "javascript:alert(1)").forEach { assertNull(it, VanFeatures.reportIssueUrl(it)) }
    }
}
