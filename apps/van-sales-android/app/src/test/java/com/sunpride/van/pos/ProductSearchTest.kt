package com.sunpride.van.pos

import com.sunpride.van.data.PriceLine
import com.sunpride.van.data.Product
import com.sunpride.van.data.TruckStock
import com.sunpride.van.sync.VanBootstrapCodec
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ProductSearchTest {
    private val juice = Product("p1","SP-PJ-1L","Pineapple Juice 1L","PC",1,listOf("4800000000017"))
    private val chunks = Product("p2","SP-PC-432","Pineapple Chunks 432g","PC",1,emptyList())
    private val tidbits = Product("p3","SP-TB-227","Piña Tidbits 227g","CS",24,listOf("4800000000024"))
    private val crushed = Product("p4","SP-CR-JUICE","Crushed Pineapple","PC",1,emptyList())
    private val products = listOf(juice,chunks,tidbits,crushed)
    private val stock = listOf(TruckStock("p1",12,1),TruckStock("p3",36,0),TruckStock("p4",0,0))
    private val now = 1_791_338_400_000L
    private fun search(prices: List<PriceLine> = emptyList()) = ProductSearch(products,stock,prices,now)
    private fun price(product: String, minor: Long, uom: String = "PC", from: Long = now-1, to: Long? = null, list: String = "L1", currency: String = "PHP") =
        PriceLine(list,product,uom,minor,currency,from,to)

    @Test fun exactBarcodeWinsAndScanLookupIsExact() {
        val hits = search().search("4800000000017")
        assertEquals("p1",hits.first().product.productId)
        assertEquals(MatchKind.BARCODE,hits.first().match)
        assertEquals("p3",search().byBarcode("4800000000024")?.product?.productId)
        assertNull(search().byBarcode("480000000002"))
        assertNull("barcodes are not trimmed or normalized",search().byBarcode(" 4800000000017"))
    }
    @Test fun codeMatchesExactPrefixAndWithoutPunctuation() {
        assertEquals(MatchKind.CODE,search().search("sp-pj-1l").single().match)
        assertEquals("p1",search().search("SPPJ1L").single().product.productId)
        val prefix = search().search("SP-P")
        assertEquals(listOf("p1","p2"),prefix.take(2).map { it.product.productId }.sorted())
        assertTrue(prefix.take(2).all { it.match == MatchKind.CODE_PREFIX })
        // Others still match by word ("sp" + "p…"), but rank below every code prefix.
        assertTrue(prefix.drop(2).all { it.match.ordinal > MatchKind.CODE_PREFIX.ordinal })
    }
    @Test fun barcodePrefixNeedsFourDigits() {
        assertEquals(setOf("p1","p3"),search().search("48000").map { it.product.productId }.toSet())
        assertTrue(search().search("480").none { it.match == MatchKind.BARCODE_PREFIX })
    }
    @Test fun nameSearchIsCaseAndAccentInsensitiveWithWordPrefixes() {
        assertEquals("p3",search().search("pina tid").single().product.productId)
        assertEquals("p3",search().search("PIÑA").single().product.productId)
        val words = search().search("pine ju")
        assertEquals(listOf("p1","p4"),words.map { it.product.productId })
        // Both match word prefixes; the juice on the truck ranks above the crushed pineapple with none.
        assertTrue(words.all { it.match == MatchKind.WORD_PREFIX })
        assertEquals(MatchKind.NAME_PREFIX,search().search("pineapple j").first().match)
        assertEquals(MatchKind.CONTAINS,search().search("apple").first().match)
        assertTrue(search().search("mango").isEmpty())
    }
    @Test fun inStockProductsRankFirstWithinTheSameMatch() {
        // "pineapple" prefixes juice and chunks; juice is on the truck, chunks are not.
        val hits = search().search("pineapple")
        assertEquals(listOf("p1","p2"),hits.take(2).map { it.product.productId })
        val all = search().search("")
        assertEquals(4,all.size)
        assertEquals(setOf("p1","p3"),all.take(2).map { it.product.productId }.toSet())
        assertFalse(all.single { it.product.productId == "p4" }.onTruck)
    }
    @Test fun availableQuantityUsesProductScaleAndUom() {
        val hit = search().search("tidbits").single()
        assertEquals(36,hit.availableBase)
        assertEquals("1.5 CS",hit.availableLabel())
        assertEquals("0 PC",search().search("chunks").single().availableLabel())
    }
    @Test fun resultsAreBounded() {
        val many = (1..500).map { Product("x$it","X-$it","Item $it","PC",1,emptyList()) }
        val index = ProductSearch(many,emptyList(),emptyList(),now)
        assertEquals(60,index.search("item").size)
        assertEquals(10,index.search("item",limit = 10).size)
    }
    @Test fun configuredPriceIsShownOnlyWhenOneEffectivePriceExists() {
        assertNull("no price list yet means priced by the office",search().search("juice").first { it.product.productId == "p1" }.price)
        val single = search(listOf(price("p1",4550))).search("sp-pj-1l").single().price
        assertEquals(PosPrice(4550,"PHP","PC"),single)
        assertEquals("₱45.50 / PC",single!!.label())
        // Same price on two lists is still one configured price.
        assertNotNull(search(listOf(price("p1",4550),price("p1",4550,list = "L2"))).search("sp-pj-1l").single().price)
        // Conflicting lists, wrong UOM, future and expired lines never produce a guessed price.
        assertNull(search(listOf(price("p1",4550),price("p1",4800,list = "L2"))).search("sp-pj-1l").single().price)
        assertNull(search(listOf(price("p1",4550,uom = "CS"))).search("sp-pj-1l").single().price)
        assertNull(search(listOf(price("p1",4550,from = now+1))).search("sp-pj-1l").single().price)
        assertNull(search(listOf(price("p1",4550,to = now))).search("sp-pj-1l").single().price)
        assertNull(search(listOf(price("p1",-1))).search("sp-pj-1l").single().price)
        // An expired line beside a current one resolves to the current one.
        assertEquals(4800L,search(listOf(price("p1",4550,from = now-10,to = now-5),price("p1",4800,list = "L2"))).search("sp-pj-1l").single().price?.unitPriceMinor)
    }
    @Test fun decodedBootstrapPricesAppearInProductSearchWithoutApplyingPromotions() {
        val text = javaClass.classLoader!!.getResourceAsStream("bootstrap-response.json")!!.bufferedReader().use { it.readText() }
        val b = VanBootstrapCodec.decode(text)
        val search = ProductSearch(b.products,b.truckStock,b.priceLines,b.serverTime)
        val juiceHit = search.search("SP-PJ-1L").single()
        assertEquals(PosPrice(6850,"PHP","PC"),juiceHit.price)
        assertEquals("₱68.50 / PC",juiceHit.price?.label())
        assertEquals("₱42.75 / PC",search.search("SP-PC-432").single().price?.label())
        assertEquals(juiceHit.price,PriceResolver.resolve(juiceHit.product,b.priceLines,b.serverTime))
        val withoutPrices = VanBootstrapCodec.decode(JSONObject(text).apply { remove("priceLines") }.toString())
        assertNull(ProductSearch(withoutPrices.products,withoutPrices.truckStock,withoutPrices.priceLines,withoutPrices.serverTime)
            .search("SP-PJ-1L").single().price)
    }
    @Test fun customerPriceListsSelectTheirListNoneMeansNoPriceAndLegacyKeepsAnyList() {
        val lines = listOf(price("p1",4_550,list = "L1"),price("p1",5_000,list = "L2"))
        val customer = com.sunpride.van.data.Customer("o1","O1","Store",null,1,"route",priceListId = "L2")
        assertEquals(5_000L,PriceResolver.resolve(juice,lines,now,customer)?.unitPriceMinor)
        assertNull(PriceResolver.resolve(juice,lines,now,customer.copy(priceListId = null,priceListMode = com.sunpride.van.data.CustomerPriceListMode.NONE)))
        assertNull("legacy conflicting lists remain ambiguous",PriceResolver.resolve(juice,lines,now,customer.copy(priceListId = null,priceListMode = com.sunpride.van.data.CustomerPriceListMode.LEGACY)))
        assertEquals(5_000L,PriceResolver.resolve(juice,listOf(price("p1",5_000,list = "L1"),price("p1",5_000,list = "L2")),now,
            customer.copy(priceListId = null,priceListMode = com.sunpride.van.data.CustomerPriceListMode.LEGACY))?.unitPriceMinor)
    }
    @Test fun moneyFormatting() {
        assertEquals("₱1,234.50",PosMoney.format(123450,"PHP"))
        assertEquals("₱0.05",PosMoney.format(5,"PHP"))
        assertEquals("USD 2.00",PosMoney.format(200,"USD"))
        assertEquals("JPY 1,200",PosMoney.format(1200,"JPY"))
    }
}
