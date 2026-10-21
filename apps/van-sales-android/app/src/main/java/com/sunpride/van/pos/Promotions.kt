package com.sunpride.van.pos

import com.sunpride.van.data.Customer
import com.sunpride.van.data.CustomerPriceListMode
import com.sunpride.van.data.PriceLine
import com.sunpride.van.data.Product
import com.sunpride.van.data.Promotion
import com.sunpride.van.data.PromotionRule
import com.sunpride.van.data.PromotionUnit
import java.math.BigInteger

/** Promotion metadata frozen into a quote, operation and receipt. */
data class QuotedPromotion(val promotionId: String, val code: String, val name: String, val kind: String)

/** A priced cart row while the pure promotion engine applies a governed rule. */
internal data class PromotionLine(
    val lineNumber: Int,
    val product: Product,
    val paidBase: Long,
    var freeBase: Long,
    val price: PosPrice?,
    var discountMinor: Long,
    var promotion: QuotedPromotion?
) {
    val grossMinor: Long get() = if (paidBase == 0L) 0L else price?.let { CheckoutRules.lineTotal(it.unitPriceMinor,paidBase,product.quantityScale) } ?: 0L
}

internal data class PromotionResult(val lines: List<PromotionLine>, val issues: List<CheckoutIssue>)

/**
 * F-110: negotiated engine v1 follows the canonical TPM precedence/exclusions, residual-net stacking,
 * half-up percentages and proportional bundle allocation. Historical unversioned snapshots retain their
 * original conflict/rounding rules. Neither mode invents a price; unsupported rules block completion.
 */
