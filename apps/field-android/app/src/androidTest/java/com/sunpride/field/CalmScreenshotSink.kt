package com.sunpride.field

import android.graphics.Bitmap
import androidx.test.platform.app.InstrumentationRegistry
import java.io.ByteArrayOutputStream
import java.net.Socket

/**
 * Emulator-only screenshot transfer to a local receiver; no app data or network API involved.
 * Opt-in: runs only with `-Pandroid.testInstrumentationRunnerArguments.calmScreenshots=true`,
 * so the normal connected suite never depends on a host-side receiver.
 */
fun captureCalmScreenshot(name: String) {
    if (InstrumentationRegistry.getArguments().getString("calmScreenshots") != "true") return
    val shot = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
    val bytes = ByteArrayOutputStream().also { shot.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    shot.recycle()
    Socket("10.0.2.2", 28765).use { socket ->
        val stream = socket.getOutputStream()
        stream.write("$name\n${bytes.size}\n".toByteArray(Charsets.UTF_8))
        stream.write(bytes)
        stream.flush()
        check(socket.getInputStream().read() == 1) { "Screenshot transfer failed" }
    }
}
