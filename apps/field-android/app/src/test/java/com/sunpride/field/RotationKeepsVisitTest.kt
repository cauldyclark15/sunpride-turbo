package com.sunpride.field

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * FLD-174: the open visit, the page and typed text live in Compose `remember` state and the
 * controller. Rotating must not recreate MainActivity, or the phone jumps back to Today and the
 * note is lost. (Emulator proof: rotate on an open visit with a typed note.)
 */
class RotationKeepsVisitTest {
    private val main = listOf(File("src/main"), File("app/src/main")).first { it.isDirectory }

    @Test fun mainActivityHandlesRotationWithoutRecreation() {
        val manifest = File(main, "AndroidManifest.xml").readText()
        val activity = Regex("<activity[^>]*android:name=\"\\.MainActivity\"[^>]*>").find(manifest)?.value
            ?: error("MainActivity missing from the manifest")
        val handled = Regex("android:configChanges=\"([^\"]*)\"").find(activity)?.groupValues?.get(1)
            ?.split('|')?.toSet().orEmpty()
        for (change in listOf("orientation", "screenSize", "screenLayout", "smallestScreenSize", "keyboardHidden"))
            assertTrue("MainActivity must handle $change itself (FLD-174)", change in handled)
    }
}
