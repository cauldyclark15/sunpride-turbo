package com.sunpride.van.storepos

/** IP-P0: the sales-only X reading shown before the blind count. It never includes expected cash. */
data class StoreXPreview(val receipts: Int, val salesMinor: Long) {
    companion object {
        fun of(receiptTotalsMinor: List<Long>) = StoreXPreview(receiptTotalsMinor.size, receiptTotalsMinor.fold(0L) {a,b -> Math.addExact(a,b)})
    }
}
