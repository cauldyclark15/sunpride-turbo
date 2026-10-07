package com.sunpride.van.ui

import com.sunpride.van.data.*
import java.math.BigDecimal
import java.math.MathContext

enum class Page { HOME, LOAD, START, STOCK, CUSTOMERS, WALK_IN, CUSTOMER, PRINTER, PRODUCTS, SALE, CHECKOUT, SALE_DONE, RECEIPTS }
data class NextAction(val page: Page, val label: String)

/** Display/validation only. The repository repeats every business check transactionally. */
object VanRules {
    const val MAX_BASE = 999_999_999_999_999_999L
    fun nextAction(trip: Trip?, load: Load?): NextAction = when {
        trip?.status == "loading" && load?.status == "planned" && !load.confirmPending -> NextAction(Page.LOAD, "Check the load")
        trip?.status == "loaded" && !trip.startPending -> NextAction(Page.START, "Start trip")
        else -> NextAction(Page.CUSTOMERS, "Customers")
    }
    fun status(trip: Trip?, load: Load?): String = when {
        trip == null -> "No trip today"
        trip.startPending -> "Starting… waiting for sync"
        load?.confirmPending == true -> "Load sent — waiting for sync"
        load?.status == "discrepancy" -> "Load waiting for supervisor"
        else -> when (trip.status) {
            "planned" -> "Planned"
            "loading" -> "Loading"
            "loaded" -> "Loaded — ready to start"
            "active" -> "On route"
            "closing" -> "Closing…"
            "closed" -> "Trip closed"
            "cancelled" -> "Trip cancelled"
            else -> "Check with your supervisor"
        }
    }
    fun quantity(base: Long, scale: Long): String {
        require(scale > 0)
        return BigDecimal.valueOf(base).divide(BigDecimal.valueOf(scale), MathContext.DECIMAL128).stripTrailingZeros().toPlainString()
    }
    fun parseQuantity(text: String, scale: Long): Long? = try {
        if (scale <= 0 || text.isBlank()) null else BigDecimal(text.trim()).multiply(BigDecimal.valueOf(scale)).longValueExact().takeIf { it in 0..MAX_BASE }
    } catch (_: ArithmeticException) { null } catch (_: NumberFormatException) { null }
    fun reasonRequired(expected: Long, actual: Long?): Boolean = actual != null && actual != expected
    fun canStart(trip: Trip?, truck: Boolean, route: Boolean): Boolean = trip?.status == "loaded" && !trip.startPending && truck && route && trip.vehicle != null && trip.route != null
    fun canConfirm(trip: Trip?, load: Load?): Boolean = trip?.status == "loading" && load?.status == "planned" && !load.confirmPending
    fun reasonLabel(code: String): String = when (code) {
        "short_loaded" -> "Short loaded"
        "over_loaded" -> "Over loaded"
        "damaged_at_loading" -> "Damaged at loading"
        "wrong_item" -> "Wrong item"
        "crushed" -> "Crushed"
        "leaking" -> "Leaking"
        "expired" -> "Expired"
        "spoiled" -> "Spoiled"
        else -> "Other"
    }
    /** Selling is allowed once the trip is on route or its start is saved on this phone (same rule as damage). */
    fun canSell(trip: Trip?): Boolean = trip?.status == "active" || trip?.startPending == true
    /** Cash typed in pesos ("250", "250.50") to centavos; null when blank, negative or more than two decimals. */
    fun parseMoney(text: String): Long? = try {
        if (text.isBlank()) null else BigDecimal(text.trim().removePrefix("₱").replace(",","")).movePointRight(2).longValueExact()
            .takeIf { it in 0..com.sunpride.van.pos.CheckoutRules.MAX_MINOR }
    } catch (_: ArithmeticException) { null } catch (_: NumberFormatException) { null }
    /** Plain words for each checkout refusal; [product] names the line when the problem is about one product. */
    fun checkoutMessage(problem: com.sunpride.van.pos.CheckoutProblem, product: String?): String {
        val p = product ?: "A product"
        return when (problem) {
            com.sunpride.van.pos.CheckoutProblem.TRIP_NOT_SELLING -> "Start the trip before selling."
            com.sunpride.van.pos.CheckoutProblem.NO_CUSTOMER -> "Choose a customer."
            com.sunpride.van.pos.CheckoutProblem.UNKNOWN_CUSTOMER -> "This customer is no longer on this phone. Choose the customer again."
            com.sunpride.van.pos.CheckoutProblem.EMPTY_CART -> "Add at least one product."
            com.sunpride.van.pos.CheckoutProblem.TOO_MANY_LINES -> "Too many products for one sale (100 at most). Split the sale."
            com.sunpride.van.pos.CheckoutProblem.DUPLICATE_PRODUCT -> "$p is in the sale twice."
            com.sunpride.van.pos.CheckoutProblem.UNKNOWN_PRODUCT -> "A product is no longer on this phone. Remove it."
            com.sunpride.van.pos.CheckoutProblem.BAD_QUANTITY -> "$p: enter a quantity above zero."
            com.sunpride.van.pos.CheckoutProblem.INSUFFICIENT_STOCK -> "$p: not enough on the truck."
            com.sunpride.van.pos.CheckoutProblem.UNPRICED -> "$p is priced by the office. There is no price on this phone, so it can't be sold yet. Remove it, or sync and try again."
            com.sunpride.van.pos.CheckoutProblem.PRICE_NOT_EXACT -> "$p: this quantity doesn't give an exact price. Change the quantity."
            com.sunpride.van.pos.CheckoutProblem.MIXED_CURRENCY -> "Prices are in different currencies. Ask the office."
            com.sunpride.van.pos.CheckoutProblem.TOTAL_TOO_LARGE -> "The total is too large for one sale. Split the sale."
            com.sunpride.van.pos.CheckoutProblem.CREDIT_TERMS_UNAVAILABLE -> "This customer has no credit terms from the office. Take cash or another payment."
            com.sunpride.van.pos.CheckoutProblem.CASH_MISSING -> "Enter the cash received."
            com.sunpride.van.pos.CheckoutProblem.CASH_SHORT -> "Cash received is less than the total."
            com.sunpride.van.pos.CheckoutProblem.PRICES_CHANGED -> "Prices or stock changed. Check the total and try again."
            com.sunpride.van.pos.CheckoutProblem.UNKNOWN_PAYMENT_METHOD -> "Choose how the customer pays."
            com.sunpride.van.pos.CheckoutProblem.REFERENCE_MISSING -> "Enter the reference number."
            com.sunpride.van.pos.CheckoutProblem.REFERENCE_INVALID -> "The reference number can only have letters, numbers, spaces, - / and . (40 at most)."
            com.sunpride.van.pos.CheckoutProblem.REFERENCE_ALREADY_USED -> "This reference number is already on another sale. Check the number."
            com.sunpride.van.pos.CheckoutProblem.CREDIT_LIMIT_EXCEEDED -> "This sale is more than the customer's credit left. Take cash or another payment, or ask the office."
        }
    }
    /** Payment state in plain words (VAN-012); [dueDate] only for credit. */
    fun paymentStateLabel(status: String, dueDate: String?): String = when (status) {
        "paid" -> "Paid"
        "awaiting_confirmation" -> "To be confirmed by the office"
        "on_account" -> if (dueDate != null) "Charged to account · due $dueDate" else "Charged to account"
        else -> "To be confirmed by the office"
    }
    fun voidMessage(problem: com.sunpride.van.pos.VoidProblem): String = when (problem) {
        com.sunpride.van.pos.VoidProblem.VOID_UNAVAILABLE -> "Voiding sales is not set up on this phone. Sync, then try again."
        com.sunpride.van.pos.VoidProblem.SALE_NOT_FOUND -> "This sale is not on this phone."
        com.sunpride.van.pos.VoidProblem.NOT_THIS_TRIP -> "Only sales from this trip can be voided on this phone. Ask the office."
        com.sunpride.van.pos.VoidProblem.HELD -> "Sign in and sync before voiding a sale."
        com.sunpride.van.pos.VoidProblem.ALREADY_VOIDED -> "This sale is already voided."
        com.sunpride.van.pos.VoidProblem.REASON_REQUIRED -> "Choose why you are voiding this sale."
        com.sunpride.van.pos.VoidProblem.NOTE_REQUIRED -> "Explain why you are voiding this sale."
        com.sunpride.van.pos.VoidProblem.NOTE_INVALID -> "Use plain text for the note (300 characters at most)."
        com.sunpride.van.pos.VoidProblem.APPROVAL_UNAVAILABLE -> "Supervisor approval is not set up on this phone. Sync, then try again."
        com.sunpride.van.pos.VoidProblem.CODE_REQUIRED -> "Enter the 8-digit code from your supervisor."
        com.sunpride.van.pos.VoidProblem.CODE_WRONG -> "That code does not match. Check the receipt number, total and reason with your supervisor."
    }
    /** VAN-017: what happened to a print, in plain words. A printer problem never changes the saved sale. */
    fun printMessage(result: com.sunpride.van.printing.PrintJobResult): String = when (result) {
        is com.sunpride.van.printing.PrintJobResult.Printed ->
            if (result.attempt.kind == com.sunpride.van.printing.PrintKind.REPRINT) "Reprint copy ${result.attempt.copyNumber} printed. It is marked REPRINT."
            else if (result.attempt.kind == com.sunpride.van.printing.PrintKind.VOID) "Void slip printed. The sale is cancelled."
            else "Receipt printed. Tear it off for the customer."
        is com.sunpride.van.printing.PrintJobResult.Failed -> when {
            result.attempt == null -> "Printer not ready: ${com.sunpride.van.printing.PrinterWords.status(result.status)}. The sale is saved. Check the printer, then print again."
            result.mayHavePrinted && result.attempt.kind == com.sunpride.van.printing.PrintKind.VOID -> "The printer stopped during the void slip. Check the paper. Use Reprint void slip for another copy."
            result.mayHavePrinted -> "The printer stopped during the receipt. Check the paper. Any new copy will be marked REPRINT."
            else -> "Not printed: ${com.sunpride.van.printing.PrinterWords.status(result.status)}. The sale is saved. Print again."
        }
        is com.sunpride.van.printing.PrintJobResult.Refused -> when (result.refusal) {
            com.sunpride.van.printing.PrintRefusal.ALREADY_PRINTED -> "Receipt already printed. Use Reprint for another copy."
            com.sunpride.van.printing.PrintRefusal.REASON_REQUIRED -> "Choose why you are reprinting."
            com.sunpride.van.printing.PrintRefusal.LIMIT_REACHED -> "This receipt was reprinted ${com.sunpride.van.printing.ReprintRules.MAX_REPRINTS} times already. Ask the office for a copy."
            com.sunpride.van.printing.PrintRefusal.NOT_THIS_TRIP -> "Only receipts from this trip can be printed on the phone. Ask the office for a copy."
            com.sunpride.van.printing.PrintRefusal.SALE_NOT_FOUND -> "This sale is not on this phone."
            com.sunpride.van.printing.PrintRefusal.HELD -> "Sign in again to print."
            com.sunpride.van.printing.PrintRefusal.PAPER_OUT -> "The printer is out of paper. Load paper, then print again."
        }
    }
    fun sourceLabel(source: String): String = when (source) { "route" -> "Route"; "unplanned" -> "Not on route"; else -> "Walk-in" }
}
