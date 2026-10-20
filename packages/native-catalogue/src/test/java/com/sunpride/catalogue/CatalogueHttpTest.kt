package com.sunpride.catalogue

import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.Assert.*
import org.junit.Test
import java.security.MessageDigest

class CatalogueHttpTest {
    private val path="/api/v1/masters/catalogue-images/11111111-1111-4111-8111-111111111111"
    private fun descriptor(bytes:ByteArray)=CatalogueImage(path,MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it.toInt() and 255)},bytes.size)
    @Test fun f616ImageDownloadRefreshesOnceAndKeepsExactBoundedBytes(){
        val server=MockWebServer();server.start()
        try{
            val bytes=byteArrayOf(1,2,3,4);val image=descriptor(bytes)
            server.enqueue(MockResponse().setResponseCode(401))
            server.enqueue(MockResponse().setHeader("Content-Type","image/jpeg").setBody(Buffer().write(bytes)))
            var invalidated=0;val forces=mutableListOf<Boolean>()
            val result=CatalogueHttp(OkHttpClient()).fetch(server.url("/").toString(),image,{force->forces+=force;if(force)"fixture-renewed" else "fixture-first"},{invalidated++})
            assertArrayEquals(bytes,result);assertEquals(listOf(false,true),forces);assertEquals(1,invalidated)
            assertEquals(path,server.takeRequest().path);assertEquals("Bearer fixture-renewed",server.takeRequest().getHeader("Authorization"))
        }finally{server.shutdown()}
    }
    @Test fun f616RedirectsWrongHashesAndOversizedResponsesNeverBecomeAnImage(){
        val server=MockWebServer();server.start()
        try{
            val bytes=byteArrayOf(1,2,3,4);val image=descriptor(bytes)
            val http=CatalogueHttp(OkHttpClient())
            server.enqueue(MockResponse().setResponseCode(302).setHeader("Location",server.url("/outside")))
            assertNull(http.fetch(server.url("/").toString(),image,{"fixture"},{}));assertEquals(1,server.requestCount)
            server.enqueue(MockResponse().setHeader("Content-Type","image/jpeg").setBody(Buffer().write(byteArrayOf(4,3,2,1))))
            assertNull(http.fetch(server.url("/").toString(),image,{"fixture"},{}))
            server.enqueue(MockResponse().setHeader("Content-Type","image/jpeg").setBody(Buffer().write(ByteArray(5))))
            assertNull(http.fetch(server.url("/").toString(),image,{"fixture"},{}))
            assertThrows(IllegalArgumentException::class.java){http.fetch(server.url("/").toString(),image.copy(path="https://example.invalid/photo.jpg"),{"fixture"},{})}
        }finally{server.shutdown()}
    }
}
