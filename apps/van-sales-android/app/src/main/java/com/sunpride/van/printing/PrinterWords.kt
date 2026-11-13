package com.sunpride.van.printing

/** VAN-017: printer state in plain words for the seller (no codes, no exception text). */
object PrinterWords {
    /** VAN-002: the built-in printer's own alert came up on the last job. */
    const val LAST_JOB_PAPER_ALERT = "Last print failed: the printer said paper is not ready. Load paper, then print again."
    /** VAN-002: a job the printer accepted, with no alert from the printer afterwards. */
    const val TEST_SENT = "Test receipt sent. Check the paper output."
    fun testResult(outcome: PrintResult): String = when (outcome) {
        PrintResult.Success -> TEST_SENT
        is PrintResult.Unsupported -> outcome.feature
        is PrintResult.Error -> "Print failed: ${status(outcome.status).replaceFirstChar { it.uppercase() }}" +
            (if (outcome.status == PrinterStatus.PaperOut) ". Load paper, then print again." else "") +
            if (outcome.mayHavePrinted) " (may have partly printed; check paper)" else ""
    }
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
