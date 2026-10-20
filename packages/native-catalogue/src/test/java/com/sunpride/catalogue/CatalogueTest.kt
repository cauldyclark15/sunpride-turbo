package com.sunpride.catalogue

import com.google.zxing.BarcodeFormat
import com.google.zxing.MultiFormatWriter
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.Executors

class CatalogueTest {
    private fun hash(bytes:ByteArray)=MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it.toInt() and 255)}
    private fun directory()=File(System.getenv("TMPDIR")?:System.getProperty("java.io.tmpdir"),"catalogue-f616-${UUID.randomUUID()}").apply{mkdirs()}
    @Test fun f616OfflineSearchPreservesBarcodeLeadingZeroesAndDoesNotChooseDuplicateMatches(){
        val first=CatalogueEntry("one","SKU-01","Sample piñata product",listOf("0000123456"),null)
        val second=CatalogueEntry("two","SKU-02","Another product",listOf("0000123456"),null)
        assertEquals(listOf(first),CatalogueSearch.search(listOf(first,second),"pinata"))
        assertEquals(listOf(second),CatalogueSearch.search(listOf(first,second),"sku-02"))
        assertEquals(2,CatalogueSearch.scan(listOf(first,second),"0000123456").size)
        assertTrue(CatalogueSearch.scan(listOf(first),"123456").isEmpty())
    }
    @Test fun f616ActualOfflineDecoderFindsGoldenEanImageAndReturnsExactProduct(){
        val code="4006381333931"
        val matrix=MultiFormatWriter().encode(code,BarcodeFormat.EAN_13,600,180)
        val y=ByteArray(matrix.width*matrix.height){i->if(matrix[i%matrix.width,i/matrix.width])0 else 255.toByte()}
        val decoded=CameraBarcodeDecoder().decode(y,matrix.width,matrix.height)
        assertEquals(code,decoded)
        val entry=CatalogueEntry("one","SAMPLE-EAN","Sample product",listOf(code),null)
        assertEquals(entry,CatalogueSearch.scan(listOf(entry),decoded!!).single())
    }
    @Test fun f616CatalogueMetadataRoundTripsWithoutPriceStockOrFoodClaimInference(){
        val detail=CatalogueDetails(2,UUID.randomUUID().toString(),"sample",true,"SAMPLE description","SAMPLE ingredients","SAMPLE allergens","SAMPLE storage",180,"SAMPLE case dimensions",
            listOf(CataloguePack("PC","Piece",1,1,"PC"),CataloguePack("CASE","Case",24000,1000,"PC")),
            CatalogueImage("/api/v1/masters/catalogue-images/${UUID.randomUUID()}","a".repeat(64),12))
        assertEquals(detail,CatalogueDetails.decode(detail.json()))
        assertEquals("Case · 24 PC",detail.packs[1].explanation())
        assertFalse(detail.json().has("unitPriceMinor"));assertFalse(detail.json().has("availableBase"))
        assertThrows(IllegalArgumentException::class.java){CatalogueDetails.decode(detail.json().put("sample",false))}
    }
    @Test fun f616ImageCacheIsByteCountAndFileCountBoundedAcrossConcurrentInstances(){
        val root=directory()
        try{
            val pool=Executors.newFixedThreadPool(4)
            try{ val tasks=(0 until 40).map{n->pool.submit { val bytes=ByteArray(256){(it+n).toByte()};CatalogueImageCache(root,maxBytes=512,maxFiles=3).put(hash(bytes),bytes) }};tasks.forEach{it.get()} }finally{pool.shutdown()}
            val images=root.listFiles().orEmpty().filter{it.extension=="jpg"}
            assertTrue(images.size<=3);assertTrue(images.sumOf{it.length()}<=512)
            assertTrue(root.listFiles().orEmpty().none{it.extension=="tmp"})
            val bytes=byteArrayOf(1,2,3);val sha=hash(bytes)
            val cache=CatalogueImageCache(root,maxBytes=512,maxFiles=3)
            val file=cache.put(sha,bytes);assertNotNull(cache.get(sha));file.writeBytes(byteArrayOf(9));assertNull(cache.get(sha))
            assertThrows(IllegalArgumentException::class.java){cache.get("../../private")}
            assertThrows(IllegalArgumentException::class.java){cache.put(sha,ByteArray(513))}
        }finally{root.deleteRecursively()}
    }
}
