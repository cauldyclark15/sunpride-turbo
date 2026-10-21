package com.sunpride.integrity

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.content.FileProvider
import okhttp3.CookieJar
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

import java.util.concurrent.TimeUnit

/** F-006: TLS + immutable server hash + installed signer + Android's own installer. No silent installs. */
class AppUpdateClient(private val context:Context,private val origin:String,private val token:(Boolean)->String,
 private val http:OkHttpClient=OkHttpClient.Builder().cookieJar(CookieJar.NO_COOKIES).followRedirects(false).followSslRedirects(false).callTimeout(120,TimeUnit.SECONDS).build()) {
 companion object {private val downloadLock=Any();const val MAX_BYTES=120L*1024*1024}
 private val packageName=context.packageName
 init {val url=java.net.URI(origin);require(url.rawUserInfo==null && (url.scheme=="https" || url.scheme=="http" && url.host in setOf("localhost","127.0.0.1")))}
 @Suppress("DEPRECATION") private fun installed()=context.packageManager.getPackageInfo(packageName,PackageManager.GET_SIGNING_CERTIFICATES)
 private fun hex(bytes:ByteArray)=bytes.joinToString("") {"%02x".format(it.toInt() and 255)}
 private fun hash(bytes:ByteArray)=hex(MessageDigest.getInstance("SHA-256").digest(bytes))
 private fun request(path:String,refresh:Boolean)=Request.Builder().url(origin.trimEnd('/')+path).header("Authorization","Bearer ${token(refresh)}").header("Accept-Encoding","identity").build()
 fun latest():JSONObject? {
  val current=installed().longVersionCode
  for(attempt in 0..1) http.newCall(request("/api/v1/app-releases/latest?packageName=$packageName&versionCode=$current",attempt>0)).execute().use {response->
   if(response.code==401 && attempt==0)return@use
   check(response.isSuccessful){"Could not check app updates"}
   val source=checkNotNull(response.body).source();source.request(64_001);require(source.buffer.size<=64_000)
   val r=JSONObject(source.readUtf8()).optJSONObject("release") ?: return null
   AppUpdateRules.release(r,packageName,current,checkNotNull(installed().signingInfo).apkContentsSigners.map {hash(it.toByteArray())}.toSet())
   return r
  }
  error("Sign in again to check app updates")
 }
 @Suppress("DEPRECATION") fun download(r:JSONObject,isCurrent:()->Boolean):File = synchronized(downloadLock) {
  check(isCurrent()){"Sign-in changed"}
  val dir=File(context.cacheDir,"updates").also {check(it.mkdirs() || it.isDirectory)}
  dir.listFiles()?.forEach {if(it.isFile)it.delete()}
  val file=File(dir,"${r.getString("sha256")}.apk")
  try {
   var downloaded=false
   for(attempt in 0..1) {
    check(isCurrent()){"Sign-in changed"}
    http.newCall(request("/api/v1/app-releases/${r.getString("id")}/apk",attempt>0)).execute().use {response->
     if(response.code==401 && attempt==0)return@use
     check(response.isSuccessful){"The office withdrew this update or the download was refused"}
     val body=checkNotNull(response.body)
     require(body.contentLength()==r.getLong("sizeBytes") && body.contentLength() in 1..MAX_BYTES)
     var size=0L;val digest=MessageDigest.getInstance("SHA-256")
     body.byteStream().use {input->file.outputStream().use {out->
      val buffer=ByteArray(32768)
      while(true){val n=input.read(buffer);if(n<0)break;check(isCurrent());size+=n;require(size<=r.getLong("sizeBytes") && size<=MAX_BYTES);digest.update(buffer,0,n);out.write(buffer,0,n)}
     }}
     require(size==r.getLong("sizeBytes") && hex(digest.digest())==r.getString("sha256")) {"Downloaded APK does not match the published release"}
     downloaded=true
    }
    if(downloaded)break
   }
   check(downloaded && isCurrent())
   validateArchive(file,r)
   file
  }catch(e:Exception){file.delete();throw e}
 }
 @Suppress("DEPRECATION") fun validateArchive(file:File,r:JSONObject) {
  require(file.parentFile?.canonicalFile==File(context.cacheDir,"updates").canonicalFile && file.isFile)
  val digest=MessageDigest.getInstance("SHA-256")
  file.inputStream().use {input->val buffer=ByteArray(32768);while(true){val n=input.read(buffer);if(n<0)break;digest.update(buffer,0,n)}}
  require(hex(digest.digest())==r.getString("sha256"))
  val current=installed()
  val apk=context.packageManager.getPackageArchiveInfo(file.path,PackageManager.GET_SIGNING_CERTIFICATES) ?: error("Invalid APK")

  val expected=checkNotNull(current.signingInfo).apkContentsSigners.map {hash(it.toByteArray())}.toSet()
  val actual=checkNotNull(apk.signingInfo).apkContentsSigners.map {hash(it.toByteArray())}.toSet()
  AppUpdateRules.archive(r,packageName,current.longVersionCode,expected,apk.packageName,apk.longVersionCode,actual)
 }
 fun install(file:File,r:JSONObject,isCurrent:()->Boolean) {
  check(isCurrent())
  check(latest()?.getString("id")==r.getString("id")) {"The office changed or withdrew this update"}
  validateArchive(file,r)
  check(isCurrent())
  if(!context.packageManager.canRequestPackageInstalls()) {
   context.startActivity(Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,android.net.Uri.parse("package:$packageName")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));return
  }
  val uri=FileProvider.getUriForFile(context,"$packageName.updates",file)
  context.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri,"application/vnd.android.package-archive")
   .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
 }
}
