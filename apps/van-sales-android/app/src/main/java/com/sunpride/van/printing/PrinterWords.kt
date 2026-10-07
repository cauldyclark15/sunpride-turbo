package com.sunpride.van.printing

/** VAN-017: printer state in plain words for the seller (no codes, no exception text). */
object PrinterWords {
    fun status(status: PrinterStatus): String = when (status) {
        is PrinterStatus.Ready -> "Connected"
        PrinterStatus.Unavailable -> "no printer on this phone"
        PrinterStatus.ServiceMissing -> "the built-in printer service is missing"
        PrinterStatus.Disconnected -> "disconnected"
        PrinterStatus.Timeout -> "the printer did not answer"
        PrinterStatus.PaperOut -> "out of paper"
        is PrinterStatus.Failed -> "printer error"
        is PrinterStatus.NeedsSetup -> setup(status.reason)
    }
    fun setup(problem: PrinterSetupProblem): String = when (problem) {
        PrinterSetupProblem.NO_BLUETOOTH -> "this phone has no Bluetooth"
        PrinterSetupProblem.BLUETOOTH_OFF -> "Bluetooth is off. Turn it on"
        PrinterSetupProblem.PERMISSION_DENIED -> "allow Nearby devices for this app"
        PrinterSetupProblem.NOT_PAIRED -> "the printer is not paired with this phone"
    }
    fun paper(paper: PaperState): String = when (paper) {
        PaperState.OK -> "Paper loaded"
        PaperState.OUT -> "Out of paper"
        PaperState.NOT_REPORTED -> "Not reported by this printer. Look at the paper window; the printer shows its own message when paper runs out."
    }
}