internal object PromotionEngine {
    /** F-110: an unsupported governed programme must not disappear into a full-price sale. */
    fun needsOffice(request:CheckoutRequest,context:CheckoutContext):Boolean=runCatching{
        val raw=context.policy?.fiscalJson?:return@runCatching false
        val rows=org.json.JSONObject(raw).optJSONArray("schemeHolds")?:return@runCatching false
        require(rows.length()<=1000)
        (0 until rows.length()).any{i->val r=rows.getJSONObject(i);val ids=r.getJSONArray("productIds");require(ids.length()<=100)
            r.getString("outletId")==request.customerId&&(ids.length()==0||(0 until ids.length()).any{n->request.lines.any{it.productId==ids.getString(n)}})}
    }.getOrDefault(true)
    fun apply(
        cart: List<CartLine>,
        customer: Customer,
        products: Map<String, Product>,
        prices: List<PriceLine>,
        promotions: List<Promotion>,
        now: Long
    ): PromotionResult {
        val lines = cart.mapIndexed { index, input ->
            val product = products[input.productId] ?: return@mapIndexed null
            if (input.quantityBase !in 1L..CheckoutRules.MAX_BASE) return@mapIndexed null
            val price = PriceResolver.resolve(product,prices,now,customer)
            PromotionLine(index + 1,product,input.quantityBase,0L,price,0L,null)
        }.filterNotNull().toMutableList()
        val byProduct = lines.associateBy { it.product.productId }.toMutableMap()
        val effectiveListId = effectiveListId(customer,lines)
        if (customer.priceListMode == CustomerPriceListMode.NONE) return PromotionResult(lines,emptyList())
        val applicable = mutableListOf<Applicable>()
        val issues = mutableListOf<CheckoutIssue>()
        val protocol=promotions.any{it.engineVersion==1}
        promotions.asSequence()
            .filter { it.effectiveFrom <= now && (it.effectiveTo == null || now < it.effectiveTo) }
            .filter { it.priceListId == null || it.priceListId == effectiveListId }
            .filter { it.outletIds==null||customer.outletId in it.outletIds }
            .sortedWith(if(protocol)compareBy<Promotion>{it.precedence}.thenBy{it.code} else compareBy{promotions.indexOf(it)})
            .forEach { promotion ->
                when (val rule = promotion.rule) {
                    is PromotionRule.BuyXGetY -> {
                        val buyLine = byProduct[rule.buy.productId] ?: return@forEach
                        val buyProduct = products[rule.buy.productId] ?: return@forEach
                        val freeProduct = products[rule.free.productId]
                        if (rule.buy.uomCode != buyProduct.uomCode) {
                            issues += CheckoutIssue(CheckoutProblem.PROMOTION_NEEDS_OFFICE,rule.buy.productId); return@forEach
                        }
                        if (freeProduct == null) {
                            issues += CheckoutIssue(CheckoutProblem.PROMOTION_NEEDS_OFFICE,rule.free.productId); return@forEach
                        }
                        if (rule.free.uomCode != freeProduct.uomCode) {
                            issues += CheckoutIssue(CheckoutProblem.PROMOTION_NEEDS_OFFICE,rule.free.productId); return@forEach
                        }
                        val setBase = baseUnits(rule.buy,buyProduct) ?: run {
                            issues += CheckoutIssue(CheckoutProblem.PROMOTION_NEEDS_OFFICE,rule.buy.productId); return@forEach
                        }
                        val sets = buyLine.paidBase / setBase
                        if (sets <= 0L) return@forEach
                        val freePerSet = baseUnits(rule.free,freeProduct) ?: run {
                            issues += CheckoutIssue(CheckoutProblem.PROMOTION_NEEDS_OFFICE,rule.free.productId); return@forEach
                        }
                        val freeBase = safeMultiply(sets,freePerSet) ?: run {
                            issues += CheckoutIssue(CheckoutProblem.PROMOTION_NEEDS_OFFICE,rule.free.productId); return@forEach
                        }
                        applicable += Applicable(promotion,setOf(rule.buy.productId,rule.free.productId),Action.Gift(rule.free.productId,freeBase))
                    }
                    is PromotionRule.PercentOff -> {
                        val line = byProduct[rule.item.productId] ?: return@forEach
                        val product = products[rule.item.productId] ?: return@forEach
                        if (rule.item.uomCode != product.uomCode) {
                            issues += CheckoutIssue(CheckoutProblem.PROMOTION_NEEDS_OFFICE,rule.item.productId); return@forEach
                        }
                        val threshold = baseUnits(rule.item,product) ?: run {
                            issues += CheckoutIssue(CheckoutProblem.PROMOTION_NEEDS_OFFICE,rule.item.productId); return@forEach
                        }
                        if (line.paidBase < threshold) return@forEach
                        applicable += Applicable(promotion,setOf(rule.item.productId),Action.Percent(rule.percentOffBasisPoints))
                    }
                    is PromotionRule.Bundle -> {
                        if (rule.components.any { it.productId !in byProduct }) return@forEach
                        val componentProducts = rule.components.mapNotNull { products[it.productId] }
                        if (componentProducts.size != rule.components.size) return@forEach
                        if (rule.components.any { unit -> unit.uomCode != products.getValue(unit.productId).uomCode }) {
                            val bad = rule.components.first { it.uomCode != products.getValue(it.productId).uomCode }
                            issues += CheckoutIssue(CheckoutProblem.PROMOTION_NEEDS_OFFICE,bad.productId); return@forEach
                        }
                        val componentBases = rule.components.mapNotNull { unit -> baseUnits(unit,products.getValue(unit.productId))?.let { unit.productId to it } }.toMap()
                        if (componentBases.size != rule.components.size) {
                            val bad = rule.components.first { it.productId !in componentBases }
                            issues += CheckoutIssue(CheckoutProblem.PROMOTION_NEEDS_OFFICE,bad.productId); return@forEach
                        }
                        val sets = rule.components.minOf { unit ->
                            val product = products.getValue(unit.productId)
                            byProduct.getValue(unit.productId).paidBase / componentBases.getValue(unit.productId)
                        }
                        if (sets <= 0L) return@forEach
                        if (rule.components.any { byProduct.getValue(it.productId).price == null }) {
                            val bad = rule.components.first { byProduct.getValue(it.productId).price == null }
                            issues += CheckoutIssue(CheckoutProblem.PROMOTION_NEEDS_OFFICE,bad.productId); return@forEach
                        }
                        val normal = normalBundlePrice(rule.components,byProduct)
                        if (normal == null) {
                            val bad = rule.components.first()
                            issues += CheckoutIssue(CheckoutProblem.PROMOTION_NEEDS_OFFICE,bad.productId); return@forEach
                        }
                        val discount = safeMultiply(sets,maxOf(0L,normal - rule.bundlePriceMinor))
                        if (discount == null) {
                            issues += CheckoutIssue(CheckoutProblem.PROMOTION_NEEDS_OFFICE,rule.components.first().productId); return@forEach
                        }
                        applicable += Applicable(promotion,rule.components.map { it.productId }.toSet(),Action.Bundle(rule.components,discount))
                    }
                }
            }
        val touches = applicable.flatMap { item -> item.touched.map { it to item.promotion } }.groupBy({ it.first },{ it.second })
        if(!protocol)touches.filterValues { promotionsForProduct -> promotionsForProduct.map { it.promotionId }.distinct().size > 1 }
            .keys.forEach { issues += CheckoutIssue(CheckoutProblem.PROMOTION_CONFLICT,it) }
        if (issues.isNotEmpty()) return PromotionResult(lines,issues.distinct())
        var exclusive=false;val groups=mutableSetOf<String>();val blocked=mutableSetOf<String>();val applied=mutableSetOf<String>()
        applicable.forEach { item ->
            val p=item.promotion
            if(protocol&&(exclusive||p.code in blocked||p.exclusionGroup?.let{it in groups}==true||p.excludes.any{it in applied}||p.stacking=="exclusive"&&applied.isNotEmpty()))return@forEach
            val quoted = item.promotion.quoted()
            when (val action = item.action) {
                is Action.Gift -> {
                    val line = byProduct[action.productId] ?: run {
                        val product = products.getValue(action.productId)
                        PromotionLine(lines.size + 1,product,0L,0L,
                            PriceResolver.resolve(product,prices,now,customer),0L,null).also {
                                lines += it; byProduct[action.productId] = it
                            }
                    }
                    line.freeBase = Math.addExact(line.freeBase,action.freeBase)
                    line.promotion = quoted
                }
                is Action.Percent -> {
                    val line = byProduct.getValue(item.primaryProductId())
                    val discount=percentDiscount(if(protocol)line.grossMinor-line.discountMinor else line.grossMinor,action.basisPoints,protocol)
                    if(protocol&&discount==0L)return@forEach
                    line.discountMinor = if(protocol)Math.addExact(line.discountMinor,discount) else maxOf(line.discountMinor,discount)
                    line.promotion = quoted
                }
                is Action.Bundle -> {
                    if(protocol){
                        val rows=action.components.map{byProduct.getValue(it.productId)}
                        val balances=rows.map{maxOf(0L,it.grossMinor-it.discountMinor)};val sum=balances.fold(0L,Math::addExact)
                        val discount=minOf(action.discountMinor,sum);if(discount==0L)return@forEach
                        val allocated=balances.map{BigInteger.valueOf(discount).multiply(BigInteger.valueOf(it)).divide(BigInteger.valueOf(sum)).toLong()}.toMutableList()
                        var residue=discount-allocated.fold(0L,Math::addExact)
                        allocated.indices.forEach{i->if(residue>0&&allocated[i]<balances[i]){allocated[i]++;residue--}}
                        rows.forEachIndexed{i,line->line.discountMinor=Math.addExact(line.discountMinor,allocated[i]);line.promotion=quoted}
                    }else{
                        var remaining = action.discountMinor
                        action.components.forEach { unit ->
                            val line = byProduct.getValue(unit.productId)
                            val available = maxOf(0L,line.grossMinor - line.discountMinor)
                            val allocated = minOf(remaining,available)
                            line.discountMinor = Math.addExact(line.discountMinor,allocated)
                            line.promotion = quoted
                            remaining -= allocated
                        }
                    }
                }
            }
            if(protocol){applied+=p.code;p.exclusionGroup?.let{groups+=it};blocked+=p.excludes;exclusive=p.stacking=="exclusive"}
        }
        return PromotionResult(lines,emptyList())
    }

