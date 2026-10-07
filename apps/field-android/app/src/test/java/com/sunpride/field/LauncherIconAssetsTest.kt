package com.sunpride.field

import java.io.DataInputStream
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** SP-0126: the launcher icon, splash and listing bitmaps come from the client's logo at every density. */
class LauncherIconAssetsTest {
    private val main = listOf(File("src/main"), File("app/src/main")).first { it.isDirectory }
    private val res = File(main, "res")

    /** Width/height from a PNG's IHDR chunk. */
    private fun pngSize(file: File): Pair<Int, Int> = DataInputStream(file.inputStream()).use { input ->
        val signature = ByteArray(8).also { input.readFully(it) }
        assertTrue("${file.path} is not a PNG", signature.contentEquals(
            byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)))
        input.readInt(); input.readInt() // IHDR length + type
        input.readInt() to input.readInt()
    }

    private val densities = mapOf("mdpi" to 1.0, "hdpi" to 1.5, "xhdpi" to 2.0, "xxhdpi" to 3.0, "xxxhdpi" to 4.0)

    @Test fun legacyLauncherIconsExistForEveryDensity() {
        densities.forEach { (density, scale) ->
            val px = (48 * scale).toInt()
            listOf("ic_launcher", "ic_launcher_round").forEach { name ->
                assertEquals("$density/$name", px to px, pngSize(File(res, "mipmap-$density/$name.png")))
            }
            val logo = (72 * scale).toInt()
            assertEquals("$density logo layer", logo to logo, pngSize(File(res, "drawable-$density/sunpride_logo_icon.png")))
        }
        assertEquals(480 to 480, pngSize(File(res, "drawable-nodpi/sunpride_logo.png")))
        assertEquals(512 to 512, pngSize(File(main, "ic_launcher-playstore.png")))
    }

    @Test fun adaptiveIconIsTheLogoBackgroundWithAnEmptyForeground() {
        listOf("ic_launcher", "ic_launcher_round").forEach { name ->
            val xml = File(res, "mipmap-anydpi-v26/$name.xml").readText()
            assertTrue(name, xml.contains("<background android:drawable=\"@drawable/sunpride_logo_layer\""))
            assertTrue(name, xml.contains("<foreground android:drawable=\"@android:color/transparent\""))
        }
        // The logo fills the visible 72dp of the 108dp canvas: inset one sixth per side.
        assertTrue(File(res, "drawable/sunpride_logo_layer.xml").readText().contains("android:inset=\"16.6667%\""))
    }

    @Test fun splashUsesTheLogoOnItsOwnRed() {
        assertTrue(File(res, "values/colors.xml").readText().contains("<color name=\"sunpride_red\">#EE1C25</color>"))
        val v31 = File(res, "values-v31/themes.xml").readText()
        assertTrue(v31.contains("android:windowSplashScreenBackground\">@color/sunpride_red"))
        assertTrue(v31.contains("android:windowSplashScreenAnimatedIcon\">@drawable/sunpride_logo_layer"))
        listOf("values", "values-v31").forEach {
            assertTrue(it, File(res, "$it/themes.xml").readText().contains("android:windowBackground\">@drawable/splash_background"))
        }
        val manifest = File(main, "AndroidManifest.xml").readText()
        assertTrue(manifest.contains("android:icon=\"@mipmap/ic_launcher\""))
        assertTrue(manifest.contains("android:roundIcon=\"@mipmap/ic_launcher_round\""))
        assertTrue(manifest.contains("android:theme=\"@style/Theme.SunprideField.Starting\""))
    }

    @Test fun noFlavorOverridesTheIcon() {
        // Beta, dev, staging and prod all ship the same main-source-set icon.
        File(main.parentFile, ".").listFiles()!!.filter { it.isDirectory && it.name !in setOf("main", "test", "androidTest") }
            .forEach { flavor ->
                assertTrue("${flavor.name} overrides mipmaps",
                    File(flavor, "res").listFiles()?.none { it.name.startsWith("mipmap") } ?: true)
            }
    }
}
