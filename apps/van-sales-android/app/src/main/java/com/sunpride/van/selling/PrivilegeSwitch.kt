package com.sunpride.van.selling

import com.sunpride.van.data.VanPolicy

/**
 * SP-0169: the office switches Senior / PWD (and the other statutory) discounts on or off per van route and per till
 * (`policy.privilegeDiscount`, opt-in `params.privilegeSwitch`). The phone must never offer, compute or print a discount
 * the office will refuse: a refused receipt costs the customer a spoiled invoice.
 *
 * Null (a server from before this switch) keeps the old behaviour: the button is offered and the office decides.
 */
object PrivilegeSwitch {
    const val OFF_MESSAGE = "Senior, PWD and other discounts are switched off by the office for this route. Sell at the normal price, or ask the office to turn them on and sync."
    fun offered(policy: VanPolicy?): Boolean = policy?.privilegeDiscount != false
    /** Wire block `{surface, enabled}`; anything malformed is treated as "not said" (null), never as on. */
    fun decode(o: org.json.JSONObject?): Boolean? = o?.takeIf { it.opt("enabled") is Boolean && it.optString("surface") in setOf("van","store") }?.getBoolean("enabled")
}

/**
 * SP-0169: a numbered document the office refused for good is recorded as SPOILED on the server (so the next number is valid
 * again). The outbox keeps [CODE] as its rejection code so the seller sees what happened to that receipt number.
 */
object RefusedReceipt {
    const val CODE = "receipt_spoiled"
    private val NUMBER = Regex("^[A-Za-z0-9][A-Za-z0-9-]{0,39}$")
    /** The spoiled number from a push result, or null. */
    fun spoiledNumber(result: org.json.JSONObject): String? =
        result.optJSONObject("spoiled")?.optString("documentNumber")?.takeIf { NUMBER.matches(it) }
    fun message(reference: String?, kind: String? = null): String = if (kind == "store.refund.part")
        "The office refused credit memo ${reference ?: ""}. Its number is recorded as spoiled, so the next refund can go ahead. Take the refund cash back from the customer if you can; tell your supervisor."
    // r6van4: say what happened to the goods and the cash too: the phone already put the goods back in truck stock and
    // left the cash out of the expected cash, exactly as the office has them.
    else "The office refused ${reference ?: "this receipt"}. Its number is recorded as spoiled, so the next sale can go ahead. " +
        "Its goods are back in your truck stock and its cash is left out of your expected cash. Collect the receipt from the customer; " +
        "give back their money and take back the goods, or ring the sale again on a new receipt. Tell your supervisor."
}
