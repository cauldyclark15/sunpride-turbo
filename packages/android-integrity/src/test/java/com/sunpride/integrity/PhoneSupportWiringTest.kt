package com.sunpride.integrity

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.*
import org.junit.Test

/** Static production wiring checks only; these do not run Android's service manager. */
class PhoneSupportWiringTest {
    private val root: File get() = generateSequence(File(checkNotNull(System.getProperty("user.dir")))) { it.parentFile }
        .first { File(it, "packages/android-integrity").isDirectory }
    private fun source(path: String) = File(root, path).readText()

    @Test fun bothAppsDeclareNonExportedSpecialUseSupportWithoutLocationPrerequisites() {
        val ns = "http://schemas.android.com/apk/res/android"
        for ((app, name) in listOf("field-android" to "Field", "van-sales-android" to "Van")) {
            val manifest = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
                .newDocumentBuilder().parse(File(root, "apps/$app/app/src/main/AndroidManifest.xml"))
            val permissions = manifest.getElementsByTagName("uses-permission")
            assertTrue((0 until permissions.length).any {
                permissions.item(it).attributes.getNamedItemNS(ns,"name").nodeValue == "android.permission.FOREGROUND_SERVICE_SPECIAL_USE"
            })
            val services = manifest.getElementsByTagName("service")
            val service = (0 until services.length).map { services.item(it) as org.w3c.dom.Element }
                .single { it.getAttributeNS(ns,"name") == ".${name}PhoneSupportService" }
            assertEquals("false",service.getAttributeNS(ns,"exported"))
            assertEquals("specialUse",service.getAttributeNS(ns,"foregroundServiceType"))
            val property = service.getElementsByTagName("property").item(0) as org.w3c.dom.Element
            assertEquals("android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE",property.getAttributeNS(ns,"name"))
            assertTrue(property.getAttributeNS(ns,"value").contains("each minute"))
        }
    }
    @Test fun pollingIsServiceOwnedAndActivityTeardownCannotCloseTheProductionVanRepository() {
        val service = source("packages/android-integrity/src/main/java/com/sunpride/integrity/PhoneSupportService.kt")
        assertTrue(service.contains("PhoneSupportLoop.run("))
        assertTrue(service.contains("if (polling?.isActive != true)"))
        assertTrue(service.contains("return START_STICKY"))
        assertTrue(service.contains(".setContentTitle(\"Phone controls running\")"))
        assertTrue(service.contains(".setOngoing(true)"))
        assertTrue(service.contains("override fun onAvailable("))
        assertTrue(service.contains("scope.cancel()"))
        for ((app, packageName) in listOf("field-android" to "field", "van-sales-android" to "van")) {
            val ui = source("apps/$app/app/src/main/java/com/sunpride/$packageName/ui/${if(packageName=="field") "Field" else "Van"}App.kt")
            assertFalse("A UI timer is not background delivery",ui.contains("PhoneCommands.POLL_MS"))
        }
        val activity = source("apps/van-sales-android/app/src/main/java/com/sunpride/van/MainActivity.kt")
        assertTrue(activity.contains("VanPhoneSupport.repository(applicationContext)"))
        assertTrue(activity.contains("if (!sharedRepository) repository?.close()"))
        val field = source("apps/field-android/app/src/main/java/com/sunpride/field/MainActivity.kt")
        assertTrue(field.contains("FieldPhoneSupport.backend(app)"))
    }
}
