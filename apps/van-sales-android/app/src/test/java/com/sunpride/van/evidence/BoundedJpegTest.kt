package com.sunpride.van.evidence

import java.io.ByteArrayOutputStream
import org.junit.Assert.*
import org.junit.Test

class BoundedJpegTest {
    // Android's compile classpath omits java.desktop. Reflection keeps the real JVM JPEG encoder
    // test-only, without adding an imaging dependency to the POS or using android.jar bitmap stubs.
    private val imageClass = Class.forName("java.awt.image.BufferedImage")
    private val imageIO = Class.forName("javax.imageio.ImageIO")
    private fun image(w: Int, h: Int): Any = imageClass.getConstructor(Int::class.javaPrimitiveType,Int::class.javaPrimitiveType,Int::class.javaPrimitiveType).newInstance(w,h,1)
    private fun jpeg(original: Any, w: Int, h: Int, quality: Int): ByteArray {
        val scaled = image(w,h)
        val graphics = imageClass.getMethod("createGraphics").invoke(scaled)
        val graphicsClass = Class.forName("java.awt.Graphics")
        graphicsClass.getMethod("drawImage",Class.forName("java.awt.Image"),Int::class.javaPrimitiveType,Int::class.javaPrimitiveType,Int::class.javaPrimitiveType,Int::class.javaPrimitiveType,Class.forName("java.awt.image.ImageObserver")).invoke(graphics,original,0,0,w,h,null)
        graphicsClass.getMethod("dispose").invoke(graphics)
        val writer = (imageIO.getMethod("getImageWritersByFormatName",String::class.java).invoke(null,"jpeg") as Iterator<*>).next()!!
        val writerClass = Class.forName("javax.imageio.ImageWriter")
        val params = writerClass.getMethod("getDefaultWriteParam").invoke(writer)
        val paramsClass = Class.forName("javax.imageio.ImageWriteParam")
        paramsClass.getMethod("setCompressionMode",Int::class.javaPrimitiveType).invoke(params,2)
        paramsClass.getMethod("setCompressionQuality",Float::class.javaPrimitiveType).invoke(params,quality / 100f)
        val output = ByteArrayOutputStream()
        val stream = imageIO.getMethod("createImageOutputStream",Any::class.java).invoke(null,output)
        try {
            writerClass.getMethod("setOutput",Any::class.java).invoke(writer,stream)
            val iioClass = Class.forName("javax.imageio.IIOImage")
            val iio = iioClass.getConstructor(Class.forName("java.awt.image.RenderedImage"),List::class.java,Class.forName("javax.imageio.metadata.IIOMetadata")).newInstance(scaled,null,null)
            writerClass.getMethod("write",Class.forName("javax.imageio.metadata.IIOMetadata"),iioClass,paramsClass).invoke(writer,null,iio,params)
        } finally { (stream as java.io.Closeable).close(); writerClass.getMethod("dispose").invoke(writer) }
        return output.toByteArray()
    }
    @Test fun realNoisyImageFitsEveryPolicyCapAndStartsAt1024() {
        val original = image(2048,1536)
        val random = java.util.Random(20)
        val pixels = IntArray(2048*1536) { random.nextInt() }
        imageClass.getMethod("setRGB",Int::class.javaPrimitiveType,Int::class.javaPrimitiveType,Int::class.javaPrimitiveType,Int::class.javaPrimitiveType,IntArray::class.java,Int::class.javaPrimitiveType,Int::class.javaPrimitiveType).invoke(original,0,0,2048,1536,pixels,0,2048)
        for (cap in listOf(96_000,90_000,1024)) {
            val attempts = mutableListOf<Triple<Int,Int,Int>>()
            val encoded = BoundedJpeg.encode(2048,1536,cap) { w,h,q -> attempts += Triple(w,h,q); jpeg(original,w,h,q) }
            assertTrue(encoded.size <= cap); assertTrue(DamagePhotoFiles.isJpeg(encoded))
            val decoded = imageIO.getMethod("read",java.io.InputStream::class.java).invoke(null,encoded.inputStream())
            assertTrue(maxOf(imageClass.getMethod("getWidth").invoke(decoded) as Int,imageClass.getMethod("getHeight").invoke(decoded) as Int) <= 1024)
            assertEquals(Triple(1024,768,85),attempts.first())
            assertTrue("noise must trigger quality reduction or resize",attempts.size > 1)
            if (cap == 1024) assertTrue(attempts.any { it.first < 1024 })
        }
    }
    @Test fun encoderThatCannotFitRefusesRatherThanReturningOversizedBytes() {
        assertThrows(IllegalStateException::class.java) { BoundedJpeg.encode(1,1,1024) { _,_,_ -> ByteArray(1025) } }
    }
}
