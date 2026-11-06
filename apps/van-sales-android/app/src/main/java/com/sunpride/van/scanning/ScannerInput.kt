package com.sunpride.van.scanning

import android.content.Context
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.view.KeyEvent
import androidx.compose.runtime.compositionLocalOf
import kotlinx.coroutines.flow.Flow

/** What the handheld does after a scan, so the seller never has to look at the screen to know. */
interface ScanFeedback {
    fun added()
    fun rejected()
    companion object { val None = object : ScanFeedback { override fun added() {}; override fun rejected() {} } }
}

class AndroidScanFeedback(context: Context) : ScanFeedback {
    private val vibrator = runCatching { context.applicationContext.getSystemService(Vibrator::class.java) }.getOrNull()
    private val tone = runCatching { ToneGenerator(AudioManager.STREAM_NOTIFICATION, 80) }.getOrNull()
    override fun added() { beep(ToneGenerator.TONE_PROP_BEEP, 60); buzz(30) }
    override fun rejected() { beep(ToneGenerator.TONE_PROP_NACK, 220); buzz(160) }
    private fun beep(kind: Int, ms: Int) { runCatching { tone?.startTone(kind, ms) } }
    private fun buzz(ms: Long) { runCatching { vibrator?.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE)) } }
}

/**
 * IP-HH1 (R4 section 4): the one scanner for the whole app. It listens to the Senraise broadcast `android.scanner.scan`
 * (String extra `result`) and the other vendor intents, and to keyboard-wedge bursts taken from [onKeyEvent] before any
 * text field sees them. Every source goes through one [BarcodeInputs] gate, so the 300 ms duplicate filter also stops
 * the broadcast plus its typed copy from adding twice. Screens only collect [scans]; none of them builds a scanner.
 *
 * Broadcast content is untrusted lookup input, never authorization.
 */
class ScannerInput(context: Context, val inputs: BarcodeInputs = BarcodeInputs(),
    private val feedback: ScanFeedback = AndroidScanFeedback(context),
    private val router: WedgeRouter = WedgeRouter(inputs)) : BarcodeSource, AutoCloseable {
    private val receiver = SenraiseScanner(context, inputs)
    private val handler = Handler(Looper.getMainLooper())
    private val consumed = HashSet<Int>()
    private val idle = Runnable { router.onIdle(SystemClock.uptimeMillis()) }
    @Volatile private var started = false
    override val scans: Flow<ScanEvent> = inputs.scans

    /** True only on the selling grid, where no text field is meant to receive keys. Everywhere else the keyboard path types normally. */
    @Volatile var wedgeCapture: Boolean = false

    @Synchronized fun start() { receiver.start(); started = true }
    @Synchronized fun stop() { started = false; receiver.stop(); router.reset(); consumed.clear(); handler.removeCallbacks(idle) }
    override fun close() = stop()

    /** Call from Activity.dispatchKeyEvent. True = the key was part of a scan and must not reach any field. */
    fun onKeyEvent(event: KeyEvent): Boolean {
        if (!started || !wedgeCapture) return false
        if (event.action == KeyEvent.ACTION_UP) return consumed.remove(event.keyCode)
        if (event.action != KeyEvent.ACTION_DOWN) return false
        if (event.repeatCount != 0) return event.keyCode in consumed
        if (event.isCtrlPressed || event.isAltPressed || event.isMetaPressed) return false
        val character = when (event.keyCode) {
            KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> '\n'
            else -> event.unicodeChar.takeIf { it in 33..Char.MAX_VALUE.code }?.toChar()
        } ?: return false
        if (!router.onCharacter(character, event.eventTime)) return false
        consumed += event.keyCode
        handler.removeCallbacks(idle)
        if (router.hasPending) handler.postDelayed(idle, router.gapMillis + 15)
        return true
    }

    fun scanAdded() = feedback.added()
    fun scanRejected() = feedback.rejected()
    /** Camera fallback result goes through the same gate as the hardware scanner. */
    fun cameraCode(code: String) = inputs.cameraCode(code)
}

/** The app's one [ScannerInput]; null in previews and unit tests. */
val LocalScannerInput = compositionLocalOf<ScannerInput?> { null }
