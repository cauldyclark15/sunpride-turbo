package com.sunpride.catalogue

import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.ByteArrayOutputStream

/** F-616 authenticated same-origin GET only; redirects cannot forward a bearer to
 * another host. Content length and SHA are checked before a cache write. No body,
 * token, URL, server error or cookie is persisted in diagnostics. */
class CatalogueHttp(client: OkHttpClient) {
    private val http=client.newBuilder().followRedirects(false).followSslRedirects(false).build()
    fun fetch(origin:String,image:CatalogueImage,token:(Boolean)->String,invalidate:()->Unit):ByteArray? {
        require(Regex("/api/v1/masters/catalogue-images/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}").matches(image.path))
        require(image.bytes in 1..524288)
        return runCatching {
            for(attempt in 0..1){
                val request=Request.Builder().url(origin.trimEnd('/')+image.path).header("Authorization","Bearer ${token(attempt>0)}").get().build()
                http.newCall(request).execute().use{response->
                    if(response.code==401){invalidate();if(attempt==0)return@use}
                    if(!response.isSuccessful||response.header("Content-Type")?.substringBefore(';')!="image/jpeg")return null
                    val body=response.body?:return null
                    if(body.contentLength()>image.bytes)return null
                    val bytes=body.byteStream().use{input->
                        val out=ByteArrayOutputStream(image.bytes)
                        val buffer=ByteArray(8192)
                        while(out.size()<=image.bytes){val read=input.read(buffer,0,minOf(buffer.size,image.bytes+1-out.size()));if(read<0)break;out.write(buffer,0,read)}
                        out.toByteArray()
                    }
                    if(bytes.size!=image.bytes)return null
                    val sha=java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it.toInt() and 255)}
                    return bytes.takeIf{sha==image.sha256}
                }
            }
            null
        }.getOrNull()
    }
}
