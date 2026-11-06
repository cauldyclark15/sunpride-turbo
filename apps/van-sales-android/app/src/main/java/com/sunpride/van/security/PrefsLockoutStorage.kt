package com.sunpride.van.security

import android.content.Context

/** IP-HH2: wrong-PIN times kept in the app's private preferences, so closing the app does not reset a lockout. Times only, never a PIN. */
class PrefsLockoutStorage(context: Context) : LockoutStorage {
    private val prefs = context.applicationContext.getSharedPreferences("pin_lockout", Context.MODE_PRIVATE)
    override fun load(key: String): List<Long> = prefs.getString(key, "")!!.split(',').mapNotNull { it.toLongOrNull() }
    override fun save(key: String, failures: List<Long>) { prefs.edit().putString(key, failures.joinToString(",")).apply() }
}

/** Used when no preferences are attached (tests, previews). */
class MemoryLockoutStorage : LockoutStorage {
    private val map = mutableMapOf<String, List<Long>>()
    override fun load(key: String): List<Long> = map[key].orEmpty()
    override fun save(key: String, failures: List<Long>) { map[key] = failures }
}
