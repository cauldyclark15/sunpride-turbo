package com.sunpride.integrity

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

/** Service-owned, single-flight polling. No Activity, Compose scope, account or credential is retained here. */
object PhoneSupportLoop {
    suspend fun run(needed: () -> Boolean, online: () -> Boolean, check: suspend () -> Unit,
        checked: () -> Unit = {}, clock: () -> Long = { System.nanoTime() / 1_000_000 },
        wait: suspend (Long) -> Unit) {
        while (true) {
            currentCoroutineContext().ensureActive()
            if (!needed()) return
            val started = clock()
            try {
                if (online()) {
                    check()
                    currentCoroutineContext().ensureActive()
                    checked()
                }
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { /* A failed request stays pending; try again on the next tick/reconnect. */ }
            currentCoroutineContext().ensureActive()
            if (!needed()) return
            // Count request time toward the minute, not a minute plus a slow request. Never busy-spin.
            wait((PhoneCommands.POLL_MS - (clock() - started).coerceAtLeast(0)).coerceAtLeast(1_000))
        }
    }
}
