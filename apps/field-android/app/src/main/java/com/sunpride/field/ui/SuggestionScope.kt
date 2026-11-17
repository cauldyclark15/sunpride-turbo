package com.sunpride.field.ui

import com.sunpride.field.storage.StoreScope

/**
 * SP-0196: the verified scope the process-wide authorization lifetime (SuggestedOrderRepository.epoch) belongs to.
 *
 * The lifetime is one per process, so the scope it follows is too. Each background sync builds its own
 * LiveFieldBackend; when every backend kept its own "last scope" (starting empty), each sync retired the lifetime on
 * its first look at the unchanged scope. The app keys its pages on that lifetime, so the open Add customer form was
 * thrown away and rebuilt after every background sync.
 */
internal object SuggestionScope {
    private var last: StoreScope? = null

    /** True when [scope] differs from the last one seen in this process (A → B, or back to A): retire the lifetime. */
    @Synchronized fun changed(scope: StoreScope?): Boolean {
        if (scope == last) return false
        last = scope
        return true
    }

    /** Tests only: a fresh process. */
    @Synchronized internal fun forget() { last = null }
}
