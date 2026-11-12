package com.sunpride.van.ui

import com.sunpride.integrity.EvidenceLocationUnavailable
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** SP-0169 r6 lane van2: VAN-070 photo reason, void error per reason, store Payment message per sale. */
class VanR6Van2Test {
    @Test fun van070DamagePhotoWithoutLocationSaysWhy() {
        assertEquals(EvidenceLocationUnavailable.NO_FIX, VanRules.damagePhotoFailure(EvidenceLocationUnavailable(EvidenceLocationUnavailable.NO_FIX)))
        assertEquals(EvidenceLocationUnavailable.MOCK,
            VanRules.damagePhotoFailure(RuntimeException("wrapped", EvidenceLocationUnavailable(EvidenceLocationUnavailable.MOCK))))
        assertTrue(VanRules.damagePhotoFailure(EvidenceLocationUnavailable(EvidenceLocationUnavailable.PERMISSION)).contains("damage photos"))
        assertEquals("Could not save photo. Retake and try again.", VanRules.damagePhotoFailure(IllegalStateException("disk")))
        val screen = File("src/main/java/com/sunpride/van/ui/StockCustomers.kt").readText()
        assertTrue(screen.contains("VanRules.damagePhotoFailure(e)"))
        assertFalse("the camera failure must not be swallowed", screen.contains("catch (_: Exception) { photoMessage"))
    }

    @Test fun voidCodeErrorClearsWhenTheReasonChanges() {
        val wrong = "That code does not match. Check the receipt number, total and reason with your supervisor."
        assertEquals(wrong, VanRules.voidError(wrong, "wrong_price", "wrong_price"))
        assertNull(VanRules.voidError(wrong, "wrong_price", "customer_cancelled"))
        assertNull(VanRules.voidError(wrong, null, "wrong_price"))
        val dialog = File("src/main/java/com/sunpride/van/ui/ReceiptScreens.kt").readText()
        assertTrue(dialog.contains("shownError?.let"))
        assertFalse(dialog.contains("error?.let { Text(it"))
    }

    @Test fun aNewStoreSaleDoesNotShowThePreviousSalesSavedLine() {
        val screen = File("src/main/java/com/sunpride/van/ui/StoreTransactionScreens.kt").readText()
        val newSale = screen.substringAfter("fun newSale(){").substringBefore("send(SellEvent.NewSaleTapped)")
        assertTrue("newSale() must clear the last sale's message", newSale.contains("c.startNewStoreSale()"))
        val controller = File("src/main/java/com/sunpride/van/ui/VanController.kt").readText()
        assertTrue(controller.contains("fun startNewStoreSale() { message=null }"))
    }
}
