package com.sunpride.field

import android.graphics.Bitmap
import androidx.test.platform.app.InstrumentationRegistry
import java.io.ByteArrayOutputStream
import java.net.Socket

/**
 * Screenshot transfer to a local receiver; no app data or network API involved.
 * Opt-in: runs only with `-Pandroid.testInstrumentationRunnerArguments.calmScreenshots=true`,
 * so the normal connected suite never depends on a host-side receiver. The emulator reaches the host at
 * 10.0.2.2; on a physical phone pass `calmScreenshotHost=127.0.0.1` after `adb reverse tcp:28765 tcp:28765`.
 */
fun captureCalmScreenshot(name: String) {
    if (InstrumentationRegistry.getArguments().getString("calmScreenshots") != "true") return
    val shot = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
    val bytes = ByteArrayOutputStream().also { shot.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    shot.recycle()
    val host = InstrumentationRegistry.getArguments().getString("calmScreenshotHost") ?: "10.0.2.2"
    Socket(host, 28765).use { socket ->
        val stream = socket.getOutputStream()
        stream.write("$name\n${bytes.size}\n".toByteArray(Charsets.UTF_8))
        stream.write(bytes)
        stream.flush()
        check(socket.getInputStream().read() == 1) { "Screenshot transfer failed" }
    }
}
