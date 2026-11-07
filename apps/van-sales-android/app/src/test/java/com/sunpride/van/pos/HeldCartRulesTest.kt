package com.sunpride.van.pos

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** IP-HOLD: parking a cart and getting it back, in the words a cashier reads. */
class HeldCartRulesTest {
    private val rice = HeldLine("p-rice", "Rice 5kg", 3, 25000)
    private val milk = HeldLine("p-milk", "Fresh milk", 5, 9000)
    private val soda = HeldLine("p-soda", "Soda", 2, 1800)
    private fun cart(vararg l: HeldLine) = HeldCart("h1", "store", "Cart 1", null, null, null, l.toList(), "P1,000.00", 1L)
    private val money = { m: Long -> "P" + (m / 100) + "." + (m % 100).toString().padStart(2, '0') }

    @Test fun nothing_to_hold_or_too_many_held_is_refused_in_words() {
        assertEquals("Add something to the cart first.", HeldCartRules.problemHolding(emptyList<Any>(), 0))
        assertNull(HeldCartRules.problemHolding(listOf(rice), 0))
        assertNull(HeldCartRules.problemHolding(listOf(rice), HeldCartRules.MAX_HELD - 1))
        assertEquals("You already have 20 held carts. Recall or discard one first.", HeldCartRules.problemHolding(listOf(rice), HeldCartRules.MAX_HELD))
        assertEquals("This cart has too many items to hold.", HeldCartRules.problemHolding(List(HeldCartRules.MAX_LINES + 1) { rice }, 0))
    }

    @Test fun the_name_is_optional_and_a_note_is_trimmed() {
        assertEquals("Cart 1", HeldCartRules.displayName(null, 0))
        assertEquals("Cart 3", HeldCartRules.displayName("   ", 2))
        assertEquals("Mrs Reyes", HeldCartRules.displayName("  Mrs Reyes ", 2))
        assertEquals(40, HeldCartRules.displayName("x".repeat(80), 0).length)
        assertNull(HeldCartRules.cleanNote("  "))
        assertNull(HeldCartRules.cleanNote(null))
        assertEquals("back in 10 min", HeldCartRules.cleanNote(" back in 10 min "))
    }

    @Test fun lines_survive_encoding_exactly_including_a_missing_price() {
        val lines = listOf(rice, HeldLine("p-x", "Office price item", 1, null))
        assertEquals(lines, HeldCartRules.decode(HeldCartRules.encode(lines)))
    }

    @Test fun recall_with_nothing_changed_brings_every_line_back_and_says_nothing() {
        val r = HeldCartRules.recall(cart(rice, milk), { 100L }, { it }, { if (it == "p-rice") 25000L else 9000L }, money)
        assertEquals(listOf(CartLine("p-rice", 3), CartLine("p-milk", 5)), r.lines)
        assertTrue(r.notes.isEmpty())
    }

    @Test fun recall_cuts_a_line_to_the_stock_left_and_drops_what_is_out_or_gone() {
        val stock = mapOf("p-rice" to 2L, "p-milk" to 0L, "p-soda" to null)
        val r = HeldCartRules.recall(cart(rice, milk, soda), { stock[it] }, { if (it == "p-soda") null else it }, { null }, money)
        assertEquals(listOf(CartLine("p-rice", 2)), r.lines)
        assertEquals(listOf("p-rice: only 2 left now (you held 3).", "p-milk is out of stock, so it was left out.", "Soda is not sold here any more, so it was left out."), r.notes)
    }

    @Test fun recall_says_when_a_price_changed_and_keeps_the_line() {
        val r = HeldCartRules.recall(cart(soda), { 50L }, { "Soda" }, { 2000L }, money)
        assertEquals(listOf(CartLine("p-soda", 2)), r.lines)
        assertEquals(listOf("Soda: the price is now P20.00 (it was P18.00)."), r.notes)
    }

    @Test fun a_van_cart_may_go_over_stock_when_the_office_allows_negative_stock() {
        val r = HeldCartRules.recall(cart(rice), { 1L }, { "Rice 5kg" }, { 25000L }, money, enforceStock = false)
        assertEquals(listOf(CartLine("p-rice", 3)), r.lines)
        assertTrue(r.notes.isEmpty())
    }

    @Test fun held_carts_stop_the_till_or_trip_closing_with_a_clear_message() {
        assertNull(HeldCartRules.closeBlock(0))
        assertEquals("You have 1 held cart. Recall and finish it, or discard it, before you close the till.", HeldCartRules.closeBlock(1))
        assertEquals("You have 3 held carts. Recall and finish them, or discard them, before you close the trip.", HeldCartRules.closeBlock(3, "close the trip"))
    }
}
