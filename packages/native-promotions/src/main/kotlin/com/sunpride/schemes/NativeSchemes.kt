package com.sunpride.schemes

import org.json.JSONObject
import org.mozilla.javascript.Context
import org.mozilla.javascript.ContextFactory
import org.mozilla.javascript.Function
import org.mozilla.javascript.ScriptableObject
import java.security.MessageDigest

/** F-502/F-503: execute the bundled canonical JS authority. No Kotlin business-rule translation,
 * network, Java host access, or persistent customer data. The VM is lazy and shared across quotes. */
object NativeSchemes {
    const val VERSION = 1
    private var scope: ScriptableObject? = null
    private var deadline = Long.MAX_VALUE
    private val factory = object : ContextFactory() {
        @Suppress("DEPRECATION")
        override fun makeContext(): Context = super.makeContext().apply {
            optimizationLevel = -1 // Android supports interpreted mode only.
            languageVersion = Context.VERSION_ES6
            instructionObserverThreshold = 10_000
            setClassShutter { false }
        }
        override fun observeInstructionCount(cx: Context, count: Int) {
            check(System.nanoTime() <= deadline) { "Promotion evaluation exceeded its local budget" }
        }
    }
    @Synchronized
    fun quote(request: JSONObject): JSONObject {
        val input = request.toString()
        require(input.length <= 1_000_000) { "Promotion snapshot is too large" }
        deadline = System.nanoTime() + 2_000_000_000L
        return try {
            factory.call<JSONObject> { cx ->
                val current = scope ?: cx.initSafeStandardObjects().also { created ->
                    val loader = NativeSchemes::class.java
                    val script = checkNotNull(loader.getResourceAsStream("/sunpride-schemes.js")).bufferedReader(Charsets.UTF_8).use { it.readText() }
                    val manifest = JSONObject(checkNotNull(loader.getResourceAsStream("/sunpride-schemes.json")).bufferedReader(Charsets.UTF_8).use { it.readText() })
                    val digest = MessageDigest.getInstance("SHA-256").digest(script.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it.toInt() and 255) }
                    check(manifest.getInt("engineVersion") == VERSION && manifest.getInt("bridgeVersion") == 1 && manifest.getString("sha256") == digest)
                    cx.evaluateString(created, script, "sunpride-schemes", 1, null)
                    scope = created
                }
                val fn = ScriptableObject.getProperty(current, "sunprideSchemeQuote") as Function
                val envelope = JSONObject(Context.toString(fn.call(cx, current, current, arrayOf(input))))
                check(envelope.optBoolean("ok", false)) { "Promotion setup needs office review" }
                envelope.getJSONObject("result").also { check(it.getInt("engineVersion") == VERSION) }
            }
        } catch (error: Exception) {
            scope = null
            throw IllegalStateException("Promotion setup needs office review", error)
        }
    }
}
