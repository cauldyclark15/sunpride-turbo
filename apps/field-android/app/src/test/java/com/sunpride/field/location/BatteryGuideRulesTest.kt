package com.sunpride.field.location

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** SP-0140: when the one-time battery guide appears and what it tells each phone brand. */
class BatteryGuideRulesTest {
    @Test fun brandPrefersTheKnownBatteryKillerFromManufacturerOrBrand() {
        assertEquals("xiaomi", BatteryGuideRules.brand("Xiaomi", "Redmi"))
        assertEquals("redmi", BatteryGuideRules.brand("Unknown", "REDMI"))
        assertEquals("samsung", BatteryGuideRules.brand(" samsung ", "samsung"))
        assertEquals("google", BatteryGuideRules.brand("Google", "google"))
        assertEquals("", BatteryGuideRules.brand(null, null))
    }

    @Test fun showsOnceWhenTheBatterySettingStillRestrictsTheApp() {
        assertTrue(BatteryGuideRules.shouldShow(shown = false, unrestricted = false, brand = "google"))
        assertFalse("already seen on this phone", BatteryGuideRules.shouldShow(shown = true, unrestricted = false, brand = "xiaomi"))
        assertFalse("nothing to change on a stock phone", BatteryGuideRules.shouldShow(shown = false, unrestricted = true, brand = "google"))
    }

    @Test fun autostartPhonesSeeTheGuideEvenWhenBatteryIsAlreadyUnrestricted() {
        // Autostart cannot be read back, so Xiaomi-class phones always get the one-time guide.
        assertTrue(BatteryGuideRules.shouldShow(shown = false, unrestricted = true, brand = "xiaomi"))
        assertTrue(BatteryGuideRules.hasAutostart("tecno"))
        assertFalse(BatteryGuideRules.hasAutostart("samsung"))
        assertTrue(BatteryGuideRules.aggressive("samsung"))
    }

    @Test fun todayOffersTheGuideAgainOnlyWhileSharingIsAtRisk() {
        assertTrue(BatteryGuideRules.offerAgain(sharing = true, unrestricted = false))
        assertFalse(BatteryGuideRules.offerAgain(sharing = true, unrestricted = true))
        assertFalse("not sharing: nothing to keep alive", BatteryGuideRules.offerAgain(sharing = false, unrestricted = false))
    }

    @Test fun stepsUseEachBrandsOwnSettingNames() {
        assertEquals("Battery saver → No restrictions", BatteryGuideRules.batteryStep("redmi"))
        assertEquals("Battery → Unrestricted", BatteryGuideRules.batteryStep("samsung"))
        assertEquals("Autostart → on for Sunpride Field", BatteryGuideRules.autostartStep("xiaomi"))
        assertEquals("Auto launch → on for Sunpride Field", BatteryGuideRules.autostartStep("realme"))
        val view = BatteryGuideView("poco", unrestricted = false, autostart = true)
        assertEquals("Battery saver → No restrictions", view.batteryStep)
    }
}
