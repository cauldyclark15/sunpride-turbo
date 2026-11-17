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

    /** The latest form, photo and location fix; null once saved or discarded (or before anything was kept). */
    @Volatile var draft: CustomerCapture.Draft? = null
        private set
    /** True once this session's form state is known here (kept, saved or discarded): the phone copy is not re-read. */
    @Volatile var loaded: Boolean = false
        private set
    /** The "Customer saved" message while it is showing, so a rebuilt screen still shows it until OK. */
    var savedNotice: String? by mutableStateOf(null)

    fun keep(d: CustomerCapture.Draft) { draft = d; loaded = true }

    /** Saved or discarded: the next Add customer starts empty. */
    fun clear() { draft = null; loaded = true }

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
    fun reset() { draft = null; loaded = false; savedNotice = null }
}
