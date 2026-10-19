package com.sunpride.field.ui.syncstatus

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InternetNetworksTest {
    @Test fun losingTheOnlyNetworkIsOfflineEvenIfTheActiveNetworkStillLooksUp() {
        val n = InternetNetworks(initiallyOnline = true)
        n.available("wifi"); assertFalse(n.offline)
        n.lost("wifi"); assertTrue(n.offline)
    }
    @Test fun wifiOffWithDataStillUpStaysOnline() {
        val n = InternetNetworks(initiallyOnline = true)
        n.available("wifi"); n.available("lte")
        n.lost("wifi"); assertFalse(n.offline)
        n.capabilities("lte", internet = false); assertTrue(n.offline)
        n.capabilities("lte", internet = true); assertFalse(n.offline)
    }
    @Test fun startsFromTheSystemAnswerUntilTheFirstCallback() {
        assertTrue(InternetNetworks(initiallyOnline = false).offline)
        assertFalse(InternetNetworks(initiallyOnline = true).offline)
    }
}
