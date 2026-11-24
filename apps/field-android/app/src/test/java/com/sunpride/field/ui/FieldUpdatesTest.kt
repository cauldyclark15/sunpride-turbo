package com.sunpride.field.ui

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class FieldUpdatesTest {
    private val pkg = "com.sunpride.field.beta"
    private fun manifest(version: Int = 12, minimum: Int = 0, packageName: String = pkg, url: String = "https://drive.google.com/file/d/SAMPLE/view?usp=drivesdk") =
        JSONObject().put("app", "field").put("package_name", packageName).put("version_code", version)
            .put("version_name", "1.0.0-beta.$version").put("minimum_supported_version_code", minimum).put("download_url", url).toString()

    @Test fun onlyNewVersionsPromptAndOnlyIncompatibleVersionsBlock() {
        val info = FieldUpdateInfo.decode(manifest(), pkg, 10)!!
        assertFalse(info.required(10))
        assertNull(FieldUpdateInfo.decode(manifest(), pkg, 12))
        assertNull(FieldUpdateInfo.decode(manifest(), pkg, 13))
        assertNull(FieldUpdateInfo.decode("{\"release\":null}", pkg, 10))
        val required = FieldUpdateInfo.decode(manifest(minimum = 11), pkg, 10)!!
        assertTrue(required.required(10))
        assertFalse(required.required(11))
    }

    @Test fun wrongPackageInvalidFloorAndUntrustedLinksAreRejected() {
        for (raw in listOf(manifest(packageName = "com.sunpride.van.beta"), manifest(minimum = 13), manifest(minimum = -1),
            manifest(url = "http://drive.google.com/file/d/SAMPLE/view"), manifest(url = "https://evil.example/app.apk"),
            manifest(url = "https://drive.google.com.evil.example/file/d/SAMPLE/view"), manifest(url = "https://u:p@drive.google.com/file/d/SAMPLE/view"))) {
            assertThrows(IllegalArgumentException::class.java) { FieldUpdateInfo.decode(raw, pkg, 10) }
        }
    }

    @Test fun drivePublisherLinksKeepOnlyKnownSharingParameters() {
        for (suffix in listOf("", "?usp=drivesdk", "?usp=sharing")) {
            val url = "https://drive.google.com/file/d/SAMPLE/view$suffix"
            assertEquals(url, FieldUpdateInfo.decode(manifest(url = url), pkg, 10)!!.download)
        }
        for (url in listOf("https://drive.google.com/file/d/SAMPLE/view?redirect=bad",
            "https://drive.google.com/file/d/SAMPLE/view?usp=drivesdk&redirect=bad",
            "https://drive.google.com/file/d/SAMPLE/view?usp=drivesdk&usp=sharing",
            "https://drive.google.com/file/d/SAMPLE/view?usp=unknown",
            "https://sunpride.cauldnclark.com/downloads/field-12.apk?usp=drivesdk")) {
            assertThrows(IllegalArgumentException::class.java) { FieldUpdateInfo.decode(manifest(url = url), pkg, 10) }
        }
    }

    @Test fun realHttpCheckCachesMetadataWithoutCredentialsAndClearsWhenCurrent() {
        MockWebServer().use { web ->
            var saved: String? = null
            val client = FieldUpdateClient(web.url("/").toString(), pkg, 10, { saved }, { saved = it })
            assertNull(client.cached())
            web.enqueue(MockResponse().setBody(manifest()))
            assertEquals(12, client.check()!!.version)
            val request = web.takeRequest()
            assertEquals("/api/v1/apps/latest?app=field&packageName=$pkg", request.path)
            assertNull(request.getHeader("Authorization")); assertNull(request.getHeader("Cookie"))
            assertEquals(12, client.cached()!!.version)
            val upgraded = FieldUpdateClient(web.url("/").toString(), pkg, 12, { saved }, { saved = it })
            assertNull(upgraded.cached())
            web.enqueue(MockResponse().setBody("{\"release\":null}"))
            assertNull(client.check()); assertNull(client.cached())
        }
    }

    @Test fun connectionErrorsDoNotInventARequiredUpdateAndRetainVerifiedPolicy() = runBlocking {
        MockWebServer().use { web ->
            var saved: String? = null
            val client = FieldUpdateClient(web.url("/").toString(), pkg, 10, { saved }, { saved = it })
            val state = FieldUpdates(client, 10, Dispatchers.Unconfined)
            web.enqueue(MockResponse().setResponseCode(503))
            state.refresh()
            assertNull(state.info); assertFalse(state.required); assertFalse(state.visible)
            web.enqueue(MockResponse().setBody(manifest()))
            state.refresh()
            assertTrue(state.visible); assertFalse(state.required)
            state.dismiss(); assertFalse(state.visible)
            web.enqueue(MockResponse().setBody(manifest()))
            state.refresh(); assertFalse(state.visible) // Not a daily reminder after Not now in this session.
            web.enqueue(MockResponse().setBody(manifest(13, 11)))
            state.refresh()
            assertTrue(state.visible); assertTrue(state.required)
            state.dismiss(); assertTrue(state.visible)
            val reopened = FieldUpdates(client, 10, Dispatchers.Unconfined)
            assertTrue(reopened.required) // Cold/offline launch retains only the confirmed incompatibility.
            web.enqueue(MockResponse().setResponseCode(503))
            reopened.refresh(manual = true)
            assertTrue(reopened.required); assertNotNull(reopened.message)
            web.enqueue(MockResponse().setBody(manifest(13, 0)))
            reopened.refresh(); assertFalse(reopened.required)
        }
        Unit
    }

    @Test fun redirectsOversizeAndMalformedResponsesNeverReplaceLastGoodMetadata() {
        MockWebServer().use { web ->
            var saved: String? = manifest(minimum = 11)
            val original = saved
            val client = FieldUpdateClient(web.url("/").toString(), pkg, 10, { saved }, { saved = it })
            for (response in listOf(MockResponse().setResponseCode(302).setHeader("Location", "https://evil.example"),
                MockResponse().setBody("x".repeat(16_385)), MockResponse().setBody("{}"),
                MockResponse().setBody(manifest(packageName = "com.sunpride.field.prod")))) {
                web.enqueue(response)
                assertThrows(Exception::class.java) { client.check() }
                assertEquals(original, saved)
                assertTrue(client.cached()!!.required(10))
            }
        }
    }

    @Test fun playInstallsAlwaysOpenPlayAndOnlyDirectApkBuildsOfferDownload() {
        val info = FieldUpdateInfo.decode(manifest(), pkg, 10)!!
        assertEquals(PlayStoreUpdate.uris(pkg), DistributionUpdateLink.urls(pkg, info, true))
        assertEquals(if (DistributionUpdateLink.apk) listOf(info.download) else PlayStoreUpdate.uris(pkg),
            DistributionUpdateLink.urls(pkg, info, false))
        assertEquals(PlayStoreUpdate.uris(pkg), DistributionUpdateLink.urls(pkg, null, false))
    }
}