    private fun effectiveListId(customer: Customer, lines: List<PromotionLine>): String? = when (customer.priceListMode) {
        CustomerPriceListMode.GOVERNED -> customer.priceListId
        CustomerPriceListMode.LEGACY -> lines.mapNotNull { it.price?.priceListId }.distinct().singleOrNull()
        CustomerPriceListMode.NONE -> null
    }

    private fun percentDiscount(gross: Long, basisPoints: Int,halfUp:Boolean=false): Long =
        BigInteger.valueOf(gross).multiply(BigInteger.valueOf(basisPoints.toLong())).add(if(halfUp)BigInteger.valueOf(5000L) else BigInteger.ZERO)
            .divide(BigInteger.valueOf(10_000L)).coerceAtMostLong()

    private fun baseUnits(unit: PromotionUnit, product: Product): Long? = safeMultiply(unit.quantity.toLong(),product.quantityScale)

    private fun safeMultiply(left: Long,right: Long): Long? {
        if (left < 0L || right < 0L) return null
        val value = BigInteger.valueOf(left).multiply(BigInteger.valueOf(right))
        return if (value.bitLength() > 63) null else value.toLong()
    }

    private fun normalBundlePrice(components: List<PromotionUnit>, lines: Map<String, PromotionLine>): Long? {
        var total = 0L
        components.forEach { unit ->
            val product = lines.getValue(unit.productId).product
            val units = baseUnits(unit,product) ?: return null
            val price = lines.getValue(unit.productId).price ?: return null
            val line = CheckoutRules.lineTotal(price.unitPriceMinor,units,product.quantityScale) ?: return null
            total = safeAdd(total,line) ?: return null
        }
        return total
    }

    private fun safeAdd(left: Long,right: Long): Long? = BigInteger.valueOf(left).add(BigInteger.valueOf(right)).let { if (it.bitLength() > 63) null else it.toLong() }

    private fun Promotion.quoted() = QuotedPromotion(promotionId,code,name,kind)
    private fun Applicable.primaryProductId() = touched.first()

    private data class Applicable(val promotion: Promotion, val touched: Set<String>, val action: Action)
    private sealed class Action {
        data class Gift(val productId: String,val freeBase: Long) : Action()
        data class Percent(val basisPoints: Int) : Action()
        data class Bundle(val components: List<PromotionUnit>,val discountMinor: Long) : Action()
    }

    private fun BigInteger.coerceAtMostLong(): Long = if (bitLength() > 63) Long.MAX_VALUE else toLong()
}