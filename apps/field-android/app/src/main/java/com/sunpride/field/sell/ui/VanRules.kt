package com.sunpride.field.sell.ui

import com.sunpride.field.sell.data.*
import java.math.BigDecimal
import java.math.MathContext

enum class Page { HOME, ACCEPT_LOAD, LOAD, START, STOCK, STOCK_COUNT, CUSTOMERS, WALK_IN, CUSTOMER, PRINTER, PRODUCTS, CATALOGUE, SALE, CHECKOUT, SALE_DONE, RECEIPTS, RETURN, RETURN_DONE, CASH, CLOSE_TRIP, SYNC, LOCATION_CONSENT, ROUTE_OPS, MORE }
data class NextAction(val page: Page, val label: String)

/** Display/validation only. The repository repeats every business check transactionally. */
object VanRules {
    const val MAX_BASE = 999_999_999_999_999_999L
    fun nextAction(trip: Trip?, load: Load?): NextAction = when {
        trip?.status == "loading" && load?.status == "planned" && !load.confirmPending -> NextAction(Page.LOAD, "Check the load")
        trip?.status == "loaded" && !trip.startPending -> NextAction(Page.START, "Start trip")
        trip?.status in setOf("closing","reconciling","review_required","closed") -> NextAction(Page.CLOSE_TRIP, "Review trip close")
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
            "reconciling" -> "Cash counted — hand it to the cashier"
            "review_required" -> "Supervisor is reviewing this trip"
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
    /** An odometer reading in km without trailing zeros ("12345.6"). */
    fun km(value: Double): String = BigDecimal(value.toString()).stripTrailingZeros().toPlainString()
    fun reasonRequired(expected: Long, actual: Long?): Boolean = actual != null && actual != expected
    fun canStart(trip: Trip?, truck: Boolean, route: Boolean): Boolean = trip?.status == "loaded" && !trip.startPending && truck && route && trip.vehicle != null
    // The server allows a trip without a route; the seller still confirms "Route not assigned".
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
    /** VAN-022: cash can be counted once the trip is on the road (or its start is saved here) and until it closes. */
    fun canCountCash(trip: Trip?): Boolean = canSell(trip) || trip?.status in setOf("closing","reconciling","review_required")
    /** VAN-023 uses the same countable trip states as cash. */
    fun canCountStock(trip: Trip?): Boolean = canCountCash(trip)
    /** Cash typed in pesos ("250", "250.50") to centavos; null when blank, negative or more than two decimals. */
    fun parseMoney(text: String): Long? = try {
        if (text.isBlank()) null else BigDecimal(text.trim().removePrefix("₱").replace(",","")).movePointRight(2).longValueExact()
            .takeIf { it in 0..com.sunpride.field.sell.pos.CheckoutRules.MAX_MINOR }
    } catch (_: ArithmeticException) { null } catch (_: NumberFormatException) { null }
    /** Plain words for each checkout refusal; [product] names the line when the problem is about one product. */
    fun checkoutMessage(problem: com.sunpride.field.sell.pos.CheckoutProblem, product: String?): String {
        val p = product ?: "A product"
        return when (problem) {
            com.sunpride.field.sell.pos.CheckoutProblem.TRIP_NOT_SELLING -> "Start the trip before selling."
            com.sunpride.field.sell.pos.CheckoutProblem.NO_CUSTOMER -> "Choose a customer."
            com.sunpride.field.sell.pos.CheckoutProblem.UNKNOWN_CUSTOMER -> "This customer is no longer on this phone. Choose the customer again."
            com.sunpride.field.sell.pos.CheckoutProblem.EMPTY_CART -> "Add at least one product."
            com.sunpride.field.sell.pos.CheckoutProblem.TOO_MANY_LINES -> "Too many products for one sale (100 at most). Split the sale."
            com.sunpride.field.sell.pos.CheckoutProblem.DUPLICATE_PRODUCT -> "$p is in the sale twice."
            com.sunpride.field.sell.pos.CheckoutProblem.UNKNOWN_PRODUCT -> "A product is no longer on this phone. Remove it."
            com.sunpride.field.sell.pos.CheckoutProblem.BAD_QUANTITY -> "$p: enter a quantity above zero."
            com.sunpride.field.sell.pos.CheckoutProblem.INSUFFICIENT_STOCK -> "$p: not enough on the truck to sell. Batches the office has on hold or that are too close to expiry cannot be sold."
            com.sunpride.field.sell.pos.CheckoutProblem.UNPRICED -> "$p is priced by the office. There is no price for this customer on this phone, so it can't be sold yet. Remove it, or sync and try again."
            com.sunpride.field.sell.pos.CheckoutProblem.PRICE_NOT_EXACT -> "$p: this quantity doesn't give an exact price. Change the quantity."
            com.sunpride.field.sell.pos.CheckoutProblem.PROMOTION_CONFLICT -> "Two promotions apply to $p. Ask the office, or remove it."
            com.sunpride.field.sell.pos.CheckoutProblem.PROMOTION_NEEDS_OFFICE -> "A promotion on $p needs the office. Remove it, or sync and try again."
            com.sunpride.field.sell.pos.CheckoutProblem.MIXED_CURRENCY -> "Prices are in different currencies. Ask the office."
            com.sunpride.field.sell.pos.CheckoutProblem.TOTAL_TOO_LARGE -> "The total is too large for one sale. Split the sale."
            com.sunpride.field.sell.pos.CheckoutProblem.CREDIT_EXPOSURE_STALE -> "The SAP credit check expired. Check credit online before completing this sale."
            com.sunpride.field.sell.pos.CheckoutProblem.CREDIT_EXPOSURE_UNKNOWN -> "SAP credit is not confirmed. Check online or take another payment; unknown is not available credit."
            com.sunpride.field.sell.pos.CheckoutProblem.CREDIT_TERMS_UNAVAILABLE -> "This customer has no credit terms from the office. Take cash or another payment."
            com.sunpride.field.sell.pos.CheckoutProblem.CASH_MISSING -> "Enter the cash received."
            com.sunpride.field.sell.pos.CheckoutProblem.CASH_SHORT -> "Cash received is less than the total."
            com.sunpride.field.sell.pos.CheckoutProblem.PRICES_CHANGED -> "Prices or stock changed. Check the total and try again."
            com.sunpride.field.sell.pos.CheckoutProblem.UNKNOWN_PAYMENT_METHOD -> "Choose how the customer pays."
            com.sunpride.field.sell.pos.CheckoutProblem.REFERENCE_MISSING -> "Enter the reference number."
            com.sunpride.field.sell.pos.CheckoutProblem.REFERENCE_INVALID -> "The reference number can only have letters, numbers, spaces, - / and . (40 at most)."
            com.sunpride.field.sell.pos.CheckoutProblem.REFERENCE_ALREADY_USED -> "This reference number is already on another sale. Check the number."
            com.sunpride.field.sell.pos.CheckoutProblem.CREDIT_LIMIT_EXCEEDED -> "This sale is more than the customer's credit left. Take cash or another payment, or ask the office."
            com.sunpride.field.sell.pos.CheckoutProblem.CASH_COUNTED -> "The cash for this trip is already counted. No more sales on this trip."
            com.sunpride.field.sell.pos.CheckoutProblem.STOCK_COUNTED -> "Truck stock is already counted. No more stock changes on this trip."
            com.sunpride.field.sell.pos.CheckoutProblem.DISCOUNT_INVALID -> "A discount exceeds its line or basket. Check the amounts."
            com.sunpride.field.sell.pos.CheckoutProblem.DISCOUNT_REASON_REQUIRED -> "Give a reason for the manual discount (300 characters at most)."
            com.sunpride.field.sell.pos.CheckoutProblem.DISCOUNT_POLICY_NOT_READY -> "Download an effective discount authority rule for this customer and amount. Ask the office if none is set."
            com.sunpride.field.sell.pos.CheckoutProblem.DISCOUNT_APPROVAL_REQUIRED -> "This discount needs a second person. Request approval before completing the sale."
            com.sunpride.field.sell.pos.CheckoutProblem.DISCOUNT_APPROVAL_INVALID -> "Approval no longer matches this sale or has expired. Check the cart and request approval again."
            com.sunpride.field.sell.pos.CheckoutProblem.OVERRIDE_REASON_REQUIRED -> "Enter a reason for the financial exception."
            com.sunpride.field.sell.pos.CheckoutProblem.OVERRIDE_POLICY_NOT_READY -> "Sync the current role, channel and value authority before this exception."
            com.sunpride.field.sell.pos.CheckoutProblem.OVERRIDE_APPROVAL_REQUIRED -> "Another authorized person must approve this exact transaction. Request and check the approval."
            com.sunpride.field.sell.pos.CheckoutProblem.OVERRIDE_INVALID -> "The exception or approval no longer matches. Review it and request again."
            com.sunpride.field.sell.pos.CheckoutProblem.DISCOUNT_CLAIM_INVALID -> "The discount needs the ID number exactly as printed on the card and the name of the person on it."
            com.sunpride.field.sell.pos.CheckoutProblem.DISCOUNT_SWITCHED_OFF -> com.sunpride.field.sell.selling.PrivilegeSwitch.OFF_MESSAGE
            com.sunpride.field.sell.pos.CheckoutProblem.DISCOUNT_CLAIM_WITH_MANUAL -> "A senior, PWD or other statutory discount cannot be combined with a manual discount or a price exception. Remove one of them."
            com.sunpride.field.sell.pos.CheckoutProblem.DISCOUNT_TAX_UNKNOWN -> "$p has no tax set-up on this phone, so the discount cannot be worked out. Ask the office to finish the price and tax set-up, then sync."
            com.sunpride.field.sell.pos.CheckoutProblem.SPLIT_INVALID -> "Check the split: the other tender must be more than zero and less than the total, and the rest is paid in cash."
            com.sunpride.field.sell.pos.CheckoutProblem.TAX_NOT_READY -> "Download the current selling tax treatment before issuing an invoice. Ask the office if a product's tax class is not set."
        }
    }
    /** Payment state in plain words (VAN-012); [dueDate] only for credit. */
    fun paymentStateLabel(status: String, dueDate: String?): String = when (status) {
        "paid" -> "Paid"
        "awaiting_confirmation" -> "To be confirmed by the office"
        "on_account" -> if (dueDate != null) "Charged to account · due $dueDate" else "Charged to account"
        else -> "To be confirmed by the office"
    }
    /** VAN-070: say WHY a damage photo could not be saved (no fresh location, location off, mock location) instead of a generic retake. */
    fun damagePhotoFailure(e: Throwable): String {
        val location = generateSequence(e) { it.cause }.filterIsInstance<com.sunpride.integrity.EvidenceLocationUnavailable>().firstOrNull()
        return when (location?.message) {
            null -> "Could not save photo. Retake and try again."
            com.sunpride.integrity.EvidenceLocationUnavailable.PERMISSION -> "Allow location to take damage photos. Each photo is stamped with where it was taken."
            else -> location.message!!
        }
    }
    /** A refused void code belongs to the reason it was tried with; choosing another reason clears it. */
    fun voidError(error: String?, triedReason: String?, reason: String?): String? = error?.takeIf { triedReason != null && triedReason == reason }
    fun voidMessage(problem: com.sunpride.field.sell.pos.VoidProblem): String = when (problem) {
        com.sunpride.field.sell.pos.VoidProblem.VOID_UNAVAILABLE -> "Voiding sales is not set up on this phone. Sync, then try again."
        com.sunpride.field.sell.pos.VoidProblem.SALE_NOT_FOUND -> "This sale is not on this phone."
        com.sunpride.field.sell.pos.VoidProblem.NOT_THIS_TRIP -> "Only sales from this trip can be voided on this phone. Ask the office."
        com.sunpride.field.sell.pos.VoidProblem.HELD -> "Sign in and sync before voiding a sale."
        com.sunpride.field.sell.pos.VoidProblem.ALREADY_VOIDED -> "This sale is already voided."
        com.sunpride.field.sell.pos.VoidProblem.SALE_HAS_RETURNS -> "Part of this sale was already returned or refunded, so it cannot be voided. Refund the items that are left instead."
        com.sunpride.field.sell.pos.VoidProblem.REASON_REQUIRED -> "Choose why you are voiding this sale."
        com.sunpride.field.sell.pos.VoidProblem.NOTE_REQUIRED -> "Explain why you are voiding this sale."
        com.sunpride.field.sell.pos.VoidProblem.NOTE_INVALID -> "Use plain text for the note (300 characters at most)."
        com.sunpride.field.sell.pos.VoidProblem.APPROVAL_UNAVAILABLE -> "Supervisor approval is not set up on this phone. Sync, then try again."
        com.sunpride.field.sell.pos.VoidProblem.CODE_REQUIRED -> "Enter the 8-digit code from your supervisor."
        com.sunpride.field.sell.pos.VoidProblem.CODE_WRONG -> "That code does not match. Check the receipt number, total and reason with your supervisor."
        com.sunpride.field.sell.pos.VoidProblem.CASH_COUNTED -> "The cash for this trip is already counted, so sales can no longer be voided. Ask the office."
        com.sunpride.field.sell.pos.VoidProblem.STOCK_COUNTED -> "Truck stock is already counted, so sales can no longer be voided. Ask the office."
        com.sunpride.field.sell.pos.VoidProblem.TRIP_CLOSED -> "This trip is closed, so sales can no longer be voided. Ask the office."
    }
    /** VAN-022: plain words for each cash count refusal. */
    fun cashMessage(problem: com.sunpride.field.sell.pos.CashProblem): String = when (problem) {
        com.sunpride.field.sell.pos.CashProblem.NOT_ON_ROUTE -> "Start the trip before counting cash."
        com.sunpride.field.sell.pos.CashProblem.HELD -> "Sign in and sync before counting cash."
        com.sunpride.field.sell.pos.CashProblem.ALREADY_COUNTED -> "The cash for this trip is already counted. Ask the office to correct it."
        com.sunpride.field.sell.pos.CashProblem.EXPECTED_CHANGED -> "Sales changed while you were counting. Check the expected cash and save again."
        com.sunpride.field.sell.pos.CashProblem.COUNT_INVALID -> "Enter whole numbers of bills and coins."
        com.sunpride.field.sell.pos.CashProblem.MIXED_CURRENCY -> "Sales on this trip are in different currencies. Ask the office."
        com.sunpride.field.sell.pos.CashProblem.REASON_REQUIRED -> "Choose why the cash is different."
        com.sunpride.field.sell.pos.CashProblem.NOTE_REQUIRED -> "Explain why the cash is different."
        com.sunpride.field.sell.pos.CashProblem.NOTE_INVALID -> "Use plain text for the note (300 characters at most)."
        com.sunpride.field.sell.pos.CashProblem.APPROVAL_UNAVAILABLE -> "Supervisor approval is not set up on this phone. Sync, then try again."
        com.sunpride.field.sell.pos.CashProblem.CODE_REQUIRED -> "Enter the 8-digit code from your supervisor."
        com.sunpride.field.sell.pos.CashProblem.CODE_WRONG -> "That code does not match. Check the trip number, both amounts and the reason with your supervisor."
    }
    /** VAN-023: plain words for each stock count refusal. */
    fun stockMessage(problem: com.sunpride.field.sell.pos.StockProblem): String = when (problem) {
        com.sunpride.field.sell.pos.StockProblem.NOT_ON_ROUTE -> "Start the trip before counting stock."
        com.sunpride.field.sell.pos.StockProblem.HELD -> "Sign in and sync before counting stock."
        com.sunpride.field.sell.pos.StockProblem.ALREADY_COUNTED -> "Truck stock is already counted. Ask the office to correct it."
        com.sunpride.field.sell.pos.StockProblem.EXPECTED_CHANGED -> "Truck stock changed while you were counting. Check expected stock and save again."
        com.sunpride.field.sell.pos.StockProblem.COUNT_INVALID -> "Enter a valid non-negative quantity for every stock line."
        com.sunpride.field.sell.pos.StockProblem.TOO_MANY_LINES -> "There are too many stock lines for one count. Ask the office."
        com.sunpride.field.sell.pos.StockProblem.REASON_REQUIRED -> "Choose a reason for every stock difference."
        com.sunpride.field.sell.pos.StockProblem.NOTE_REQUIRED -> "Explain the stock difference marked Other."
        com.sunpride.field.sell.pos.StockProblem.NOTE_INVALID -> "Use plain text for the note (300 characters at most)."
        com.sunpride.field.sell.pos.StockProblem.APPROVAL_UNAVAILABLE -> "Supervisor approval is not set up on this phone. Sync, then try again."
        com.sunpride.field.sell.pos.StockProblem.CODE_REQUIRED -> "Enter the 8-digit code from your supervisor."
        com.sunpride.field.sell.pos.StockProblem.CODE_WRONG -> "That code does not match. Check the trip, count code and stock totals with your supervisor."
        com.sunpride.field.sell.pos.StockProblem.STOCK_COUNTED -> "Truck stock is already counted. No more stock changes on this trip."
        com.sunpride.field.sell.pos.StockProblem.TRIP_CLOSED -> "This trip is closed. No more stock changes on this trip."
        com.sunpride.field.sell.pos.StockProblem.DAMAGE_WAITING -> "A damage report must be decided and synced before the stock count. Ask your supervisor, then sync."
    }
    /** VAN-082: Close trip tapped with everything else ready but the exceptions not ticked: say so (null = close normally). */
    /**
     * VAN-081: the end odometer against the trip's start. [startKm] comes from the trip (this phone or the office);
     * when it is unknown the seller types it ([startText]) so a lower end reading is still caught. Null = fine.
     */
    fun closeOdometerProblem(endText: String, startKm: Double?, startText: String, required: Boolean): String? {
        val end = endText.trim()
        if (end.isEmpty()) return if (required) "Enter the closing odometer in km." else null
        val endKm = end.toDoubleOrNull()?.takeIf { it.isFinite() && it in 0.0..com.sunpride.field.sell.pos.TripCloseRules.MAX_ODOMETER_KM }
            ?: return "Enter the end odometer in km, numbers only (for example 48262)."
        val start = startKm ?: run {
            val typed = startText.trim()
            if (typed.isEmpty()) return "This phone does not have the start odometer for this trip. Enter the reading at the start too."
            typed.toDoubleOrNull()?.takeIf { it.isFinite() && it in 0.0..com.sunpride.field.sell.pos.TripCloseRules.MAX_ODOMETER_KM }
                ?: return "Enter the start odometer in km, numbers only."
        }
        return if (endKm < start) "The end odometer (${km(endKm)} km) cannot be lower than at the start (${km(start)} km)." else null
    }
    fun closeTapMessage(otherwiseReady: Boolean, needsReview: Boolean, reviewed: Boolean): String? =
        if (otherwiseReady && needsReview && !reviewed) closeMessage(com.sunpride.field.sell.pos.CloseProblem.REVIEW_REQUIRED) else null
    /** VAN-024: plain words for each trip close refusal. */
    fun closeMessage(problem: com.sunpride.field.sell.pos.CloseProblem): String = when (problem) {
        com.sunpride.field.sell.pos.CloseProblem.NOT_ON_ROUTE -> "Start the trip before closing it."
        com.sunpride.field.sell.pos.CloseProblem.HELD -> "Sign in and sync before closing the trip."
        com.sunpride.field.sell.pos.CloseProblem.ALREADY_CLOSED -> "This trip is already closed on this phone."
        com.sunpride.field.sell.pos.CloseProblem.CASH_NOT_COUNTED -> "Count the cash first."
        com.sunpride.field.sell.pos.CloseProblem.STOCK_NOT_COUNTED -> "Count the truck stock first."
        com.sunpride.field.sell.pos.CloseProblem.UPLOADS_WAITING -> "Some work is still waiting to send. Tap Sync now with signal, then close the trip."
        com.sunpride.field.sell.pos.CloseProblem.SALES_STOCK_DISAGREE -> "Sales and truck stock on this phone do not agree. Call the office before closing."
        com.sunpride.field.sell.pos.CloseProblem.REVIEW_REQUIRED -> "Check the items below and tick the box before closing."
        com.sunpride.field.sell.pos.CloseProblem.EXCEPTIONS_CHANGED -> "Something changed while you were checking. Look at the items again and tick the box."
        com.sunpride.field.sell.pos.CloseProblem.CLOSE_INVALID -> "Could not close the trip. Go back and try again."
        com.sunpride.field.sell.pos.CloseProblem.ODOMETER_INVALID -> "Enter the end odometer in km, not lower than at the start."
        com.sunpride.field.sell.pos.CloseProblem.NOTE_INVALID -> "Use plain text for the note (300 characters at most)."
    }
    /** VAN-024 checklist line: what is done, or what to do next. */
    fun closeStepLabel(step: com.sunpride.field.sell.pos.CloseStepState): String = when (step.step) {
        com.sunpride.field.sell.pos.CloseStep.TRIP_STARTED -> if (step.done) "Trip started" else "Start the trip first"
        com.sunpride.field.sell.pos.CloseStep.PHONE_ACTIVE -> if (step.done) "Signed in on this phone" else "Sign in and sync"
        com.sunpride.field.sell.pos.CloseStep.CASH_COUNTED -> if (step.done) "Cash counted" else if (step.required) "Count the cash" else "Cash not counted (not required)"
        com.sunpride.field.sell.pos.CloseStep.STOCK_COUNTED -> if (step.done) "Truck stock counted" else if (step.required) "Count the truck stock" else "Stock not counted (not required)"
        com.sunpride.field.sell.pos.CloseStep.UPLOADS_SENT -> if (step.done) "Nothing waiting to send" else "${step.count} waiting to send — sync with signal" + if (step.required) "" else " (not required)"
        com.sunpride.field.sell.pos.CloseStep.SALES_MATCH_STOCK -> if (step.done) "Sales match truck stock" else "${step.count} sales and stock problems — call the office"
    }
    /** VAN-024 exception line shown before closing. */
    fun closeExceptionLabel(e: com.sunpride.field.sell.pos.CloseException, currency: String = "PHP"): String = when (e.kind) {
        com.sunpride.field.sell.pos.CloseExceptionKind.UNPRINTED_RECEIPTS -> "${e.amount} ${if (e.amount == 1L) "receipt" else "receipts"} not printed"
        com.sunpride.field.sell.pos.CloseExceptionKind.OFFICE_REFUSED -> "${e.amount} ${if (e.amount == 1L) "item" else "items"} with the office"
        com.sunpride.field.sell.pos.CloseExceptionKind.CASH_DIFFERENCE -> "Cash ${varianceLabel(e.amount,currency)}"
        com.sunpride.field.sell.pos.CloseExceptionKind.STOCK_DIFFERENCE -> "Stock count: ${e.amount} ${if (e.amount == 1L) "line" else "lines"} differed"
    }
    /** "Matches", "₱120.00 short" or "₱50.00 over". */
    fun varianceLabel(varianceMinor: Long, currency: String): String = when {
        varianceMinor == 0L -> "Matches"
        varianceMinor < 0 -> "${com.sunpride.field.sell.pos.PosMoney.format(Math.negateExact(varianceMinor),currency)} short"
        else -> "${com.sunpride.field.sell.pos.PosMoney.format(varianceMinor,currency)} over"
    }
    /** Plain words for each return refusal (VAN-019); [product] names the line when the problem is about one product. */
    fun returnMessage(problem: com.sunpride.field.sell.pos.ReturnProblem, product: String?): String {
        val p = product ?: "A product"
        return when (problem) {
            com.sunpride.field.sell.pos.ReturnProblem.TRIP_NOT_OPEN -> "Start the trip before taking returns."
            com.sunpride.field.sell.pos.ReturnProblem.NO_CUSTOMER -> "Choose a customer."
            com.sunpride.field.sell.pos.ReturnProblem.UNKNOWN_CUSTOMER -> "This customer is no longer on this phone. Choose the customer again."
            com.sunpride.field.sell.pos.ReturnProblem.EMPTY -> "Add at least one returned product."
            com.sunpride.field.sell.pos.ReturnProblem.TOO_MANY_LINES -> "Too many lines for one return (50 at most). Split the return."
            com.sunpride.field.sell.pos.ReturnProblem.DUPLICATE_LINE -> "$p is in the return twice with the same batch and reason. Remove one."
            com.sunpride.field.sell.pos.ReturnProblem.UNKNOWN_PRODUCT -> "A product is no longer on this phone. Remove it."
            com.sunpride.field.sell.pos.ReturnProblem.UNKNOWN_UNIT -> "$p: choose the unit you counted in."
            com.sunpride.field.sell.pos.ReturnProblem.BAD_QUANTITY -> "$p: enter a whole quantity above zero."
            com.sunpride.field.sell.pos.ReturnProblem.NO_REASON -> "$p: choose why it is returned."
            com.sunpride.field.sell.pos.ReturnProblem.NO_DISPOSITION -> "$p: choose what happens to the goods."
            com.sunpride.field.sell.pos.ReturnProblem.DISPOSITION_NOT_ALLOWED -> "$p: this choice is not allowed for that reason."
            com.sunpride.field.sell.pos.ReturnProblem.BATCH_MISSING -> "$p: enter the batch or lot number printed on the pack."
            com.sunpride.field.sell.pos.ReturnProblem.BATCH_INVALID -> "$p: the batch number can only have letters, numbers, spaces, - / and . (40 at most)."
            com.sunpride.field.sell.pos.ReturnProblem.EXPIRY_INVALID -> "$p: enter the expiry date as year-month-day, e.g. 2026-10-31."
            com.sunpride.field.sell.pos.ReturnProblem.UNKNOWN_SALE -> "That receipt is no longer on this phone. Choose another or none."
            com.sunpride.field.sell.pos.ReturnProblem.SALE_OTHER_CUSTOMER -> "That receipt is for another customer."
            com.sunpride.field.sell.pos.ReturnProblem.NOT_ON_SALE -> "$p is not on that receipt."
            com.sunpride.field.sell.pos.ReturnProblem.MORE_THAN_SOLD -> "$p: more than was sold on that receipt (earlier returns count)."
            com.sunpride.field.sell.pos.ReturnProblem.NOTE_INVALID -> "The note is too long (300 characters at most)."
            com.sunpride.field.sell.pos.ReturnProblem.STOCK_COUNTED -> "Truck stock is already counted. No more returns on this trip."
        }
    }
    /** Why the office must approve a return, in plain words. */
    fun approvalLabel(reason: com.sunpride.field.sell.pos.ReturnApprovalReason): String = when (reason) {
        com.sunpride.field.sell.pos.ReturnApprovalReason.DISPOSED_AT_OUTLET -> "Goods thrown away at the store"
        com.sunpride.field.sell.pos.ReturnApprovalReason.POLICY -> "This reason always needs approval"
        com.sunpride.field.sell.pos.ReturnApprovalReason.NOT_LINKED_TO_SALE -> "Not bought on a receipt from this phone"
        com.sunpride.field.sell.pos.ReturnApprovalReason.WALK_IN -> "Walk-in customer"
    }
    /** What a return line does to the truck stock. */
    fun stockEffectLabel(effect: com.sunpride.field.sell.pos.ReturnStockEffect, approvalRequired: Boolean): String = when (effect) {
        com.sunpride.field.sell.pos.ReturnStockEffect.AVAILABLE -> "Back in truck stock — can be sold"
        com.sunpride.field.sell.pos.ReturnStockEffect.DAMAGED -> if (approvalRequired) "Held on the truck with damaged stock until approved" else "On the truck with damaged stock"
        com.sunpride.field.sell.pos.ReturnStockEffect.NONE -> "Not on the truck"
    }
    /** VAN-017: what happened to a print, in plain words. A printer problem never changes the saved sale. */
    fun printMessage(result: com.sunpride.field.sell.printing.PrintJobResult): String = when (result) {
        is com.sunpride.field.sell.printing.PrintJobResult.Printed ->
            if (result.attempt.kind == com.sunpride.field.sell.printing.PrintKind.REPRINT) "Reprint copy ${result.attempt.copyNumber} printed. It is marked REPRINT."
            else if (result.attempt.kind == com.sunpride.field.sell.printing.PrintKind.VOID) "Void slip printed. The sale is cancelled."
            else "Receipt sent to the printer. Check the paper, then tell the phone if it printed."
        is com.sunpride.field.sell.printing.PrintJobResult.Failed -> when {
            result.attempt == null -> "Printer not ready: ${com.sunpride.field.sell.printing.PrinterWords.status(result.status)}. The sale is saved. Check the printer, then print again."
            result.mayHavePrinted && result.attempt.kind == com.sunpride.field.sell.printing.PrintKind.VOID -> "The printer stopped during the void slip. Check the paper. Use Reprint void slip for another copy."
            result.mayHavePrinted -> "The printer stopped during the receipt. Check the paper. Any new copy will be marked REPRINT."
            else -> "Not printed: ${com.sunpride.field.sell.printing.PrinterWords.status(result.status)}. The sale is saved. Print again."
        }
        is com.sunpride.field.sell.printing.PrintJobResult.Refused -> when (result.refusal) {
            com.sunpride.field.sell.printing.PrintRefusal.ALREADY_PRINTED -> "Receipt already printed. Use Reprint for another copy."
            com.sunpride.field.sell.printing.PrintRefusal.REASON_REQUIRED -> "Choose why you are reprinting."
            com.sunpride.field.sell.printing.PrintRefusal.LIMIT_REACHED -> "This receipt was reprinted ${com.sunpride.field.sell.printing.ReprintRules.MAX_REPRINTS} times already. Ask the office for a copy."
            com.sunpride.field.sell.printing.PrintRefusal.CONFIRM_FIRST -> "This receipt was sent to the printer ${com.sunpride.field.sell.printing.ReprintRules.MAX_REPRINTS + 1} times. Answer \"Did it print?\" or ask the office for a copy."
            com.sunpride.field.sell.printing.PrintRefusal.NOT_THIS_TRIP -> "Only receipts from this trip can be printed on the phone. Ask the office for a copy."
            com.sunpride.field.sell.printing.PrintRefusal.SALE_NOT_FOUND -> "This sale is not on this phone."
            com.sunpride.field.sell.printing.PrintRefusal.HELD -> "Sign in again to print."
            com.sunpride.field.sell.printing.PrintRefusal.PAPER_OUT -> "The printer is out of paper. Load paper, then print again."
        }
    }
    /** VAN-051: the line on "Did it print?" about re-sends; at zero it is the refusal itself. */
    fun printAgainNote(left: Int?): String? = when {
        left == null -> null
        left <= 0 -> printMessage(com.sunpride.field.sell.printing.PrintJobResult.Refused(com.sunpride.field.sell.printing.PrintRefusal.CONFIRM_FIRST))
        left == 1 -> "You can print it again 1 more time before you answer."
        else -> "You can print it again $left more times before you answer."
    }
    fun sourceLabel(source: String): String = when (source) { "route" -> "Route"; "unplanned" -> "Not on route"; else -> "Walk-in" }
}
