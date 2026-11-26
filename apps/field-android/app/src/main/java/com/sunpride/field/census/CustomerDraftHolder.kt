package com.sunpride.field.census

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * SP-0196: the open Add customer form, kept above the screen (one per signed-in session).
 *
 * The screen can be thrown away and rebuilt while the agent is working (opening the form again after Back, the app
 * re-keying its pages, a dialog or the camera). Its own `remember` state does not survive that, and the copy kept on the
 * phone is written in the background, so rebuilding from it could bring back an older copy: fields typed just before
 * (or the photo) disappeared. The screen now writes every change here at once and starts from here; the phone copy is
 * only needed after the app was closed.
 *
 * Phone writes are numbered when their snapshot is taken: a write that finishes after a newer one (or after the clear
 * done by Save or Discard) is skipped, so an older copy can never replace a newer one, whatever order they finish in.
 */
class CustomerDraftHolder {
    private val lock = Any()
    private var nextTicket = 0L
    private var written = 0L
    @Volatile var session = 0L
        private set

    /** The working form and explicitly saved drafts; persisted together in the existing encrypted phone row. */
    var customers by mutableStateOf(CustomerDrafts())
        private set
    /** Number of saved drafts, observable by Home and Customers without polling/network. */
    var savedCount by mutableStateOf(0)
        private set
    var openList: Boolean = false
    val draft: CustomerCapture.Draft? get() = customers.active
    fun restore(json: String?) { replace(CustomerDrafts.parse(json)) }
    fun replace(next: CustomerDrafts) { customers = next; savedCount = next.saved.size; loaded = true }
    /** True once this session's form state is known here (kept, saved or discarded): the phone copy is not re-read. */
    @Volatile var loaded: Boolean = false
        private set
    /** The "Customer saved" message while it is showing, so a rebuilt screen still shows it until OK. */
    var savedNotice: String? by mutableStateOf(null)

    fun keep(d: CustomerCapture.Draft) { customers = customers.keep(d); loaded = true }

    /** Submitted or discarded: remove only the open draft, keeping the rest of the draft list. */
    fun clear() { replace(customers.clear()) }

    /** A number for a phone write, taken when its snapshot is taken. */
    fun ticket(): Long = synchronized(lock) { ++nextTicket }

    /** Runs [write] unless a newer snapshot was written already; false when skipped. Writes never overlap. */
    fun persist(ticket: Long, write: () -> Unit): Boolean = synchronized(lock) {
        if (ticket <= written) return false
        write()
        written = ticket
        true
    }

    /** Sign-out: nothing of this session carries over. */
    fun reset() = synchronized(lock) {
        written = ++nextTicket; session++
        customers = CustomerDrafts(); savedCount = 0; openList = false; loaded = false; savedNotice = null
    }
}
