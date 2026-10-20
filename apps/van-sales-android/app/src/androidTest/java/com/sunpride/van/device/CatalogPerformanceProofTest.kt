package com.sunpride.van.device

import android.os.SystemClock
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.van.data.PriceLine
import com.sunpride.van.data.Product
import com.sunpride.van.data.TruckStock
import com.sunpride.van.pos.ProductSearch
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/** Opt-in cost probe. Run the SAME test APK against before/after signed release app APKs.
 * All catalog data is invented IN MEMORY, never written to a business cache or server.
 * This measures the actual production index, not UI scrolling or signed-in startup. */
class CatalogPerformanceProofTest {
    @Test fun fullSupportedCatalogIndexAndSearchCost() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("v2Proof") == "performance")
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        assertFalse("Release build required",com.sunpride.van.BuildConfig.DEBUG)
        val now=System.currentTimeMillis()
        val products=(1..500).map { Product("perf-$it","PERF-$it","Sample product $it","PC",1,listOf("480${it.toString().padStart(10,'0')}")) }
        val stock=products.map { TruckStock(it.productId,100,0) }
        val prices=products.flatMap { p -> (1..20).map { PriceLine("list-$it",p.productId,"PC",10025,"PHP",now-1000,null) } }
        val build=mutableListOf<Long>(); val search=mutableListOf<Long>()
        repeat(35) { sample ->
            val begin=SystemClock.elapsedRealtimeNanos()
            val index=ProductSearch(products,stock,prices,now)
            val indexed=SystemClock.elapsedRealtimeNanos()
            val result=index.search("Sample product 499")
            val searched=SystemClock.elapsedRealtimeNanos()
            assertTrue(result.any { it.product.productId=="perf-499" })
            if (sample>=5) { build+=(indexed-begin); search+=(searched-indexed) }
        }
        val result=JSONObject().put("catalogProducts",products.size).put("priceLines",prices.size)
            .put("indexNanoseconds",JSONArray(build)).put("searchNanoseconds",JSONArray(search))
            .put("release",true).put("pssKb",android.os.Debug.getPss())
        File(context.getExternalFilesDir(null),"v2-catalog-performance.json").writeText(result.toString())
        assertEquals(30,build.size)
    }
}
