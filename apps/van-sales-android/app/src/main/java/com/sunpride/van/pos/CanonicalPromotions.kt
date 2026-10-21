package com.sunpride.van.pos

import com.sunpride.schemes.NativeSchemeQuote
import com.sunpride.schemes.SchemeLine
import com.sunpride.van.data.Customer
import com.sunpride.van.data.PriceLine
import com.sunpride.van.data.Product
import org.json.JSONObject
import java.math.BigInteger

/** F-502/F-503/F-511. The encrypted bootstrap supplies the outlet-specific authorized
 * context; the shared JS authority supplies all mechanics, precedence and allocations. */
internal object CanonicalPromotions {
    fun apply(cart: List<CartLine>,customer: Customer,products: Map<String,Product>,prices: List<PriceLine>,snapshot: JSONObject,now: Long): PromotionResult = try {
        require(snapshot.getInt("engineVersion") == 1)
        val contexts = snapshot.getJSONArray("outlets")
        val context = (0 until contexts.length()).map(contexts::getJSONObject).single { it.getString("outletId") == customer.outletId }
        val rows = cart.mapIndexed { index,input ->
            val product = checkNotNull(products[input.productId])
            require(input.quantityBase in 1..CheckoutRules.MAX_BASE)
            PromotionLine(index+1,product,input.quantityBase,0,PriceResolver.resolve(product,prices,now,customer),0,null)
        }.toMutableList()
        val wire = rows.map { line ->
            val milli = BigInteger.valueOf(line.paidBase).multiply(BigInteger.valueOf(1000))
            val divisor = BigInteger.valueOf(line.product.quantityScale)
            require(milli.mod(divisor) == BigInteger.ZERO)
            SchemeLine(line.product.productId,line.product.uomCode,milli.divide(divisor).toString().toLong(),line.price?.unitPriceMinor)
        }
        val quote = NativeSchemeQuote.evaluate(context,customer.outletId,wire,now,true)
        val result = quote.result
        val discounts = result.getJSONArray("lineDiscounts")
        rows.forEachIndexed { index,line -> line.discountMinor = discounts.getLong(index) }
        val promotions = result.getJSONArray("promotionsApplied")
        var earned = 0L
        fun tag(line: PromotionLine,p: JSONObject) {
            val previous = line.promotion
            line.promotion = QuotedPromotion(previous?.promotionId ?: p.getString("id"),
                listOfNotNull(previous?.code,p.getString("code")).joinToString(" + ").take(100),
                listOfNotNull(previous?.name,p.getString("name")).joinToString(" + ").take(160),p.getString("kind"))
        }
        for(index in 0 until promotions.length()) {
            val p = promotions.getJSONObject(index)
            earned = Math.addExact(earned,p.getLong("earnedCentavos"))
            val indexes = p.getJSONArray("lineIndexes")
            for(i in 0 until indexes.length()) tag(rows[indexes.getInt(i)],p)
            val gifts = p.getJSONArray("freeGoods")
            for(i in 0 until gifts.length()) {
                val gift = gifts.getJSONObject(i)
                val product = checkNotNull(products[gift.getString("productId")])
                require(product.uomCode == gift.getString("uom"))
                val line = rows.firstOrNull { it.product.productId == product.productId } ?: PromotionLine(rows.size+1,product,0,0,
                    PriceResolver.resolve(product,prices,now,customer),0,null).also(rows::add)
                line.freeBase = Math.addExact(line.freeBase,Math.multiplyExact(gift.getLong("quantity"),product.quantityScale))
                if (line.promotion?.promotionId != p.getString("id")) tag(line,p)
            }
        }
        PromotionResult(rows,emptyList(),earned)
    } catch (_: Exception) {
        PromotionResult(emptyList(),listOf(CheckoutIssue(CheckoutProblem.PROMOTION_NEEDS_OFFICE)))
    }
}
