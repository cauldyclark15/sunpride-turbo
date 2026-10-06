package com.sunpride.field

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** SP-0124: the beta feature list decides what each build shows. */
class FieldFeaturesTest {
    @Test fun betaReleaseShowsTheProductFeaturesAndHidesTheBetaList() {
        val beta = FieldFeatures.forBuild("beta", debug = false, webUrl = "")
        assertTrue(FieldFeature.VISITS in beta)
        assertTrue(FieldFeature.TEAM in beta)
        assertFalse(FieldFeature.UNPLANNED_VISITS in beta)
        assertFalse(FieldFeature.PHONE_KEY_DETAILS in beta)
        assertFalse(FieldFeature.DEVELOPER_TOOLS in beta)
        assertEquals(FieldFeature.entries.toSet() - FieldFeatures.HIDDEN_IN_BETA - FieldFeatures.DEVELOPER_ONLY,
            beta.enabled)
    }

    @Test fun developerToolsNeedADebuggableDevBuild() {
        assertEquals(FieldFeature.entries.toSet(), FieldFeatures.forBuild("dev", debug = true, webUrl = "").enabled)
        listOf("beta" to true, "dev" to false, "staging" to true, "prod" to false).forEach { (flavor, debug) ->
            assertFalse("$flavor/$debug", FieldFeature.DEVELOPER_TOOLS in FieldFeatures.forBuild(flavor, debug, ""))
            assertTrue("$flavor/$debug", FieldFeature.VISITS in FieldFeatures.forBuild(flavor, debug, ""))
        }
    }

    @Test fun hiddenEntriesAreNeverTheCoreVisitFlow() {
        assertFalse(FieldFeature.VISITS in FieldFeatures.HIDDEN_IN_BETA)
        assertFalse(FieldFeature.TEAM in FieldFeatures.HIDDEN_IN_BETA)
    }

    @Test fun reportAnIssueOpensTheWebTrackerOrIsHidden() {
        assertEquals("https://sfa.example.ph/issues/new", FieldFeatures.reportIssueUrl("https://sfa.example.ph"))
        assertEquals("https://sfa.example.ph/issues/new", FieldFeatures.reportIssueUrl(" https://sfa.example.ph/ "))
        assertEquals("http://192.168.1.20:3000/issues/new", FieldFeatures.reportIssueUrl("http://192.168.1.20:3000"))
        assertEquals("https://sfa.example.ph/issues/new",
            FieldFeatures.forBuild("beta", false, "https://sfa.example.ph").reportIssueUrl)
        listOf("", "   ", "sfa.example.ph", "javascript:alert(1)", "ftp://sfa.example.ph", "https://",
            "https://sfa.example.ph?x=1", "https://sfa.example.ph/#a", "https://sfa example.ph").forEach {
            assertNull(it, FieldFeatures.reportIssueUrl(it))
        }
        assertNull(FieldFeatures.forBuild("beta", false, "").reportIssueUrl)
    }
}
