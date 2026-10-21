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
import org.json.JSONObject
import java.util.UUID

/** One UI lifetime; no Activity, password persistence, identity selection, or raw error text. */
class VanController(val repository: VanRepository, val environment: AppEnvironment,
    val fixtureMode: Boolean = false,
    /** VAN-017: the one printer for this UI lifetime; the Activity selects and closes it. Tests inject a fake. */
    val printer: ReceiptPrinter = NoPrinter(),
    /** SP-0125: what this build shows (unfinished screens are hidden in release/beta). */
    val features: VanFeatures = VanFeatures.ALL,
    /** Instrumentation can inject actual JPEG bytes; never selected by an intent or available in release. */
    val damagePhotoSource: (suspend () -> com.sunpride.van.evidence.DamageCapture)? = null,
    /** SP-0137: live-location sharing during a trip; [LocationSharing.Disabled] shows nothing and never tracks. */
    val locationSharing: com.sunpride.van.location.LocationSharing = com.sunpride.van.location.LocationSharing.Disabled,
    /** F-106: instrumentation-only sample GPS seam, never selected by intents or available in release. */
    val callLocationSource: (suspend () -> org.json.JSONObject?)? = null,
    private val publicKeyLoader: suspend () -> String? = { null },
    private val fingerprintLoader: suspend () -> String = { "Unavailable" }) {
    init { require(damagePhotoSource == null || fixtureMode && com.sunpride.van.BuildConfig.DEBUG); require(callLocationSource == null || com.sunpride.van.BuildConfig.DEBUG) }
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
    var promotions by mutableStateOf(emptyList<Promotion>())
        private set
    var stock by mutableStateOf(emptyList<TruckStock>())
        private set
    var damageRecords by mutableStateOf(emptyList<DamageRecord>())
        private set
    var policy by mutableStateOf<VanPolicy?>(null)
        private set
    var seller by mutableStateOf<Seller?>(null)
        private set
    var sync by mutableStateOf(SyncStatus())
        private set
    /** The office has not (re)confirmed this phone's access: trip data hidden, saved work kept. */
    var onHold by mutableStateOf(false)
        private set
    var busy by mutableStateOf(false)
        private set
    var initialized by mutableStateOf(false)
        private set
    var message by mutableStateOf<String?>(null)
        private set
    var fingerprint by mutableStateOf("Loading…")
    /** Public key (never secret) an administrator pastes into phone registration. */
    var publicKey by mutableStateOf<String?>(null)
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
    /** VAN-022: the trip's cash is counted on this phone, so selling has stopped. */
    var cashCounted by mutableStateOf(false)
        private set
    /** VAN-023: the trip's physical stock is counted on this phone, so stock changes have stopped. */
    var stockCounted by mutableStateOf(false)
        private set
    /** VAN-022: what Count cash shows; refreshed whenever the page opens or a count is saved. */
    var cashSummary by mutableStateOf<com.sunpride.van.storage.CashSummary?>(null)
        private set
    /** Count cash draft; [CashDraft.reconciliationId] makes Save cash count safe to tap twice. In memory only. */
    var cashDraft by mutableStateOf(CashDraft(CashReconciliationRules.newReconciliationId()))
        private set
    /** Count stock draft; [StockDraft.reconciliationId] makes Save count safe to tap twice. In memory only. */
    var stockSummary by mutableStateOf<com.sunpride.van.pos.StockSummary?>(null)
        private set
    var batchCountPositions by mutableStateOf(emptyList<com.sunpride.van.ledger.BatchPosition>())
        private set
    var stockDraft by mutableStateOf(StockDraft(StockReconciliationRules.newCountId()))
        private set
    /** VAN-024: the trip is closed on this phone; nothing more is recorded on it. */
    var tripClosed by mutableStateOf(false)
        private set
    /** VAN-024: what Close trip shows; refreshed whenever the page opens, after a sync and after closing. */
    var closeSummary by mutableStateOf<TripCloseSummary?>(null)
        private set
    /** Close trip form; [CloseDraft.closeId] makes Close trip safe to tap twice. In memory only. */
    var closeDraft by mutableStateOf(CloseDraft(TripCloseRules.newCloseId()))
        private set
    private var scope: CoroutineScope? = null
    /** SP-0137: what the seller sees about location sharing (Today indicator, consent page). */
    var sharing by mutableStateOf(com.sunpride.van.location.SharingState.NOT_ON_TRIP)
        private set
    /** SP-0137: the seller agreed to location sharing on this phone. */
    var locationConsented by mutableStateOf(false)
        private set
    /** SP-0137: live-location pings waiting on this phone. */
    var pendingPings by mutableIntStateOf(0)
        private set
    private var storeScope: com.sunpride.van.storage.StoreScope? = null
    /** Start trip waiting for the consent page to be answered. */
    private var pendingStart: (suspend () -> Unit)? = null
    private var syncFailureNotice: SyncFailureNotice? = null
    private fun rememberSyncFailure(text: String): String {
        syncFailureNotice=SyncFailureNotice(text,System.currentTimeMillis())
        return text
    }
    private fun acceptSyncStatus(status: SyncStatus) {
        sync=status
        val notice=syncFailureNotice
        if (notice != null && notice.resolved(status) && message==notice.text) {
            message=null; syncFailureNotice=null
        }
    }

    suspend fun run(restore: Boolean = true): Unit = coroutineScope {
        scope = this
        launch { repository.sessionState.collect { session = it; refreshSharing() } }
        launch { repository.enrollmentState.collect { enrollment = it; refreshSharing() } }
        launch { repository.currentTrip.collect { trip = it; refreshSharing() } }
        launch { repository.load.collect { load = it } }
        launch { repository.products.collect { products = it } }
        launch { repository.customers.collect { customers = it } }
        launch { repository.priceLines.collect { prices = it } }
        launch { repository.promotions.collect { promotions = it } }
        launch { repository.truckStock.collect { stock = it } }
        launch { repository.policy.collect { policy = it } }
        launch { repository.damageRecords.collect { damageRecords = it } }
        launch { repository.seller.collect { seller = it } }
        launch { repository.syncStatus.collect(::acceptSyncStatus) }
        launch { repository.onHold.collect { onHold = it } }
        launch { repository.cashCounted.collect { cashCounted = it } }
        launch { repository.stockCounted.collect { stockCounted = it } }
        launch { repository.tripClosed.collect { tripClosed = it; refreshSharing() } }
        launch { repository.storeScope.collect { storeScope = it; refreshSharing() } }
        launch { repository.pendingPings.collect { pendingPings = it } }
        launch { fingerprint = try { fingerprintLoader() } catch (_: Exception) { "Unavailable. Check again." } }
        launch { publicKey = try { publicKeyLoader() } catch (_: Exception) { null } }
        if (restore) {
            busy = true
            try {
                repository.restoreSession()
                if (repository.enrollmentState.value is EnrollmentState.Ready) repository.syncNow()
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                // A sync refusal is not a connection problem; say what actually happened.
                message = rememberSyncFailure(if (e is com.sunpride.van.sync.VanSyncFailure) syncMessage(e)
                    else AuthMessages.forFailure(e,"Could not connect. Saved work stays on this phone. Try again."))
            }
            finally { busy = false; initialized = true; refreshSharing() }
        } else { initialized = true; refreshSharing() }
        awaitCancellation()
    }
    private fun command(success: String? = null,
        /** SP-0130: sign-in and registration pass [AuthMessages] so a wrong password reads as one. */
        failure: (Exception) -> String = { "Could not save this change. Check the details and try again." },
        block: suspend () -> Unit) {
        if (busy) return
        scope?.launch {
            busy = true; message = null
            try { block(); if (success != null) message = success }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                // Debug builds only: type, code and frames, never the message (it can echo server text).
                if (com.sunpride.van.BuildConfig.DEBUG) android.util.Log.w("SunprideVan","command failed: ${e.javaClass.simpleName} " +
                    "${(e as? com.sunpride.van.sync.VanSyncFailure)?.code ?: ""} at " + e.stackTrace.take(8).joinToString(" < ") { "${it.className.substringAfterLast('.')}.${it.methodName}:${it.lineNumber}" })
                message = failure(e)
            }
            finally { busy = false }
        }
    }
    /** Plain words for a failed sync; saved work is never lost by a failed sync. */
    internal fun syncMessage(e: Exception): String = when (e) {
        is com.sunpride.van.sync.VanSyncFailure -> when (e.code) {
            "unauthorized" -> "The office did not accept this phone's work. Your work is kept here. Ask your supervisor."
            "version_unsupported" -> "This app needs an update. Your work is kept here."
            "temporarily_unavailable" -> "Could not reach the office. Your work is kept here. Try again."
            else -> "The office could not take this work yet. Your work is kept here. Try again."
        }
        is com.sunpride.van.auth.AuthFailure -> e.kind.message
        else -> "Could not sync. Your work is kept here. Try again."
    }
    fun open(next: Page) {
        page = next; message = null
        if (next == Page.RECEIPTS) { printMessage = null; refreshReceipts() }
        if (next == Page.CASH) refreshCash()
        if (next == Page.STOCK_COUNT) refreshStock()
        if (next == Page.CLOSE_TRIP) refreshClose()
    }
    fun back() {
        val target = when (page) {
            Page.CHANGE_PASSWORD -> Page.ACCOUNT
            Page.WALK_IN, Page.CUSTOMER -> Page.CUSTOMERS
            Page.CHECKOUT -> Page.SALE
            Page.SALE -> Page.CUSTOMER
            Page.RETURN -> Page.CUSTOMER
            Page.STOCK_COUNT -> Page.HOME
            Page.LOCATION_CONSENT -> if (pendingStart != null) Page.START else Page.HOME
            Page.PRODUCTS -> if (pickingForSale && sale != null) Page.SALE else Page.HOME
            else -> Page.HOME
        }
        if (page == Page.PRODUCTS) pickingForSale = false
        if (page == Page.LOCATION_CONSENT) pendingStart = null
        open(target)
    }
    var callFlow by mutableStateOf<org.json.JSONObject?>(null); private set
    var currentCall by mutableStateOf<org.json.JSONObject?>(null); private set
    private suspend fun refreshCall() {
        val selected = selectedCustomer ?: return
        val config = repository.callConfig(selected.outletId)
        val current = repository.openCall()
        if (selectedCustomer?.outletId == selected.outletId) { callFlow = config; currentCall = current }
    }
    fun select(customer: Customer) {
        selectedCustomer = customer; callFlow = null; currentCall = null; open(Page.CUSTOMER)
        scope?.launch { runCatching { refreshCall() } }
    }
    fun recordCallFlow(kind: String, context: android.content.Context, options: org.json.JSONObject) {
        val selected = selectedCustomer ?: return
        if (busy) return
        scope?.launch {
            busy=true; message=null
            try {
                val fix=if (callLocationSource != null) callLocationSource.invoke() else com.sunpride.callflow.AndroidCallLocation.capture(context)
                repository.recordCall(kind,selected.outletId,fix,options)
                refreshCall(); message="Call saved on this phone. Sync sends it to the office."
            } catch(e: CancellationException) { throw e }
              catch(e: com.sunpride.callflow.CallFlowRefused) { message=e.message }
              catch(_: Exception) { message="Could not save call. Check the required fields and sync for access." }
            finally { busy=false }
        }
    }
    fun requestCallGeofence(reason: String, started: Boolean) {
        val selected=selectedCustomer ?: return
        if (busy) return
        scope?.launch {
            busy=true
            try { repository.requestCallGeofence(selected.outletId,reason,if (started) "geofence_end" else "geofence_start"); message="Sent for supervisor approval. Sync after approval and try again with a fresh location." }
            catch (e: CancellationException) { throw e }
            catch (_: Exception) { message="Connect to request approval. No call action was recorded." }
            finally { busy=false }
        }
    }
    fun recordCallFlowStep(options: org.json.JSONObject) {
        val selected=selectedCustomer ?: return
        if (busy) return
        scope?.launch {
            busy=true; message=null
            try { repository.recordCall("call.step",selected.outletId,null,options); refreshCall(); message="Call activity saved on this phone." }
            catch(e: CancellationException) { throw e }
            catch(e: com.sunpride.callflow.CallFlowRefused) { message=e.message }
            catch(_: Exception) { message="Could not save stock check. Sync for access and try again." }
            finally { busy=false }
        }
    }
    fun signIn(email: String, password: String) = command(failure = { AuthMessages.forFailure(it,AuthMessages.SIGN_IN_FALLBACK) }) {
        repository.signIn(email.trim(),password)
        if (repository.enrollmentState.value is EnrollmentState.Ready) repository.syncNow()
    }
    var companySignInPending by mutableStateOf(false)
        private set
    fun updateCompanyWaiting(value: Boolean) { companySignInPending=value }
    fun companyKey(): org.json.JSONObject = repository.companyKey()
    fun replacementCode(): org.json.JSONObject = repository.replacementCode()
    fun sapMasters(refresh: Boolean): org.json.JSONObject? = repository.sapMasters(refresh)
    fun sapMasterLifetime(): String? = repository.sapMasterLifetime()
    fun appUpdates(): com.sunpride.integrity.AppUpdateClient = repository.appUpdates()
    fun signCompanyMessage(message: String): String = repository.signCompanyMessage(message)
    fun companySignIn(tokens: org.json.JSONObject) = command {
        repository.companySignIn(tokens)
        if(repository.enrollmentState.value is EnrollmentState.Ready) repository.syncNow()
    }
    fun changePassword(current: String, next: String, confirm: String) = command(failure = {
        (it as? PasswordChangeFailure)?.problem?.words ?: "Could not change your password. Try again shortly."
    }) {
        repository.changePassword(current,next,confirm)
        page = Page.ACCOUNT
        message = "Password changed. Your other sign-ins have ended."
    }
    fun signOut() = command { stopSharing(); repository.signOut(); page = Page.HOME; sale = null; pickingForSale = false; lastReceipt = null; savedSales = emptyList(); printMessage = null; returnDraft = null; lastReturn = null; cashSummary = null; cashDraft = CashDraft(CashReconciliationRules.newReconciliationId()); stockSummary = null; stockDraft = StockDraft(StockReconciliationRules.newCountId()); closeSummary = null; closeDraft = CloseDraft(TripCloseRules.newCloseId()) }
    fun checkAgain() = command(failure = { AuthMessages.forFailure(it,AuthMessages.CHECK_FALLBACK) }) { repository.refreshEnrollment(); if (repository.enrollmentState.value is EnrollmentState.Ready) repository.syncNow() }
    fun syncNow() = command("Sync finished. Check the waiting and review counts.",failure = { rememberSyncFailure(syncMessage(it)) }) { repository.syncNow() }
    // Pending state is read from the store (VanRules.status), never from a stale one-off message.
    fun confirmLoad(lines: List<LoadActual>) = command { repository.confirmLoad(lines) }
    fun startTrip(truck: Boolean, route: Boolean, driver: String, helper: String, odometer: Double?, note: String) {
        val start: suspend () -> Unit = {
            check(VanRules.canStart(trip,truck,route))
            repository.startTrip(truck,route,driver.takeIf { it.isNotBlank() },helper.takeIf { it.isNotBlank() },odometer,note.takeIf { it.isNotBlank() })
            page = Page.HOME
            refreshSharing()
        }
        // SP-0137: the one-time location consent comes first; the trip starts whatever the answer.
        if (locationSharing.enabled && storeScope != null && !(locationConsented && locationSharing.permitted())) {
            if (busy) return
            pendingStart = start; open(Page.LOCATION_CONSENT)
        } else command { start() }
    }
    /**
     * SP-0137: recompute location sharing from the trip, consent and Android permission, and start or stop the
     * service. Tracking happens only while signed in on a registered phone with the trip on the road.
     */
    fun refreshSharing() {
        val sc = storeScope
        val ready = session.signedIn && enrollment is EnrollmentState.Ready && sc != null
        locationConsented = sc != null && locationSharing.enabled && locationSharing.consented(sc)
        val permitted = locationSharing.enabled && locationSharing.permitted()
        sharing = if (!locationSharing.enabled || !ready) com.sunpride.van.location.SharingState.NOT_ON_TRIP
            else com.sunpride.van.location.SharingRules.state(trip,tripClosed,locationConsented,permitted)
        // Never decide before the saved trip and session are read: a stale "no trip" would end sharing.
        if (!initialized || !locationSharing.enabled) return
        locationSharing.update(sc,ready && com.sunpride.van.location.TripTracking.shouldTrack(true,trip,tripClosed,locationConsented,permitted))
    }
    private fun stopSharing() { if (locationSharing.enabled) locationSharing.update(storeScope,false) }
    /** Today's "Location sharing" row: the consent page (also to turn it off). */
    fun openLocationSharing() { pendingStart = null; open(Page.LOCATION_CONSENT) }
    /** The seller agreed; the screen then asks Android for the location permission and calls [finishLocationConsent]. */
    fun acceptLocationSharing(onReady: () -> Unit = {}) = changeLocationConsent(true,onReady)
    /** Stop locally immediately, including offline; notify the office without ever re-enabling locally. */
    fun withdrawLocationSharing() = changeLocationConsent(false,::finishLocationConsent)
    private fun changeLocationConsent(accepted: Boolean, onReady: () -> Unit) {
        val sc=storeScope ?: return
        if (busy) return
        if (!accepted) { locationSharing.setConsent(sc,false); refreshSharing() }
        scope?.launch {
            busy=true; message=null
            var saved=false
            try {
                repository.setLocationConsent(accepted)
                if (accepted) locationSharing.setConsent(sc,true)
                refreshSharing(); saved=true
            } catch (e: CancellationException) { throw e }
              catch (_: Exception) { message=if (accepted) "Could not reach the office. Location sharing is still off. Connect and try again."
                  else "Location sharing is off on this phone. Could not tell the office yet. Connect and try again." }
            finally { busy=false }
            if (saved) onReady()
        }
    }
    /** After the consent page: run a waiting Start trip, else back to Today. */
    fun finishLocationConsent() {
        refreshSharing()
        val start = pendingStart; pendingStart = null
        if (start != null) { page = Page.START; command { start() } }
        else { open(Page.HOME); if (locationConsented && !locationSharing.permitted()) message = LOCATION_OFF_MESSAGE }
    }
    fun damage(product: Product, qty: Long, reason: String, note: String, photoSha256: String? = null, onSaved: () -> Unit) = command {
        try {
            if (!repository.canRemove(product.productId,qty)) {
                message = if (tripClosed) VanRules.stockMessage(StockProblem.TRIP_CLOSED) else if (stockCounted) VanRules.stockMessage(StockProblem.STOCK_COUNTED) else "Not enough stock on the truck"
            } else {
                repository.recordDamage(product.productId,qty,reason,note.takeIf { it.isNotBlank() },photoSha256)
                message = "Damage saved on this phone."; onSaved()
            }
        } catch (e: StockRefused) { message = VanRules.stockMessage(e.problem) }
    }
    fun discardDamagePhoto(sha: String) { scope?.launch { runCatching { repository.discardDamagePhoto(sha) } } }
    var retailCall by mutableStateOf<com.sunpride.retail.RetailCall?>(null); private set
    var retailSaved by mutableStateOf(false); private set
    var retailLoaded by mutableStateOf(false); private set
    fun refreshRetail() = scope?.launch {
        val draft=sale ?: return@launch
        try {
            val call=repository.retailCall(draft.customer.outletId)
            val saved=repository.retailSaved(draft.saleId)
            if(sale?.saleId==draft.saleId){retailCall=call;retailSaved=saved;retailLoaded=true}
        } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
        catch (_: Exception) { if(sale?.saleId==draft.saleId){retailCall=null;retailSaved=false;retailLoaded=false;message="Could not open the downloaded MSL. Reopen this call after signing in."} }
    }
    fun saveRetail(answers: List<com.sunpride.retail.ShelfAnswer>,quantities: Map<String,Long>) = command {
        val draft=checkNotNull(sale);val call=checkNotNull(retailCall)
        repository.saveRetail(call,draft.saleId,answers,quantities)
        if(sale?.saleId==draft.saleId){
            for((id,qty) in quantities) if(qty>0)setSaleLine(id,maxOf(draft.lines.firstOrNull {it.productId==id}?.quantityBase ?: 0L,qty))
            retailSaved=true;message="Availability saved. Absent products are proposed on this editable order."
        }
    }
    fun startSale(customer: Customer) {
        if (tripClosed) {
            message = TRIP_CLOSED_MESSAGE
            return
        }
        if (!VanRules.canSell(trip)) {
            message = VanRules.checkoutMessage(CheckoutProblem.TRIP_NOT_SELLING,null)
            return
        }
        if (cashCounted) {
            message = VanRules.checkoutMessage(CheckoutProblem.CASH_COUNTED,null)
            return
        }
        if (stockCounted) {
            message = VanRules.checkoutMessage(CheckoutProblem.STOCK_COUNTED,null)
            return
        }
        if (sale?.customer?.outletId != customer.outletId) {discountEpoch++;discountMessage=null;sale = SaleDraft(CheckoutRules.newSaleId(),customer,emptyList())}
        selectedCustomer = customer; retailCall=null; retailSaved=false; retailLoaded=false; open(Page.SALE)
        refreshRetail()
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
        sale = draft.copy(lines = lines,manualDiscount=draft.manualDiscount?.copy(lineMinor=draft.manualDiscount.lineMinor.filterKeys{id->lines.any{it.productId==id}},requestId=UUID.randomUUID().toString(),approval=null),priceOverride=draft.priceOverride?.let{it.copy(unitMinor=it.unitMinor.filterKeys{id->lines.any{it.productId==id}},authorization=it.authorization.copy(requestId=UUID.randomUUID().toString(),approval=null))},creditOverride=draft.creditOverride?.copy(requestId=UUID.randomUUID().toString(),approval=null))
        discountMessage=null
        discountEpoch++
    }
    fun cancelSale() { discountEpoch++;discountMessage=null;sale = null; pickingForSale = false; open(Page.HOME) }
    /** VAN-012 credit sold here / references used; refreshed when Checkout opens (the store re-checks while saving). */
    var paymentFacts by mutableStateOf(com.sunpride.van.storage.PaymentFacts())
        private set
    suspend fun refreshPaymentFacts() { paymentFacts = runCatching { repository.paymentFacts() }.getOrDefault(com.sunpride.van.storage.PaymentFacts()) }
    fun saleContext(now: Long = System.currentTimeMillis()): CheckoutContext =
        CheckoutContext(VanRules.canSell(trip) && session.signedIn,customers,products,stock,prices,policy,now,trip?.serviceDate,
            paymentFacts.creditUsedMinor,paymentFacts.usedReferences,cashCounted,promotions,stockCounted)
    fun quote(payment: PaymentInput): CheckoutResult? = sale?.let { CheckoutRules.evaluate(CheckoutRequest(it.saleId,it.customer.outletId,it.lines,payment,it.manualDiscount,it.priceOverride,it.creditOverride),saleContext()) }
    /** Lines and total of the cart alone, before a payment is entered. */
    fun cartQuote(ignoreManual:Boolean=false,ignorePrices:Boolean=false): CheckoutQuote? = sale?.let { CheckoutRules.cartQuote(CheckoutRequest(it.saleId,it.customer.outletId,it.lines,PaymentInput(PaymentMethod.CASH.code),if(ignoreManual)null else it.manualDiscount,if(ignorePrices)null else it.priceOverride,it.creditOverride),saleContext()) }
    /** F-124: retire every cart-bound grant when another financial fact changes. */
    fun setSalePrices(input:SalePriceOverride?){
        sale=sale?.let{d->d.copy(priceOverride=input?.copy(authorization=input.authorization.copy(reason=input.authorization.reason.trim(),requestId=UUID.randomUUID().toString(),approval=null)),manualDiscount=d.manualDiscount?.copy(requestId=UUID.randomUUID().toString(),approval=null),creditOverride=null)}
        discountEpoch++;financialMessage=null;discountMessage=null
    }
    fun setCreditExceptionReason(reason:String){sale=sale?.copy(creditOverride=FinancialOverride(reason=reason));discountEpoch++;financialMessage=null}
    var financialMessage by mutableStateOf<String?>(null)
        private set
    private fun financialInput(kind:String)=if(kind=="price")sale?.priceOverride?.authorization else sale?.creditOverride
    private fun financialRequest(input:FinancialOverride?=null,kind:String="price"):CheckoutRequest {
        val d=checkNotNull(sale)
        return CheckoutRequest(d.saleId,d.customer.outletId,d.lines,PaymentInput("cash"),d.manualDiscount,if(kind=="price"&&input!=null)d.priceOverride?.copy(authorization=input)else d.priceOverride,if(kind=="credit"&&input!=null)input else d.creditOverride)
    }
    private fun financialFacts(kind:String)=sale?.let{d->cartQuote()?.let{SaleAdjustments.facts(kind,financialRequest(kind=kind),it.lines,saleContext())}}
    private fun financialFingerprint(kind:String)=financialFacts(kind)?.let{com.sunpride.integrity.OfflineApproval.factsHash(it)}
    private fun setFinancialInput(kind:String,input:FinancialOverride){sale=sale?.let{d->if(kind=="price")d.copy(priceOverride=d.priceOverride?.copy(authorization=input))else d.copy(creditOverride=input)}}
    fun requestCartOverride(kind:String)=command{
        require(kind in listOf("price","credit"));val epoch=++discountEpoch;val input=checkNotNull(financialInput(kind));val request=financialRequest(kind=kind)
        val quote=checkNotNull(cartQuote());val facts=checkNotNull(financialFacts(kind));val fingerprint=financialFingerprint(kind);val valid=repository.fiscalLifetime()
        val fiscal=JSONObject(checkNotNull(policy?.fiscalJson));val a=fiscal.getJSONObject("authority")
        val amount=if(kind=="price")SaleAdjustments.priceAmount(request,quote.lines,saleContext())else quote.totalMinor
        val response=repository.fiscalRequest("overrides/request",JSONObject().put("id",input.requestId).put("expectedRequesterId",a.getString("profileId")).put("orgUnitId",a.getString("orgUnitId")).put("kind",kind)
            .put("channel",fiscal.getJSONObject("customerChannels").getString(checkNotNull(request.customerId))).put("amountCentavos",amount.toString()).put("reason",input.reason.trim()).put("facts",facts))
        check(valid()&&epoch==discountEpoch&&financialInput(kind)?.requestId==input.requestId&&financialFingerprint(kind)==fingerprint){"The cart changed; request this exception again"}
        financialMessage=if(response.getBoolean("requiresSecond"))"$kind request saved. Another person must approve this exact cart."else"$kind reason recorded within your current authority. Sync checks it again."
    }
    fun checkCartOverride(kind:String)=command{
        require(kind in listOf("price","credit"));val epoch=++discountEpoch;val input=checkNotNull(financialInput(kind));val fingerprint=financialFingerprint(kind);val valid=repository.fiscalLifetime()
        val response=try{repository.fiscalRequest("overrides/status",JSONObject().put("id",input.requestId))}catch(e:Exception){if(epoch==discountEpoch&&financialFingerprint(kind)==fingerprint&&e is NativeApiFailure&&e.status in 400..499)setFinancialInput(kind,input.copy(approval=null,denied=true));throw e}
        check(valid()&&epoch==discountEpoch&&financialInput(kind)?.requestId==input.requestId&&financialFingerprint(kind)==fingerprint){"The cart changed; request this exception again"}
        if(!response.isNull("grant"))acceptCartOverride(kind,response.getString("grant"),true)else{
            val status=response.getString("status");setFinancialInput(kind,input.copy(approval=null,denied=status!="within_own_limit"));financialMessage="$kind: "+when(status){"within_own_limit"->"Reason recorded within your authority.";"rejected"->"The office refused this request.";"consumed"->"Already used. Check the saved invoice.";else->"Waiting for another authorized person."}
        }
    }
    fun acceptCartOverride(kind:String,token:String,renewed:Boolean=false){
        val input=financialInput(kind)?:return;val q=cartQuote()?:return;val updated=input.copy(approval=token.trim(),denied=input.denied&&!renewed)
        val problem=SaleAdjustments.authorize(kind,financialRequest(updated,kind),q.lines,saleContext());discountEpoch++
        if(problem!=null){setFinancialInput(kind,input.copy(approval=null,denied=true));financialMessage=VanRules.checkoutMessage(problem,null);return};setFinancialInput(kind,updated);financialMessage="$kind approval matches this cart. SAP and current authority are still checked on sync."
    }
    /** F-112: check the current cart through the existing SAP gateway, not a local credit calculator. */
    fun checkSaleCredit()=command{
        val draft=checkNotNull(sale);val quote=checkNotNull(cartQuote());val valid=repository.fiscalLifetime()
        val view=checkNotNull(CreditExposure.view(draft.customer,saleContext()))
        val code=checkNotNull(view.customerCode)
        repository.checkCredit(JSONObject().put("outletId",draft.customer.outletId).put("customerCode",code).put("amountCentavos",quote.totalMinor))
        check(valid()&&sale?.saleId==draft.saleId){"The sale changed while credit was checked"}
        message="Credit refreshed. Complete sale still checks the current snapshot; SAP confirms the saved invoice on sync."
    }
    var discountMessage by mutableStateOf<String?>(null)
        private set
    private var discountEpoch=0L
    fun setSaleDiscounts(input:ManualDiscountInput?){
        sale=sale?.let{d->d.copy(manualDiscount=input?.copy(reason=input.reason.trim(),requestId=UUID.randomUUID().toString(),approval=null),priceOverride=d.priceOverride?.let{it.copy(authorization=it.authorization.copy(requestId=UUID.randomUUID().toString(),approval=null))},creditOverride=d.creditOverride?.copy(requestId=UUID.randomUUID().toString(),approval=null))}
        discountMessage=null
        discountEpoch++
    }
    private fun discountFingerprint():String?=sale?.let{draft->cartQuote()?.let{com.sunpride.integrity.OfflineApproval.factsHash(ManualDiscounts.facts(draft.saleId,draft.customer.outletId,it.lines))}}
    fun requestDiscountApproval()=command{
        val epoch=++discountEpoch
        val draft=checkNotNull(sale);val quote=checkNotNull(cartQuote());val fingerprint=discountFingerprint()
        val input=draft.manualDiscount?:ManualDiscountInput(reason="Applied governed promotion",requestId=draft.saleId)
        val fiscal=JSONObject(checkNotNull(policy?.fiscalJson));val authority=fiscal.getJSONObject("authority")
        val valid=repository.fiscalLifetime()
        val response=repository.fiscalRequest("overrides/request",JSONObject().put("id",input.requestId).put("expectedRequesterId",authority.getString("profileId")).put("orgUnitId",authority.getString("orgUnitId"))
            .put("kind","discount").put("channel",fiscal.getJSONObject("customerChannels").getString(draft.customer.outletId))
            .put("amountCentavos",ManualDiscounts.amount(quote.lines).toString()).put("reason",ManualDiscounts.reason(input))
            .put("facts",ManualDiscounts.facts(draft.saleId,draft.customer.outletId,quote.lines)))
        check(epoch==discountEpoch&&valid()&&sale?.saleId==draft.saleId&&discountFingerprint()==fingerprint&&(sale?.manualDiscount?.requestId?:draft.saleId)==input.requestId){"The cart changed; request approval again"}
        sale=checkNotNull(sale).copy(manualDiscount=input)
        discountMessage=if(response.getBoolean("requiresSecond"))"Request saved. The office must approve this exact cart; use Check approval." else "Reason recorded within your authority. The transaction is checked again on sync."
    }
    fun checkDiscountApproval()=command{
        val epoch=++discountEpoch
        val draft=checkNotNull(sale);val id=draft.manualDiscount?.requestId?:draft.saleId
        val fingerprint=discountFingerprint();val valid=repository.fiscalLifetime()
        val response=try{repository.fiscalRequest("overrides/status",JSONObject().put("id",id))}catch(error:Exception){
            if(epoch==discountEpoch&&sale?.saleId==draft.saleId&&discountFingerprint()==fingerprint&&error is NativeApiFailure&&error.status in 400..499){
                discountEpoch++;sale=sale?.copy(manualDiscount=(sale?.manualDiscount?:ManualDiscountInput(reason="Applied governed promotion",requestId=id)).copy(approval=null,denied=true))
            }
            throw error
        }
        check(epoch==discountEpoch&&valid()&&sale?.saleId==draft.saleId&&discountFingerprint()==fingerprint&&(sale?.manualDiscount?.requestId?:draft.saleId)==id){"The cart changed; request approval again"}
        if(!response.isNull("grant"))acceptDiscountApproval(response.getString("grant"),renewed=true)
        else {
            val status=response.getString("status")
            sale=sale?.copy(manualDiscount=(sale?.manualDiscount?:ManualDiscountInput(reason="Applied governed promotion",requestId=id)).copy(approval=null,denied=status!="within_own_limit"))
            discountMessage=when(status){"rejected"->"The office refused this discount. Change the cart or ask for a new decision.";"consumed"->"This approval was already used. Check the saved invoice before trying again.";"within_own_limit"->"Within your authority; sync checks the current rule again.";else->"Still waiting for a second person in the office."}
        }
    }
    fun pasteDiscountApproval(token:String)=acceptDiscountApproval(token,false)
    private fun acceptDiscountApproval(token:String,renewed:Boolean){
        val draft=sale?:return;val quote=cartQuote()?:return
        discountEpoch++
        if(token.isBlank()||ManualDiscounts.amount(quote.lines)==0L){discountMessage="Paste an approval for a discounted cart first.";return}
        val old=draft.manualDiscount?:ManualDiscountInput(reason="Applied governed promotion",requestId=draft.saleId)
        val input=old.copy(approval=token.trim(),denied=old.denied&&!renewed)
        val problem=ManualDiscounts.authorize(CheckoutRequest(draft.saleId,draft.customer.outletId,draft.lines,PaymentInput("cash"),input,draft.priceOverride,draft.creditOverride),quote.lines,saleContext())
        if(problem!=null){discountMessage=VanRules.checkoutMessage(problem,null);return}
        sale=draft.copy(manualDiscount=input);discountMessage="Approval matches this cart. Changes, expiry or withdrawn authority can still refuse sync."
    }
    /** Payment methods the office allows (cash only until the policy says otherwise). */
    val paymentMethods: List<PaymentMethod> get() = policy?.paymentMethods ?: PaymentMethod.CASH_ONLY
    /** The store validates again in the saving transaction; a refusal keeps the cart so the seller can fix it. */
    fun completeSale(payment: PaymentInput, expectedTotalMinor: Long) = command {
        val draft = checkNotNull(sale)
        try {
            val receipt = repository.completeSale(CheckoutRequest(draft.saleId,draft.customer.outletId,draft.lines,payment,draft.manualDiscount,draft.priceOverride,draft.creditOverride),expectedTotalMinor)
            lastReceipt = receipt; sale = null; page = Page.SALE_DONE; printMessage = null
            // VAN-017: the sale is saved first; the receipt prints after, and a printer problem never touches the sale.
            if (receipt.fiscalJson == null) startPrint(receipt.saleId,explicit = false,reason = null)
            else printMessage = "Invoice saved. Preview it before printing; confirm printer paper first."
        } catch (e: CheckoutRefused) {
            message = e.issues.joinToString("\n") { issue -> VanRules.checkoutMessage(issue.problem,issue.productId?.let { id -> products.firstOrNull { it.productId == id }?.name }) }
        }
    }
    fun recordCollection(paymentId: String,saleId: String,amount: Long,method: String,reference: String?,onSaved: () -> Unit) = command {
        repository.recordCollection(paymentId,saleId,amount,method,reference)
        savedSales=repository.savedSales();refreshPaymentFacts();onSaved()
        message="Collection and Official Receipt saved on this phone. Preview before printing; sync for office confirmation."
    }
    /** [onVoided] runs only after the void is saved, so a refused code keeps the dialog (and what was typed) open. */
    fun voidSale(saleId: String, reason: String?, note: String?, code: String?, onVoided: () -> Unit = {}) = command {
        try {
            repository.voidSale(saleId,reason,note,code)
            onVoided()
            message = "Sale voided. The stock is back on the truck."
            savedSales = repository.savedSales()
            refreshPaymentFacts()
            startPrint(saleId,explicit = false,reason = null)
        } catch (e: VoidRefused) { message = VanRules.voidMessage(e.problem) }
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
        if (tripClosed) { message = TRIP_CLOSED_MESSAGE; return }
        if (!VanRules.canSell(trip)) { message = VanRules.returnMessage(ReturnProblem.TRIP_NOT_OPEN,null); return }
        if (stockCounted) { message = VanRules.returnMessage(ReturnProblem.STOCK_COUNTED,null); return }
        if (returnDraft?.customer?.outletId != customer.outletId) returnDraft = ReturnDraft(ReturnRules.newReturnId(),customer,null,emptyList())
        selectedCustomer = customer; open(Page.RETURN)
        scope?.launch { returnFacts = runCatching { repository.returnContext() }.getOrNull() }
    }
    fun addReturnLine(line: ReturnLineInput) { returnDraft = returnDraft?.let { it.copy(lines = it.lines + line) } }
    fun removeReturnLine(index: Int) { returnDraft = returnDraft?.let { d -> d.copy(lines = d.lines.filterIndexed { i,_ -> i != index }) } }
    fun linkReturnSale(saleId: String?) { returnDraft = returnDraft?.copy(originalSaleId = saleId) }
    fun cancelReturn() { returnDraft = null; open(Page.CUSTOMER) }
    fun returnContext(): ReturnContext = ReturnContext(VanRules.canSell(trip) && session.signedIn,customers,products,
        returnFacts?.sales ?: emptyList(),returnFacts?.returnedBase ?: emptyMap(),policy=returnFacts?.policy?:ReturnPolicy.DEFAULT)
    fun returnResult(note: String): ReturnResult? = returnDraft?.let { ReturnRules.evaluate(ReturnRequest(it.returnId,it.customer.outletId,it.originalSaleId,it.lines,note),returnContext()) }
    /** The store validates again in the saving transaction; a refusal keeps the draft so the seller can fix it. */
    fun saveReturn(note: String,acknowledgementJson: String? = null,photoJson: String? = null) = command {
        val draft = checkNotNull(returnDraft)
        try {
            lastReturn = repository.recordReturn(ReturnRequest(draft.returnId,draft.customer.outletId,draft.originalSaleId,draft.lines,note.takeIf { it.isNotBlank() },acknowledgementJson,photoJson))
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
                if (!explicit && printer.diagnostics().paper == PaperState.NOT_REPORTED) {
                    printMessage = "Not printed. Check the paper, then tap Print receipt."
                    return@launch
                }
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
    fun refreshCash() {
        scope?.launch {
            cashSummary = try { repository.cashSummary() } catch (e: CancellationException) { throw e }
                catch (e: CashRefused) { message = VanRules.cashMessage(e.problem); null } catch (_: Exception) { null }
        }
    }
    fun refreshStock() {
        scope?.launch {
            batchCountPositions=repository.batchPositions().filter {it.status in setOf("available","damaged")}
            stockSummary = try { repository.stockSummary() } catch (e: CancellationException) { throw e }
                catch (e: StockRefused) { message = VanRules.stockMessage(e.problem); null } catch (_: Exception) { null }
        }
    }
    fun editCash(draft: CashDraft) { cashDraft = draft }
    /** The store recomputes the expected cash and checks the code in the saving transaction; a refusal keeps the draft. */
    fun saveCashCount(expectedMinor: Long) = command {
        val draft = cashDraft
        val counts = draft.pieces.mapValues { (_, text) -> CashReconciliationRules.parsePieces(text) ?: -1L }
        try {
            val result = repository.countCash(CashCountRequest(draft.reconciliationId,counts,draft.reasonCode,draft.note.takeIf { it.isNotBlank() },
                draft.code.takeIf { it.isNotBlank() },expectedMinor))
            cashSummary = repository.cashSummary()
            message = if (result.varianceMinor == 0L) "Cash count saved. It matches." else "Cash count saved: ${VanRules.varianceLabel(result.varianceMinor,result.currency)}."
        } catch (e: CashRefused) {
            message = VanRules.cashMessage(e.problem)
            if (e.problem == CashProblem.EXPECTED_CHANGED || e.problem == CashProblem.ALREADY_COUNTED) cashSummary = repository.cashSummary()
        }
    }
    fun editStock(draft: StockDraft) { stockDraft = draft }
    /** The store rechecks the expected projection and every rule in its transaction. */
    fun saveStockCount() = command {
        val summary = checkNotNull(stockSummary)
        val lines = summary.lines.map { line ->
            val text = stockDraft.counts[line.productId to line.status] ?: ""
            StockCountLine(line.productId,line.status,line.expectedBase,VanRules.parseQuantity(text,line.quantityScale) ?: -1L,
                stockDraft.reasons[line.productId to line.status])
        }
        try {
            val result = repository.countStock(StockCountRequest(stockDraft.reconciliationId,lines,
                stockDraft.note.takeIf { it.isNotBlank() },stockDraft.code.takeIf { it.isNotBlank() },batchCountPositions.map {b->val p=products.single {it.productId==b.productId};BatchCountLine(b,VanRules.parseQuantity(stockDraft.batchCounts["${b.lotId}:${b.status}"]?:"",p.quantityScale)?:-1L)}))
            stockSummary = repository.stockSummary()
            message = if (result.varianceLines == 0) "Stock count saved. It matches." else "Stock count saved. Truck stock now matches your count."
        } catch (e: StockRefused) {
            message = VanRules.stockMessage(e.problem)
            if (e.problem == StockProblem.EXPECTED_CHANGED || e.problem == StockProblem.ALREADY_COUNTED) stockSummary = repository.stockSummary()
        }
    }
    fun refreshClose() {
        scope?.launch {
            closeSummary = try { repository.closeSummary() } catch (e: CancellationException) { throw e }
                catch (e: TripCloseRefused) { message = VanRules.closeMessage(e.problem); null } catch (_: Exception) { null }
        }
    }
    fun editClose(draft: CloseDraft) { closeDraft = draft }
    /** Sync from Close trip, then read the checklist again (waiting work may have gone out). */
    fun syncForClose() = command("Sync finished. Check the list again.") {
        try { repository.syncNow() } finally { closeSummary = runCatching { repository.closeSummary() }.getOrDefault(closeSummary) }
    }
    /** The store repeats the whole checklist and compares the confirmed exceptions in its transaction; a refusal keeps the form. */
    fun closeTrip() = command {
        val summary = checkNotNull(closeSummary)
        val draft = closeDraft
        val km = draft.odometer.takeIf { it.isNotBlank() }?.let { it.trim().toDoubleOrNull() ?: Double.NaN }
        try {
            repository.closeTrip(TripCloseRequest(draft.closeId,summary.checklist.reviewCode.takeIf { draft.reviewed },km,draft.note.takeIf { it.isNotBlank() }))
            closeSummary = repository.closeSummary()
            message = "Trip closed on this phone. Hand the cash and truck to the office."
        } catch (e: TripCloseRefused) {
            message = VanRules.closeMessage(e.problem)
            if (e.problem == CloseProblem.EXCEPTIONS_CHANGED) closeDraft = draft.copy(reviewed = false)
            closeSummary = runCatching { repository.closeSummary() }.getOrDefault(summary)
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
/** VAN-022 Count cash form: pieces typed per denomination (centavos → text), reason, note and supervisor code. */
data class CashDraft(val reconciliationId: String, val pieces: Map<Long,String> = emptyMap(), val reasonCode: String? = null,
    val note: String = "", val code: String = "")
/** VAN-023 Count stock form: decimal quantities are kept as text until parsed against each product scale. */
data class StockDraft(val reconciliationId: String, val counts: Map<Pair<String,String>,String> = emptyMap(),
    val reasons: Map<Pair<String,String>,String?> = emptyMap(), val note: String = "", val code: String = "",val batchCounts: Map<String,String> = emptyMap())
/** VAN-024 Close trip form: the seller ticked "I have checked these", end odometer text and note. */
data class CloseDraft(val closeId: String, val reviewed: Boolean = false, val odometer: String = "", val note: String = "")
const val LOCATION_OFF_MESSAGE = "Location sharing is off. Allow location for Sunpride Van (and turn location on), then check Today."
const val TRIP_CLOSED_MESSAGE = "This trip is closed on this phone. Nothing more can be recorded on it."
/** A sale being built for one customer (VAN-011). */
data class SaleDraft(val saleId: String, val customer: Customer, val lines: List<CartLine>,val manualDiscount:ManualDiscountInput? = null,val priceOverride:SalePriceOverride?=null,val creditOverride:FinancialOverride?=null)
