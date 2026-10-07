package com.sunpride.van.ui

import androidx.compose.runtime.*
import com.sunpride.van.AppEnvironment
import com.sunpride.van.VanFeatures
import com.sunpride.van.auth.*
import com.sunpride.van.data.*
import com.sunpride.van.pos.*
import com.sunpride.van.printing.*
import com.sunpride.van.storage.SavedSale
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*

/** One UI lifetime; no Activity, password persistence, identity selection, or raw error text. */
class VanController(val repository: VanRepository, val environment: AppEnvironment,
    val fixtureMode: Boolean = false,
    /** VAN-017: the one printer for this UI lifetime; the Activity selects and closes it. Tests inject a fake. */
    val printer: ReceiptPrinter = NoPrinter(),
    /** SP-0125: what this build shows (unfinished screens are hidden in release/beta). */
    val features: VanFeatures = VanFeatures.ALL,
    private val fingerprintLoader: suspend () -> String = { "Unavailable" }) {
    var page by mutableStateOf(Page.HOME)
        private set
    var session by mutableStateOf(SessionState())
        private set
    var enrollment by mutableStateOf<EnrollmentState>(EnrollmentState.SignedOut)
        private set
    var trip by mutableStateOf<Trip?>(null)
        private set
    var load by mutableStateOf<Load?>(null)
        private set
    var products by mutableStateOf(emptyList<Product>())
        private set
    var customers by mutableStateOf(emptyList<Customer>())
        private set
    var prices by mutableStateOf(emptyList<PriceLine>())
        private set
    var stock by mutableStateOf(emptyList<TruckStock>())
        private set
    var policy by mutableStateOf<VanPolicy?>(null)
        private set
    var seller by mutableStateOf<Seller?>(null)
        private set
    var sync by mutableStateOf(SyncStatus())
        private set
    var busy by mutableStateOf(false)
        private set
    var initialized by mutableStateOf(false)
        private set
    var message by mutableStateOf<String?>(null)
        private set
    var fingerprint by mutableStateOf("Loading…")
        private set
    var selectedCustomer by mutableStateOf<Customer?>(null)
        private set
    /** VAN-011: the sale being built. In memory only; [SaleDraft.saleId] makes Complete sale safe to repeat. */
    var sale by mutableStateOf<SaleDraft?>(null)
        private set
    /** True while Find product was opened from a sale: tapping a product adds it to the sale. */
    var pickingForSale by mutableStateOf(false)
        private set
    var lastReceipt by mutableStateOf<SaleReceipt?>(null)
        private set
    /** VAN-017: a print or reprint is running; Print buttons stay disabled until it finishes. */
    var printing by mutableStateOf(false)
        private set
    /** Plain-words result of the latest print, shown on Sale saved and Receipts. */
    var printMessage by mutableStateOf<String?>(null)
        private set
    /** The latest print outcome in this session, for the printer check screen. */
    var lastPrint by mutableStateOf<LastPrint?>(null)
        private set
    /** Sales saved on the current trip with their print history (Receipts page and Sale saved). */
    var savedSales by mutableStateOf(emptyList<SavedSale>())
        private set
    private var scope: CoroutineScope? = null

    suspend fun run(restore: Boolean = true): Unit = coroutineScope {
        scope = this
        launch { repository.sessionState.collect { session = it } }
        launch { repository.enrollmentState.collect { enrollment = it } }
        launch { repository.currentTrip.collect { trip = it } }
        launch { repository.load.collect { load = it } }
        launch { repository.products.collect { products = it } }
        launch { repository.customers.collect { customers = it } }
        launch { repository.priceLines.collect { prices = it } }
        launch { repository.truckStock.collect { stock = it } }
        launch { repository.policy.collect { policy = it } }
        launch { repository.seller.collect { seller = it } }
        launch { repository.syncStatus.collect { sync = it } }
        launch { fingerprint = try { fingerprintLoader() } catch (_: Exception) { "Unavailable. Check again." } }
        if (restore) {
            busy = true
            try {
                repository.restoreSession()
                if (repository.enrollmentState.value is EnrollmentState.Ready) repository.syncNow()
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { message = "Could not connect. Saved work stays on this phone. Try again." }
            finally { busy = false; initialized = true }
        } else initialized = true
        awaitCancellation()
    }
    private fun command(success: String? = null, block: suspend () -> Unit) {
        if (busy) return
        scope?.launch {
            busy = true; message = null
            try { block(); if (success != null) message = success }
            catch (e: CancellationException) { throw e }
            catch (_: Exception) { message = "Could not save this change. Check the details and try again." }
            finally { busy = false }
        }
    }
    fun open(next: Page) {
        page = next; message = null
        if (next == Page.RECEIPTS) { printMessage = null; refreshReceipts() }
    }
    fun back() {
        val target = when (page) {
            Page.WALK_IN, Page.CUSTOMER -> Page.CUSTOMERS
            Page.CHECKOUT -> Page.SALE
            Page.SALE -> Page.CUSTOMER
            Page.RETURN -> Page.CUSTOMER
            Page.PRODUCTS -> if (pickingForSale && sale != null) Page.SALE else Page.HOME
            else -> Page.HOME
        }
        if (page == Page.PRODUCTS) pickingForSale = false
        open(target)
    }
    fun select(customer: Customer) { selectedCustomer = customer; open(Page.CUSTOMER) }
    fun signIn(email: String, password: String) = command {
        repository.signIn(email.trim(),password)
        if (repository.enrollmentState.value is EnrollmentState.Ready) repository.syncNow()
    }
    fun signOut() = command { repository.signOut(); page = Page.HOME; sale = null; pickingForSale = false; lastReceipt = null; savedSales = emptyList(); printMessage = null; returnDraft = null; lastReturn = null }
    fun checkAgain() = command { repository.refreshEnrollment(); if (repository.enrollmentState.value is EnrollmentState.Ready) repository.syncNow() }
    fun syncNow() = command("Sync finished. Check the waiting and review counts.") { repository.syncNow() }
    // Pending state is read from the store (VanRules.status), never from a stale one-off message.
    fun confirmLoad(lines: List<LoadActual>) = command { repository.confirmLoad(lines) }
    fun startTrip(truck: Boolean, route: Boolean, driver: String, helper: String, odometer: Double?, note: String) = command {
        check(VanRules.canStart(trip,truck,route))
        repository.startTrip(truck,route,driver.takeIf { it.isNotBlank() },helper.takeIf { it.isNotBlank() },odometer,note.takeIf { it.isNotBlank() })
        page = Page.HOME
    }
    fun damage(product: Product, qty: Long, reason: String, note: String, onSaved: () -> Unit) = command {
        if (!repository.canRemove(product.productId,qty)) {
            message = "Not enough stock on the truck"
        } else {
            repository.recordDamage(product.productId,qty,reason,note.takeIf { it.isNotBlank() })
            message = "Damage saved — waiting for sync"; onSaved()
        }
    }
    fun startSale(customer: Customer) {
        if (!VanRules.canSell(trip)) { message = VanRules.checkoutMessage(CheckoutProblem.TRIP_NOT_SELLING,null); return }
        if (sale?.customer?.outletId != customer.outletId) sale = SaleDraft(CheckoutRules.newSaleId(),customer,emptyList())
        selectedCustomer = customer; open(Page.SALE)
    }
    fun continueSale() { sale?.let { selectedCustomer = it.customer; open(Page.SALE) } }
    fun pickProduct() { pickingForSale = true; open(Page.PRODUCTS) }
    /** Adds to the line for this product (one line per product); a quantity of zero removes the line. */
    fun addToSale(productId: String, quantityBase: Long) {
        val draft = sale ?: return
        val current = draft.lines.firstOrNull { it.productId == productId }?.quantityBase ?: 0L
        setSaleLine(productId,Math.addExact(current,quantityBase))
        pickingForSale = false; open(Page.SALE)
    }
    fun setSaleLine(productId: String, quantityBase: Long) {
        val draft = sale ?: return
        val lines = if (quantityBase <= 0) draft.lines.filterNot { it.productId == productId }
            else if (draft.lines.any { it.productId == productId }) draft.lines.map { if (it.productId == productId) it.copy(quantityBase = quantityBase) else it }
            else draft.lines + CartLine(productId,quantityBase)
        sale = draft.copy(lines = lines)
    }
    fun cancelSale() { sale = null; pickingForSale = false; open(Page.HOME) }
    /** VAN-012 credit sold here / references used; refreshed when Checkout opens (the store re-checks while saving). */
    var paymentFacts by mutableStateOf(com.sunpride.van.storage.PaymentFacts())
        private set
    suspend fun refreshPaymentFacts() { paymentFacts = runCatching { repository.paymentFacts() }.getOrDefault(com.sunpride.van.storage.PaymentFacts()) }
    fun saleContext(now: Long = System.currentTimeMillis()): CheckoutContext =
        CheckoutContext(VanRules.canSell(trip) && session.signedIn,customers,products,stock,prices,policy,now,trip?.serviceDate,
            paymentFacts.creditUsedMinor,paymentFacts.usedReferences)
    fun quote(payment: PaymentInput): CheckoutResult? = sale?.let { CheckoutRules.evaluate(CheckoutRequest(it.saleId,it.customer.outletId,it.lines,payment),saleContext()) }
    /** Lines and total of the cart alone, before a payment is entered. */
    fun cartQuote(): CheckoutQuote? = sale?.let { CheckoutRules.cartQuote(CheckoutRequest(it.saleId,it.customer.outletId,it.lines,PaymentInput(PaymentMethod.CASH.code)),saleContext()) }
    /** Payment methods the office allows (cash only until the policy says otherwise). */
    val paymentMethods: List<PaymentMethod> get() = policy?.paymentMethods ?: PaymentMethod.CASH_ONLY
    /** The store validates again in the saving transaction; a refusal keeps the cart so the seller can fix it. */
    fun completeSale(payment: PaymentInput, expectedTotalMinor: Long) = command {
        val draft = checkNotNull(sale)
        try {
            val receipt = repository.completeSale(CheckoutRequest(draft.saleId,draft.customer.outletId,draft.lines,payment),expectedTotalMinor)
            lastReceipt = receipt; sale = null; page = Page.SALE_DONE; printMessage = null
            // VAN-017: the sale is saved first; the receipt prints after, and a printer problem never touches the sale.
            startPrint(receipt.saleId,explicit = false,reason = null)
        } catch (e: CheckoutRefused) {
            message = e.issues.joinToString("\n") { issue -> VanRules.checkoutMessage(issue.problem,issue.productId?.let { id -> products.firstOrNull { it.productId == id }?.name }) }
        }
    }
    /** VAN-019: the return being captured. In memory only; [ReturnDraft.returnId] makes Save return safe to repeat. */
    var returnDraft by mutableStateOf<ReturnDraft?>(null)
        private set
    var lastReturn by mutableStateOf<ReturnReceipt?>(null)
        private set
    /** Sales saved here and quantities already returned against them; refreshed when a return opens. */
    var returnFacts by mutableStateOf<ReturnContext?>(null)
        private set
    fun startReturn(customer: Customer) {
        if (!VanRules.canSell(trip)) { message = VanRules.returnMessage(ReturnProblem.TRIP_NOT_OPEN,null); return }
        if (returnDraft?.customer?.outletId != customer.outletId) returnDraft = ReturnDraft(ReturnRules.newReturnId(),customer,null,emptyList())
        selectedCustomer = customer; open(Page.RETURN)
        scope?.launch { returnFacts = runCatching { repository.returnContext() }.getOrNull() }
    }
    fun addReturnLine(line: ReturnLineInput) { returnDraft = returnDraft?.let { it.copy(lines = it.lines + line) } }
    fun removeReturnLine(index: Int) { returnDraft = returnDraft?.let { d -> d.copy(lines = d.lines.filterIndexed { i,_ -> i != index }) } }
    fun linkReturnSale(saleId: String?) { returnDraft = returnDraft?.copy(originalSaleId = saleId) }
    fun cancelReturn() { returnDraft = null; open(Page.CUSTOMER) }
    fun returnContext(): ReturnContext = ReturnContext(VanRules.canSell(trip) && session.signedIn,customers,products,
        returnFacts?.sales ?: emptyList(),returnFacts?.returnedBase ?: emptyMap())
    fun returnResult(note: String): ReturnResult? = returnDraft?.let { ReturnRules.evaluate(ReturnRequest(it.returnId,it.customer.outletId,it.originalSaleId,it.lines,note),returnContext()) }
    /** The store validates again in the saving transaction; a refusal keeps the draft so the seller can fix it. */
    fun saveReturn(note: String) = command {
        val draft = checkNotNull(returnDraft)
        try {
            lastReturn = repository.recordReturn(ReturnRequest(draft.returnId,draft.customer.outletId,draft.originalSaleId,draft.lines,note.takeIf { it.isNotBlank() }))
            returnDraft = null; page = Page.RETURN_DONE
        } catch (e: ReturnRefused) {
            message = e.issues.joinToString("\n") { issue -> VanRules.returnMessage(issue.problem,issue.productId?.let { id -> products.firstOrNull { it.productId == id }?.name }) }
        } catch (_: ReturnReplayConflict) {
            message = "This return was already saved with different details. Cancel it and record a new return."
        }
    }
    /** Print the receipt again: the original if it never reached paper, else a REPRINT copy that needs [reason]. */
    fun printReceipt(saleId: String, reason: String? = null) = startPrint(saleId,explicit = true,reason = reason)
    fun refreshReceipts() {
        scope?.launch { savedSales = runCatching { repository.savedSales() }.getOrElse { if (it is CancellationException) throw it; savedSales } }
    }
    private fun startPrint(saleId: String, explicit: Boolean, reason: String?) {
        if (printing) return
        val s = scope ?: return
        printing = true; printMessage = "Printing…"
        s.launch {
            try {
                val result = repository.printReceipt(printer,saleId,explicit,reason)
                printMessage = VanRules.printMessage(result)
                lastPrint = LastPrint(System.currentTimeMillis(),printMessage!!,result is PrintJobResult.Printed)
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { printMessage = "Could not print. The sale is saved. Try again." }
            finally {
                printing = false
                savedSales = runCatching { repository.savedSales() }.getOrDefault(savedSales)
            }
        }
    }
    fun walkIn(name: String, reason: String) = command {
        repository.addWalkInCustomer(name.trim(),reason.trim()); page = Page.CUSTOMERS
    }
}
/** A return being captured for one customer (VAN-019); [originalSaleId] links it to a sale saved on this phone. */
data class ReturnDraft(val returnId: String, val customer: Customer, val originalSaleId: String?, val lines: List<ReturnLineInput>)
/** VAN-017: the latest print result in this session, shown on the printer check. */
data class LastPrint(val at: Long, val text: String, val printed: Boolean)
/** A sale being built for one customer (VAN-011). */
data class SaleDraft(val saleId: String, val customer: Customer, val lines: List<CartLine>)
