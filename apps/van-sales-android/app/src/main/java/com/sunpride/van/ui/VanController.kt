package com.sunpride.van.ui

import androidx.compose.runtime.*
import com.sunpride.van.AppEnvironment
import com.sunpride.van.VanFeatures
import com.sunpride.van.auth.*
import com.sunpride.van.data.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*

/** One UI lifetime; no Activity, password persistence, identity selection, or raw error text. */
class VanController(val repository: VanRepository, val environment: AppEnvironment,
    val fixtureMode: Boolean = false,
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
    fun open(next: Page) { page = next; message = null }
    fun back() { open(if (page == Page.WALK_IN || page == Page.CUSTOMER) Page.CUSTOMERS else Page.HOME) }
    fun select(customer: Customer) { selectedCustomer = customer; open(Page.CUSTOMER) }
    fun signIn(email: String, password: String) = command {
        repository.signIn(email.trim(),password)
        if (repository.enrollmentState.value is EnrollmentState.Ready) repository.syncNow()
    }
    fun signOut() = command { repository.signOut(); page = Page.HOME }
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
    fun walkIn(name: String, reason: String) = command {
        repository.addWalkInCustomer(name.trim(),reason.trim()); page = Page.CUSTOMERS
    }
}
